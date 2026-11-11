import type {
  ChangeEvent, Collection, CollectionSchema, Database, DatabaseMeta, Disposable, Json, JsonObject, OpenOptions, SnapshotOptions,
  Transaction
} from '@tessera/types'
import type { LoadedDatabase, StorageBackend, StorageChange } from './backend'
import { Change, CollectionState, toIndexSpec } from './state'
import { CollectionContext, KitCollection } from './collection'
import { ioError, StorageError } from './errors'

/** Runs one async function at a time, in call order. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<R>(work: () => Promise<R>): Promise<R> {
    const result = this.tail.then(work, work)
    this.tail = result.catch(() => {})
    return result
  }
  idle() { return this.tail.then(() => {}) }
}

const RESERVED = '__tessera'

function checkName(name: unknown): string {
  if (typeof name !== 'string' || name === '' || name.length > 200 || /[\u0000-\u001f]/.test(name)) {
    throw new StorageError('INVALID_ARGUMENT', 'a collection name must be a non-empty string without control characters')
  }
  if (name.startsWith(RESERVED)) throw new StorageError('INVALID_ARGUMENT', `collection names starting with "${RESERVED}" are reserved`)
  return name
}

/** The changes of one commit, as the backend wants them and as listeners are told. */
class Batch {
  readonly storage: StorageChange[] = []
  readonly event: ChangeEvent = { changes: [], structure: [] }

  documents(collection: string, changes: Change[]) {
    for (const { before, after } of changes) {
      if (after) this.storage.push({ type: 'put', collection, doc: after })
      else this.storage.push({ type: 'delete', collection, id: before!.id })
      this.event.changes.push({ collection, id: (after ?? before)!.id, type: !before ? 'insert' : !after ? 'delete' : 'update' })
    }
  }
  get empty() { return this.storage.length === 0 }
}

export interface KitDatabaseOptions extends OpenOptions {
  name: string
  newId: () => string
  /** Called once the database has closed, so the engine can forget it. */
  onClosed?: () => void
}

/**
 * The Database for any backend: all querying, transactions, conflict detection and change events, over a
 * `StorageBackend` that only persists. Every committed batch is handed to the backend before it becomes
 * visible, so a failed write leaves the database as it was.
 */
export class KitDatabase implements Database {
  readonly name: string
  readonly readOnly: boolean
  private readonly states = new Map<string, CollectionState>()
  private readonly declared = new Set<string>()
  private readonly strict: boolean
  private readonly metaValues = new Map<string, Json>()
  private readonly listeners = new Set<(event: ChangeEvent) => void>()
  private readonly commitLock = new Mutex()
  private readonly txLock = new Mutex()
  /** Snapshots being written: `close()` waits for them, so a backend never closes under one. */
  private readonly snapshots = new Set<Promise<unknown>>()
  private closed = false

  private constructor(private readonly backend: StorageBackend, private readonly options: KitDatabaseOptions) {
    this.name = options.name
    this.readOnly = Boolean(options.readOnly)
    this.strict = options.schema !== undefined
  }

  static async open(backend: StorageBackend, options: KitDatabaseOptions): Promise<KitDatabase> {
    const db = new KitDatabase(backend, options)
    try {
      const loaded: LoadedDatabase = await backend.load()
      for (const { name, indexes, docs } of loaded.collections) db.states.set(name, CollectionState.from(indexes, docs))
      for (const [key, value] of Object.entries(loaded.meta)) db.metaValues.set(key, value)
      await db.applySchema(options.schema ?? [])
    } catch (err) {
      await backend.close().catch(() => {})
      throw ioError(`could not open database "${options.name}"`, err)
    }
    return db
  }

  private async applySchema(schema: CollectionSchema[]) {
    const batch = new Batch()
    for (const { name, indexes = [] } of schema) {
      checkName(name)
      this.declared.add(name)
      if (this.readOnly) continue
      const existing = this.states.get(name)
      const state = existing?.clone() ?? new CollectionState()
      for (const index of indexes) state.addIndex(toIndexSpec(index))
      if (!existing || state.indexes.size !== existing.indexes.size) {
        batch.storage.push({ type: 'collection', name, indexes: [...state.indexes.values()] })
        if (!existing) batch.event.structure.push({ collection: name, type: 'create' })
        state.version = (existing?.version ?? 0) + 1
        this.states.set(name, state)
      }
    }
    if (!batch.empty) await this.backend.commit(batch.storage)
  }

  // ---- guards

  private assertOpen() {
    if (this.closed) throw new StorageError('NOT_OPEN', `database "${this.name}" is closed`)
  }

  private writable() {
    this.assertOpen()
    if (this.readOnly) throw new StorageError('READ_ONLY', `database "${this.name}" is read-only`)
  }

  private known(name: string) {
    return this.states.has(name) || this.declared.has(name) || !this.strict
  }

  private visible(name: string): CollectionState | undefined {
    this.assertOpen()
    if (!this.known(name)) throw new StorageError('UNKNOWN_COLLECTION', `database "${this.name}" has no collection "${name}"`)
    return this.states.get(name)
  }

  // ---- collections

