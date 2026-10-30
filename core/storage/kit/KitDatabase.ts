// core/storage/kit/KitDatabase.ts
//
// The Database implementation every backend shares: collection handles,
// transactions (copy-on-write per collection, one at a time per database,
// CONFLICT if a collection a transaction wrote was written outside it),
// change events after commit, auto-create and read-only rules. A backend
// implements DatabaseBackend: where stores and meta live and when to save.
import type {
  ChangeEvent,
  Collection,
  CollectionInfo,
  CollectionSchema,
  Database,
  DatabaseMeta,
  Disposable,
  Document,
  Filter,
  FindOptions,
  Json,
  JsonObject,
  OpenOptions,
  Transaction
} from '@tessera/types'
import { validateCollectionName } from '../documents'
import { StorageError, invalidArgument } from '../errors'
import { cloneJson } from '../json'
import { type DocumentStore, MapStore } from './DocumentStore'
import { type ChangeKind, KitCollection, type Scope } from './KitCollection'

export interface DatabaseBackend {
  store(name: string): DocumentStore | undefined
  createStore(name: string): DocumentStore
  deleteStore(name: string): boolean
  renameStore(from: string, to: string): void
  storeNames(): string[]

  metaGet(key: string): Json | undefined
  metaSet(key: string, value: Json): void
  metaDelete(key: string): void

  /** After every committed write, schema change or meta change: a buffered backend schedules a save. */
  touched(): void
  /** What explain() reports beyond the kit's own fields. */
  plan?(name: string, filter: Filter | undefined, options: FindOptions): JsonObject
  flush(): Promise<void>
  /** Final save and release. Called once. */
  close(): Promise<void>
}

interface Changes {
  insert: Set<string>
  update: Set<string>
  delete: Set<string>
}

export class KitDatabase implements Database {
  private open = true
  private listeners = new Set<(event: ChangeEvent) => void>()
  private queue: Promise<void> = Promise.resolve()
  private readonly autoCreate: boolean
  readonly readOnly: boolean
  readonly meta: DatabaseMeta

  constructor(
    readonly name: string,
    readonly engine: string,
    private readonly backend: DatabaseBackend,
    options: OpenOptions,
    private readonly onClose: () => void
  ) {
    this.readOnly = options.readOnly ?? false
    this.autoCreate = options.autoCreate ?? options.schema === undefined
    this.meta = {
      get: async key => { this.assertOpen(); return cloneJson(backend.metaGet(key)) },
      set: async (key, value) => { this.assertWritable(); backend.metaSet(key, cloneJson(value)); backend.touched() },
      delete: async key => { this.assertWritable(); backend.metaDelete(key); backend.touched() }
    }
  }

  get isOpen() {
    return this.open
  }

  private assertOpen() {
    if (!this.open) throw new StorageError('NOT_OPEN', `Database "${this.name}" is closed`, { database: this.name })
  }

  private assertWritable() {
    this.assertOpen()
    if (this.readOnly) throw new StorageError('READ_ONLY', `Database "${this.name}" was opened read-only`, { database: this.name })
  }

  private unknown(name: string) {
    return new StorageError('UNKNOWN_COLLECTION', `Database "${this.name}" has no collection "${name}"`, { database: this.name, collection: name })
  }

  private emit(changes: Map<string, Changes>) {
    for (const [collection, kinds] of changes) {
      for (const kind of ['insert', 'update', 'delete'] as const) {
        const ids = [...kinds[kind]]
        if (!ids.length) continue
        const event: ChangeEvent = { database: this.name, collection, kind, ids }
        for (const listener of this.listeners) listener(event)
      }
    }
  }

  private record(changes: Map<string, Changes>, name: string, kind: ChangeKind, ids: string[]) {
    let entry = changes.get(name)
    if (!entry) changes.set(name, entry = { insert: new Set(), update: new Set(), delete: new Set() })
    for (const id of ids) entry[kind].add(id)
  }

  /** The scope for direct use: reads and writes hit the live stores, each write is its own commit. */
  private liveScope(): Scope {
    const changes = new Map<string, Changes>()
    return {
      database: this.name,
      engine: this.engine,
      inTransaction: false,
      read: name => {
        this.assertOpen()
        const store = this.backend.store(name)
        if (!store && !this.autoCreate) throw this.unknown(name)
        return store
      },
      write: name => {
        this.assertWritable()
        let store = this.backend.store(name)
        if (!store) {
          if (!this.autoCreate) throw this.unknown(name)
          store = this.backend.createStore(name)
        }
        return store
      },
      changed: (name, kind, ids) => this.record(changes, name, kind, ids),
      committed: name => {
        const store = this.backend.store(name)
        if (store) store.version++
        this.backend.touched()
        const pending = new Map(changes)
        changes.clear()
        this.emit(pending)
      },
      plan: this.backend.plan?.bind(this.backend)
    }
  }

