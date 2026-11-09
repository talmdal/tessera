import fs from 'node:fs'
import path from 'node:path'
import Loki from 'lokijs'
import {
  checkDatabaseName, ioError, StorageError,
  type BackendDriver, type IndexSpec, type LoadedDatabase, type StorageBackend, type StorageChange
} from '@tessera/storage-kit'
import type { DatabaseTarget, Doc, Json, SnapshotOptions } from '@tessera/types'

const EXTENSION = '.loki.json'
const COLLECTIONS = '__tessera.collections'
const META = '__tessera.meta'

/** What Loki needs from a persistence adapter; `LokiFsAdapter` by default, replaceable in tests. */
export interface LokiAdapter {
  loadDatabase(name: string, callback: (data: string | null | Error) => void): void
  saveDatabase(name: string, data: string, callback: (err?: Error | null) => void): void
}

export interface LokiDriverOptions {
  /** Where databases opened by name live. */
  directory: string
  /** Milliseconds after the last change before the file is written; `flush()` and `close()` write at once. */
  saveDelay?: number
  adapter?: LokiAdapter
  log?: { error(message: string, ...rest: unknown[]): void }
}

interface Envelope { id: string, doc: Doc }

/** Loads a file through the adapter: its text, or undefined when there is none. */
function loadText(adapter: LokiAdapter, file: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => adapter.loadDatabase(file, data => {
    if (data instanceof Error) reject(data)
    else resolve(typeof data === 'string' ? data : undefined)
  }))
}

function saveText(adapter: LokiAdapter, file: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => adapter.saveDatabase(file, text, err => err ? reject(err) : resolve()))
}

/** Sets a meta value in a Loki instance's reserved meta collection, as a committed 'meta' change does. */
function setMeta(db: any, key: string, value: Json) {
  const meta = db.getCollection(META) ?? db.addCollection(META, { unique: ['key'] })
  const entry = meta.by('key', key)
  if (entry) { entry.value = value; meta.update(entry) } else meta.insert({ key, value })
}

/**
 * One Loki instance per database. Each user collection is a Loki collection of envelopes `{ id, doc }`, so
 * Loki's own `$loki` and `meta` fields stay on the envelope and never reach the document. Index definitions
 * and meta values are kept in two reserved collections. Saves are buffered and atomic (`<file>~` is written
 * and renamed), so a failed save leaves the previous file intact.
 */