  collection<T extends object = JsonObject>(name: string): Collection<T> {
    return new KitCollection<T>(checkName(name), this.directContext())
  }

  async listCollections() {
    this.assertOpen()
    return [...new Set([...this.states.keys(), ...this.declared])].sort()
  }

  createCollection(schema: CollectionSchema) {
    return this.structural(async batch => {
      const name = checkName(schema.name)
      const existing = this.states.get(name)
      const state = existing?.clone() ?? new CollectionState()
      for (const index of schema.indexes ?? []) state.addIndex(toIndexSpec(index))
      if (existing && state.indexes.size === existing.indexes.size) return
      state.version = (existing?.version ?? 0) + 1
      batch.storage.push({ type: 'collection', name, indexes: [...state.indexes.values()] })
      if (!existing) batch.event.structure.push({ collection: name, type: 'create' })
      return () => this.states.set(name, state)
    })
  }

  dropCollection(name: string) {
    return this.structural(async batch => {
      checkName(name)
      if (!this.states.has(name)) return
      batch.storage.push({ type: 'drop', name })
      batch.event.structure.push({ collection: name, type: 'drop' })
      return () => { this.states.delete(name) }
    })
  }

  renameCollection(from: string, to: string) {
    return this.structural(async batch => {
      checkName(from); checkName(to)
      const state = this.states.get(from)
      if (!state) throw new StorageError('UNKNOWN_COLLECTION', `database "${this.name}" has no collection "${from}"`)
      if (this.states.has(to)) throw new StorageError('INVALID_ARGUMENT', `collection "${to}" already exists`)
      batch.storage.push({ type: 'rename', from, to })
      batch.event.structure.push({ collection: from, type: 'rename', renamedTo: to })
      return () => { this.states.delete(from); state.version++; this.states.set(to, state) }
    })
  }

  /** A direct (non-transactional) change that is not about documents: persisted first, then made visible. */
  private structural(prepare: (batch: Batch) => Promise<(() => void) | undefined>): Promise<void> {
    return this.commitLock.run(async () => {
      this.writable()
      const batch = new Batch()
      const apply = await prepare(batch)
      if (!apply) return
      await this.persist(batch)
      apply()
      this.emit(batch.event)
    })
  }

  private async persist(batch: Batch) {
    try {
      await this.backend.commit(batch.storage)
    } catch (err) {
      throw ioError(`could not write to database "${this.name}"`, err)
    }
  }

  private persistMeta(key: string, value: Json | undefined) {
    const batch = new Batch()
    batch.storage.push({ type: 'meta', key, value })
    return this.persist(batch)
  }