  collection<T extends Document = Document>(name: string): Collection<T> {
    return new KitCollection<T>(name, this.liveScope())
  }

  async listCollections(): Promise<CollectionInfo[]> {
    this.assertOpen()
    return this.backend.storeNames()
      .sort()
      .map(name => {
        const store = this.backend.store(name)!
        return { name, indexes: store.indexes.map(i => ({ ...i, fields: [...i.fields] })), count: store.size }
      })
  }

  async createCollection(schema: CollectionSchema) {
    this.assertWritable()
    validateCollectionName(schema.name)
    if (!this.backend.store(schema.name)) {
      this.backend.createStore(schema.name)
      this.backend.touched()
    }
    const collection = new KitCollection(schema.name, { ...this.liveScope(), write: () => this.backend.store(schema.name)! })
    for (const index of schema.indexes ?? []) await collection.ensureIndex(index)
  }

  async dropCollection(name: string) {
    this.assertWritable()
    const dropped = this.backend.deleteStore(name)
    if (dropped) this.backend.touched()
    return dropped
  }

  async renameCollection(from: string, to: string) {
    this.assertWritable()
    validateCollectionName(to)
    if (!this.backend.store(from)) throw this.unknown(from)
    if (this.backend.store(to)) throw invalidArgument(`Database "${this.name}" already has a collection "${to}"`)
    this.backend.renameStore(from, to)
    this.backend.touched()
  }

  async transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R> {
    this.assertOpen()
    let release!: () => void
    const previous = this.queue
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous

    try {
      this.assertOpen()
      const overlay = new Map<string, MapStore>()
      const baseVersions = new Map<string, number>()
      const created = new Set<string>()
      const changes = new Map<string, Changes>()

      const scope: Scope = {
        database: this.name,
        engine: this.engine,
        inTransaction: true,
        read: name => {
          this.assertOpen()
          const store = overlay.get(name) ?? this.backend.store(name)
          if (!store && !this.autoCreate) throw this.unknown(name)
          return store
        },
        write: name => {
          this.assertWritable()
          let store = overlay.get(name)
          if (store) return store
          const live = this.backend.store(name)
          if (live) {
            store = live.snapshot()
            baseVersions.set(name, live.version)
          } else {
            if (!this.autoCreate) throw this.unknown(name)
            store = new MapStore()
            created.add(name)
          }
          overlay.set(name, store)
          return store
        },
        changed: (name, kind, ids) => this.record(changes, name, kind, ids),
        committed: () => {},
        plan: this.backend.plan?.bind(this.backend)
      }

      const result = await work({ collection: <T extends Document = Document>(name: string) => new KitCollection<T>(name, scope) })

      // Commit: nothing outside the transaction may have written the collections it touched.
      if (overlay.size) this.assertWritable()
      for (const [name, version] of baseVersions) {
        if (this.backend.store(name)?.version !== version) {
          throw new StorageError('CONFLICT', `Collection "${name}" was written outside the transaction`, { database: this.name, collection: name })
        }
      }
      for (const name of created) {
        if (this.backend.store(name)) {
          throw new StorageError('CONFLICT', `Collection "${name}" was created outside the transaction`, { database: this.name, collection: name })
        }
      }
      for (const [name, store] of overlay) {
        const live = this.backend.store(name) ?? this.backend.createStore(name)
        live.apply(store, touchedIds(changes.get(name)))
        live.version++
      }
      if (overlay.size) this.backend.touched()
      this.emit(changes)
      return result
    } finally {
      release()
    }
  }

  onDidChange(listener: (event: ChangeEvent) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  async flush() {
    this.assertOpen()
    await this.backend.flush()
  }

  async close() {
    if (!this.open) return
    await this.queue
    this.open = false
    this.listeners.clear()
    try {
      await this.backend.close()
    } finally {
      this.onClose()
    }
  }
}

function touchedIds(changes: Changes | undefined): Set<string> {
  const ids = new Set<string>()
  if (!changes) return ids
  for (const kind of ['insert', 'update', 'delete'] as const) for (const id of changes[kind]) ids.add(id)
  return ids
}