class LokiBackend implements StorageBackend {
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: any,
    private readonly file: string,
    private readonly readOnly: boolean,
    private readonly saveDelay: number,
    private readonly log: NonNullable<LokiDriverOptions['log']>
  ) {}

  static async open(file: string, options: LokiDriverOptions, readOnly: boolean): Promise<LokiBackend> {
    if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new (Loki as any)(file, {
      adapter: options.adapter ?? new (Loki as any).LokiFsAdapter(),
      autoload: false,
      autosave: false,
      throttledSaves: true
    })
    await new Promise<void>((resolve, reject) => {
      db.loadDatabase({}, (err?: unknown) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())
    })
    return new LokiBackend(db, file, readOnly, options.saveDelay ?? 500, options.log ?? console)
  }

  private collectionOf(name: string) {
    return this.db.getCollection(name) ?? this.db.addCollection(name, { unique: ['id'] })
  }
  private reserved(name: string, key: string) {
    return this.db.getCollection(name) ?? this.db.addCollection(name, { unique: [key] })
  }

  async load(): Promise<LoadedDatabase> {
    const collections = (this.db.getCollection(COLLECTIONS)?.find() ?? []).map((entry: { name: string, indexes: IndexSpec[] }) => ({
      name: entry.name,
      indexes: entry.indexes,
      docs: (this.db.getCollection(entry.name)?.find() ?? []).map((e: Envelope) => e.doc)
    }))
    const meta: Record<string, Json> = {}
    for (const entry of this.db.getCollection(META)?.find() ?? []) meta[entry.key] = entry.value
    return { collections, meta }
  }

  async commit(changes: StorageChange[]) {
    if (this.readOnly) throw new StorageError('READ_ONLY', 'database is read-only')
    for (const change of changes) {
      switch (change.type) {
        case 'collection': {
          const catalogue = this.reserved(COLLECTIONS, 'name')
          const entry = catalogue.by('name', change.name)
          if (entry) { entry.indexes = change.indexes; catalogue.update(entry) }
          else catalogue.insert({ name: change.name, indexes: change.indexes })
          this.collectionOf(change.name)
          break
        }
        case 'drop': {
          if (this.db.getCollection(change.name)) this.db.removeCollection(change.name)
          const catalogue = this.reserved(COLLECTIONS, 'name')
          const entry = catalogue.by('name', change.name)
          if (entry) catalogue.remove(entry)
          break
        }
        case 'rename': {
          if (this.db.getCollection(change.from)) this.db.renameCollection(change.from, change.to)
          const catalogue = this.reserved(COLLECTIONS, 'name')
          const entry = catalogue.by('name', change.from)
          if (entry) { entry.name = change.to; catalogue.update(entry) }
          break
        }
        case 'put': {
          const collection = this.collectionOf(change.collection)
          const existing = collection.by('id', change.doc.id)
          if (existing) { existing.doc = change.doc; collection.update(existing) }
          else collection.insert({ id: change.doc.id, doc: change.doc })
          break
        }
        case 'delete': {
          const collection = this.collectionOf(change.collection)
          const existing = collection.by('id', change.id)
          if (existing) collection.remove(existing)
          break
        }
        case 'meta': {
          const meta = this.reserved(META, 'key')
          const entry = meta.by('key', change.key)
          if (change.value === undefined) { if (entry) meta.remove(entry) }
          else if (entry) { entry.value = change.value; meta.update(entry) }
          else meta.insert({ key: change.key, value: change.value })
        }
      }
    }
    this.dirty = true
    this.schedule()
  }

  private schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.save().catch(err => this.log.error(`[storage.loki] Could not save ${this.file}`, err))
    }, this.saveDelay)
    this.timer.unref?.()
  }

  /** Saves if there is anything unsaved; saves never overlap. A failure leaves the data marked dirty. */
  private save(): Promise<void> {
    const next = this.saving.then(() => new Promise<void>((resolve, reject) => {
      if (!this.dirty) return resolve()
      this.dirty = false
      this.db.saveDatabase((err?: unknown) => {
        if (!err) return resolve()
        this.dirty = true
        reject(ioError(`could not write ${this.file}`, err))
      })
    }))
    this.saving = next.catch(() => {})
    return next
  }

  async flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.save()
  }

  /**
   * The in-memory Loki holds every committed batch (saves to disk are buffered), and serialising it is synchronous,
   * so the copy is one committed state. The copy is rebuilt as a Loki of its own to add the meta, then saved through
   * the same adapter as the database, which writes `<file>~` and renames it.
   */
  async snapshot(file: string, { meta, signal, onProgress }: SnapshotOptions) {
    const target = path.resolve(file)
    const adapter: LokiAdapter = this.db.persistenceAdapter
    const abandoned = () => new StorageError('ABORTED', `the snapshot to ${target} was abandoned`)
    if (signal?.aborted) throw abandoned()
    if (await loadText(adapter, target).catch(() => 'unreadable') !== undefined) {
      throw new StorageError('INVALID_ARGUMENT', `${target} already exists`)
    }
    const copy = new (Loki as any)(target, { adapter, autoload: false, autosave: false })
    copy.loadJSON(this.db.serialize())
    for (const [key, value] of Object.entries(meta ?? {})) setMeta(copy, key, value)
    const text: string = copy.serialize()
    JSON.parse(text)    // the check: what is written reads back
    if (signal?.aborted) throw abandoned()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      await saveText(adapter, target, text)
      if (signal?.aborted) throw abandoned()
    } catch (err) {
      for (const candidate of [target, `${target}~`]) fs.rmSync(candidate, { force: true })
      throw signal?.aborted ? abandoned() : ioError(`could not write ${target}`, err)
    }
    onProgress?.(1)
  }

  async close() {
    await this.flush()
    await new Promise<void>(resolve => this.db.close(() => resolve()))
  }
}

export function lokiDriver(options: LokiDriverOptions): BackendDriver {
  const fileOf = (target: DatabaseTarget) =>
    'name' in target ? path.join(options.directory, checkDatabaseName(target.name) + EXTENSION) : path.resolve(target.path)

  return {
    id: 'storage-loki',
    capabilities: { transactions: true, aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', durability: 'buffered' },
    open: (target, { readOnly }) => LokiBackend.open(fileOf(target), options, readOnly),
    /** Loki has to read the whole file, but builds nothing from it but the meta. */
    async readMeta(target) {
      const file = fileOf(target)
      const text = await loadText(options.adapter ?? new (Loki as any).LokiFsAdapter(), file)
        .catch(err => { throw ioError(`could not read ${file}`, err) })
      if (text === undefined) throw new StorageError('NOT_FOUND', `there is no database at ${file}`)
      let saved: { collections?: { name?: string, data?: { key: string, value: Json }[] }[] }
      try { saved = JSON.parse(text) } catch (err) { throw ioError(`could not read the meta of ${file}`, err) }
      const entries = (Array.isArray(saved?.collections) ? saved.collections : []).find(c => c?.name === META)?.data ?? []
      return Object.fromEntries(entries.map(entry => [entry.key, entry.value]))
    },
    async list() {
      if (!fs.existsSync(options.directory)) return []
      return fs.readdirSync(options.directory)
        .filter(file => file.endsWith(EXTENSION))
        .map(file => file.slice(0, -EXTENSION.length))
        .sort()
    },
    async drop(target) {
      const file = fileOf(target)
      for (const candidate of [file, `${file}~`]) fs.rmSync(candidate, { force: true })
    }
  }
}