  private emit(event: ChangeEvent) {
    if (event.changes.length === 0 && event.structure.length === 0) return
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch (err) { console.error('[storage] a change listener threw', err) }
    }
  }

  // ---- direct reads and writes (outside a transaction)

  private directContext(): CollectionContext {
    return {
      read: name => this.visible(name),
      newId: this.options.newId,
      write: (name, compute) => this.commitLock.run(async () => {
        this.writable()
        const existing = this.visible(name)
        const state = existing ?? new CollectionState()
        const { result, changes } = compute(state)
        if (changes.length === 0) return result

        const batch = new Batch()
        if (!existing) {
          batch.storage.push({ type: 'collection', name, indexes: [] })
          batch.event.structure.push({ collection: name, type: 'create' })
        }
        batch.documents(name, changes)
        await this.persist(batch)
        state.apply(changes)
        state.version++
        this.states.set(name, state)
        this.emit(batch.event)
        return result
      }),
      changeIndexes: (name, change) => this.commitLock.run(async () => {
        this.writable()
        const existing = this.visible(name)
        const next = existing?.clone() ?? new CollectionState()
        change(next)
        next.version++
        const batch = new Batch()
        batch.storage.push({ type: 'collection', name, indexes: [...next.indexes.values()] })
        await this.persist(batch)
        this.states.set(name, next)
      })
    }
  }

  // ---- transactions

  transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R> {
    return this.txLock.run(async () => {
      this.writable()
      const tx = new KitTransaction(this)
      try {
        const result = await work(tx)
        await tx.commit()
        return result
      } finally {
        tx.finish()
      }
    })
  }

  /** @internal Used by KitTransaction. */
  commitTransaction(drafts: Map<string, Draft>): Promise<void> {
    return this.commitLock.run(async () => {
      this.writable()
      const batch = new Batch()
      for (const [name, draft] of drafts) {
        if (draft.changes.length === 0 && !draft.created) continue
        const current = this.states.get(name)
        if (draft.created ? current !== undefined : current?.version !== draft.baseVersion) {
          throw new StorageError('CONFLICT', `collection "${name}" was changed outside the transaction`)
        }
        if (draft.created) {
          batch.storage.push({ type: 'collection', name, indexes: [...draft.state.indexes.values()] })
          batch.event.structure.push({ collection: name, type: 'create' })
        }
        batch.documents(name, draft.changes)
      }
      if (batch.empty) return
      await this.persist(batch)
      for (const [name, draft] of drafts) {
        if (draft.changes.length === 0 && !draft.created) continue
        draft.state.version = draft.baseVersion + 1
        this.states.set(name, draft.state)
      }
      this.emit(batch.event)
    })
  }

  /** @internal */
  baseState(name: string) { return this.visible(name) }
  /** @internal */
  get newId() { return this.options.newId }
  /** @internal */
  checkWritable() { this.writable() }

  onDidChange(listener: (event: ChangeEvent) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  // ---- meta

  readonly meta: DatabaseMeta = {
    get: async <T extends Json = Json>(key: string) => { this.assertOpen(); return this.metaValues.get(key) as T | undefined },
    set: (key, value) => this.commitLock.run(async () => {
      this.writable()
      const stored = JSON.parse(JSON.stringify(value)) as Json
      await this.persistMeta(key, stored)
      this.metaValues.set(key, stored)
    }),
    delete: key => this.commitLock.run(async () => {
      this.writable()
      await this.persistMeta(key, undefined)
      this.metaValues.delete(key)
    })
  }

  /** @internal The current meta, for `KitStorageEngine.readMeta` on an open database. */
  metaCopy(): Record<string, Json> {
    this.assertOpen()
    return JSON.parse(JSON.stringify(Object.fromEntries(this.metaValues))) as Record<string, Json>
  }

  // ---- snapshots

  /**
   * No lock: a backend copies one committed state, because each batch reaches it whole, so writes carry on while a
   * snapshot is written (see docs/backup-restore-design.md, Phase 0 results).
   */
  snapshot(to: { path: string }, options: SnapshotOptions = {}): Promise<void> {
    const running = (async () => {
      this.assertOpen()
      const file = (to as Partial<{ path: unknown }> | undefined)?.path
      if (typeof file !== 'string' || file === '') throw new StorageError('INVALID_ARGUMENT', 'a snapshot needs a non-empty path')
      if (options.meta !== undefined && (typeof options.meta !== 'object' || options.meta === null || Array.isArray(options.meta))) {
        throw new StorageError('INVALID_ARGUMENT', 'snapshot meta must be an object')
      }
      const meta = options.meta === undefined ? undefined : JSON.parse(JSON.stringify(options.meta)) as Record<string, Json>
      const { signal, onProgress } = options
      if (signal?.aborted) throw new StorageError('ABORTED', `the snapshot of database "${this.name}" was abandoned`)
      try {
        await this.backend.snapshot(file, { ...(meta && { meta }), ...(signal && { signal }), ...(onProgress && { onProgress }) })
      } catch (err) {
        if (err instanceof StorageError) throw err
        if (signal?.aborted) throw new StorageError('ABORTED', `the snapshot of database "${this.name}" was abandoned`, { cause: err })
        throw ioError(`could not snapshot database "${this.name}" to ${file}`, err)
      }
    })()
    this.snapshots.add(running)
    void running.then(() => this.snapshots.delete(running), () => this.snapshots.delete(running))
    return running
  }

  // ---- lifecycle

  async flush() {
    this.assertOpen()
    await this.commitLock.idle()
    try { await this.backend.flush() } catch (err) { throw ioError(`could not flush database "${this.name}"`, err) }
  }

  async close() {
    if (this.closed) return
    await this.txLock.idle()
    await this.commitLock.idle()
    // A snapshot started while waiting is waited for too; `closed` is set with no await after the last check
    while (this.snapshots.size > 0) await Promise.allSettled([...this.snapshots])
    this.closed = true
    this.listeners.clear()
    try {
      await this.backend.close()
    } catch (err) {
      throw ioError(`could not close database "${this.name}"`, err)
    } finally {
      this.options.onClosed?.()
    }
  }
}

export interface Draft {
  state: CollectionState
  baseVersion: number
  created: boolean
  changes: Change[]
}

/** A transaction: copy-on-write drafts of the collections it writes, committed together or not at all. */
class KitTransaction implements Transaction {
  private readonly drafts = new Map<string, Draft>()
  private finished = false

  constructor(private readonly db: KitDatabase) {}

  collection<T extends object = JsonObject>(name: string): Collection<T> {
    return new KitCollection<T>(checkName(name), this.context())
  }

  private context(): CollectionContext {
    const live = () => {
      if (this.finished) throw new StorageError('INVALID_ARGUMENT', 'the transaction has finished')
    }
    return {
      newId: this.db.newId,
      read: name => { live(); return this.drafts.get(name)?.state ?? this.db.baseState(name) },
      write: async (name, compute) => {
        live()
        this.db.checkWritable()
        let draft = this.drafts.get(name)
        if (!draft) {
          const base = this.db.baseState(name)
          draft = { state: base?.clone() ?? new CollectionState(), baseVersion: base?.version ?? 0, created: !base, changes: [] }
        }
        const { result, changes } = compute(draft.state)
        if (changes.length > 0) {
          draft.state.apply(changes)
          draft.changes.push(...changes)
          this.drafts.set(name, draft)
        }
        return result
      },
      changeIndexes: async () => {
        throw new StorageError('INVALID_ARGUMENT', 'indexes can\'t be changed inside a transaction')
      }
    }
  }

  commit() { return this.db.commitTransaction(this.drafts) }
  finish() { this.finished = true }
}

