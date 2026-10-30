// plugins/storage.loki/src/privileged/LokiStorageEngine.ts
//
// The LokiJS backend for the storage contract in tessera-types/storage.ts.
// One Loki instance and one file per database (`<dir>/<name>.loki.json`, or
// the path given). All behaviour comes from the shared kit (KitDatabase and
// KitCollection over DocumentStores); this file maps a DocumentStore onto a
// Loki collection and decides when to write the file.
//
// Storage layout inside a Loki file:
//   <collection>            { id, doc }  — the document in an envelope, so
//                           Loki's own `meta` and `$loki` never touch it and
//                           a document may have a field called `meta`
//   __tessera.collections   { name, indexes }  — declared indexes
//   __tessera.meta          { key, value }     — Database.meta
//
// Writes are buffered: every committed change marks the database dirty and
// schedules a save `saveDelay` ms later; flush() saves now; close() flushes.
// The Loki fs adapter writes `<file>~` and renames it over the file, so a
// crash mid-save leaves the previous file intact. Declared indexes are
// definitions only (uniqueness is enforced by the kit); queries scan, which
// at the planned scale costs milliseconds. Loki's unique index on `id` gives
// get() its direct lookup.
import fs from 'node:fs'
import path from 'node:path'
import Loki, { LokiFsAdapter } from 'lokijs'
import type { Database, DatabaseTarget, Filter, FindOptions, IndexSpec, Json, JsonObject, Logger, OpenOptions, StorageCapabilities, StorageEngine } from '@tessera/types'
import {
  type DatabaseBackend,
  type DocumentStore,
  KitDatabase,
  MapStore,
  StorageError,
  cloneUnique,
  rebuildUnique,
  ulid
} from '@core/storage'

const COLLECTIONS = '__tessera.collections'
const META = '__tessera.meta'
const INTERNAL = new Set([COLLECTIONS, META])
const FILE_SUFFIX = '.loki.json'
const NAME = /^[A-Za-z0-9][\w.-]*$/

type LokiCollection = ReturnType<Loki['addCollection']>
interface Envelope { id: string, doc: JsonObject }
interface CollectionRecord { name: string, indexes: IndexSpec[] }
interface MetaRecord { key: string, value: Json }

// ---------------------------------------------------------------------------
// DocumentStore over a Loki collection

class LokiStore implements DocumentStore {
  unique = new Map<string, Map<string, string>>()
  version = 0

  constructor(
    readonly name: string,
    private readonly collection: LokiCollection,
    private readonly registry: LokiCollection
  ) {
    rebuildUnique(this, name)
  }

  private record(): CollectionRecord {
    let record = this.registry.by('name', this.name) as CollectionRecord | undefined
    if (!record) record = this.registry.insert({ name: this.name, indexes: [] }) as CollectionRecord
    return record
  }

  /** Index declarations live in the registry collection so they persist with the file. */
  get indexes(): IndexSpec[] {
    return (this.registry.by('name', this.name) as CollectionRecord | undefined)?.indexes ?? []
  }

  set indexes(indexes: IndexSpec[]) {
    const record = this.record()
    record.indexes = indexes.map(i => ({ ...i, fields: [...i.fields] }))
    this.registry.update(record)
  }

  get size() {
    return this.collection.count()
  }

  private entry(id: string): Envelope | undefined {
    return this.collection.by('id', id) as Envelope | undefined
  }

  get(id: string) {
    return this.entry(id)?.doc
  }

  *values(): Iterable<JsonObject> {
    for (const entry of this.collection.data as Envelope[]) yield entry.doc
  }

  set(id: string, doc: JsonObject) {
    const entry = this.entry(id)
    if (entry) {
      entry.doc = doc
      this.collection.update(entry)
    } else {
      this.collection.insert({ id, doc })
    }
  }

  delete(id: string) {
    const entry = this.entry(id)
    if (entry) this.collection.remove(entry)
  }

  snapshot(): MapStore {
    const copy = new MapStore()
    for (const entry of this.collection.data as Envelope[]) copy.docs.set(entry.id, entry.doc)
    copy.indexes = this.indexes
    copy.unique = cloneUnique(this.unique)
    copy.version = this.version
    return copy
  }

  apply(overlay: MapStore, touched: Set<string>) {
    for (const id of touched) {
      const doc = overlay.get(id)
      if (doc) this.set(id, doc)
      else this.delete(id)
    }
    this.unique = overlay.unique
  }
}

// ---------------------------------------------------------------------------
// DatabaseBackend over a Loki instance

interface LokiBackendOptions {
  saveDelay: number
  log: Logger
}

class LokiBackend implements DatabaseBackend {
  private readonly stores = new Map<string, LokiStore>()
  private readonly registry: LokiCollection
  private readonly metaCollection: LokiCollection
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly db: Loki, private readonly file: string, private readonly options: LokiBackendOptions) {
    this.registry = db.getCollection(COLLECTIONS) ?? db.addCollection(COLLECTIONS, { unique: ['name'] })
    this.metaCollection = db.getCollection(META) ?? db.addCollection(META, { unique: ['key'] })
    for (const { name } of db.listCollections()) {
      if (!INTERNAL.has(name)) this.stores.set(name, new LokiStore(name, db.getCollection(name), this.registry))
    }
  }

  store(name: string) {
    return this.stores.get(name)
  }

  createStore(name: string) {
    const store = new LokiStore(name, this.db.addCollection(name, { unique: ['id'] }), this.registry)
    store.indexes = []
    this.stores.set(name, store)
    return store
  }

  deleteStore(name: string) {
    if (!this.stores.delete(name)) return false
    this.db.removeCollection(name)
    const record = this.registry.by('name', name)
    if (record) this.registry.remove(record)
    return true
  }

  renameStore(from: string, to: string) {
    const store = this.stores.get(from)!
    this.db.renameCollection(from, to)
    const record = this.registry.by('name', from) as CollectionRecord | undefined
    if (record) this.registry.remove(record)
    const renamed = new LokiStore(to, this.db.getCollection(to), this.registry)
    renamed.indexes = record?.indexes ?? []
    renamed.version = store.version
    this.stores.delete(from)
    this.stores.set(to, renamed)
  }

  storeNames() {
    return [...this.stores.keys()]
  }

  metaGet(key: string) {
    return (this.metaCollection.by('key', key) as MetaRecord | undefined)?.value
  }

  metaSet(key: string, value: Json) {
    const record = this.metaCollection.by('key', key) as MetaRecord | undefined
    if (record) {
      record.value = value
      this.metaCollection.update(record)
    } else {
      this.metaCollection.insert({ key, value })
    }
  }

  metaDelete(key: string) {
    const record = this.metaCollection.by('key', key)
    if (record) this.metaCollection.remove(record)
  }

  plan(_name: string, _filter: Filter | undefined, _options: FindOptions): JsonObject {
    return { file: this.file, persisted: true }
  }

  touched() {
    this.dirty = true
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.save().catch(err => this.options.log.error(`[storage-loki] Failed to save ${this.file}`, err))
    }, this.options.saveDelay)
  }

  /** Writes the file if anything changed. Saves never overlap; a save requested during one runs after it. */
  private save(): Promise<void> {
    const run = this.saving.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      try {
        await new Promise<void>((resolve, reject) => {
          this.db.saveDatabase((err?: Error | null) => (err ? reject(err) : resolve()))
        })
      } catch (err) {
        this.dirty = true
        throw new StorageError('IO', `Failed to save ${this.file}: ${(err as Error).message}`, { file: this.file }, { cause: err })
      }
    })
    this.saving = run.catch(() => {})
    return run
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.save()
  }

  async close() {
    this.closed = true
    await this.flush()
    await new Promise<void>(resolve => this.db.close(() => resolve()))
  }
}

// ---------------------------------------------------------------------------
// Engine

export interface LokiStorageEngineOptions {
  /** Folder for named databases, created if absent. */
  dir: string
  /** How long after the last change a save is written. Default 500 ms. */
  saveDelay?: number
  log?: Logger
}

export class LokiStorageEngine implements StorageEngine {
  readonly id: string = 'loki'
  private readonly dir: string
  private readonly saveDelay: number
  private readonly log: Logger
  private readonly handles = new Map<string, KitDatabase>()
  private readonly opening = new Map<string, Promise<KitDatabase>>()
  /** Open named databases that may not have been written yet, for list(). */
  private readonly openNames = new Map<string, string>()

  constructor(options: LokiStorageEngineOptions) {
    this.dir = options.dir
    this.saveDelay = options.saveDelay ?? 500
    this.log = options.log ?? console
  }

  capabilities(): StorageCapabilities {
    return { aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', writeThrough: false }
  }

  private fileFor(target: DatabaseTarget): string {
    if ('path' in target) {
      if (typeof target.path !== 'string' || target.path === '') throw new StorageError('INVALID_ARGUMENT', 'A database path must be a non-empty string')
      return path.resolve(target.path)
    }
    if (typeof target.name !== 'string' || !NAME.test(target.name)) {
      throw new StorageError('INVALID_ARGUMENT', `"${String(target.name)}" is not a valid database name (letters, digits, . _ -)`)
    }
    return path.join(this.dir, target.name + FILE_SUFFIX)
  }

  async open(target: DatabaseTarget, options: OpenOptions = {}): Promise<Database> {
    const file = this.fileFor(target)
    const name = 'path' in target ? target.path : target.name

    // No await before the in-progress load is registered, so two concurrent
    // opens of one file share a single load.
    let opening = this.opening.get(file)
    const existing = this.handles.get(file)
    if (existing) opening = Promise.resolve(existing)
    if (!opening) {
      opening = this.load(file, name, options).then(handle => {
        this.handles.set(file, handle)
        if ('name' in target) this.openNames.set(file, target.name)
        return handle
      }).finally(() => { this.opening.delete(file) })
      this.opening.set(file, opening)
    }

    const handle = await opening
    for (const schema of options.schema ?? []) await handle.createCollection(schema)
    return handle
  }

  private async load(file: string, name: string, options: OpenOptions): Promise<KitDatabase> {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
    } catch (err) {
      throw new StorageError('IO', `Cannot create ${path.dirname(file)}: ${(err as Error).message}`, { file }, { cause: err })
    }
    const db = new Loki(file, { adapter: new LokiFsAdapter(), autoload: false, autosave: false })
    await new Promise<void>((resolve, reject) => {
      db.loadDatabase({}, (err?: Error | null) => (err ? reject(new StorageError('IO', `Failed to load ${file}: ${err.message}`, { file }, { cause: err })) : resolve()))
    })
    const backend = new LokiBackend(db, file, { saveDelay: this.saveDelay, log: this.log })
    this.log.info(`[storage-loki] Opened database "${name}" at ${file}`)
    return new KitDatabase(name, this.id, backend, options, () => {
      this.handles.delete(file)
      this.openNames.delete(file)
    })
  }

  async list() {
    let entries: string[]
    try {
      entries = await fs.promises.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new StorageError('IO', `Failed to list ${this.dir}`, { dir: this.dir }, { cause: err })
    }
    const onDisk = entries.filter(entry => entry.endsWith(FILE_SUFFIX)).map(entry => entry.slice(0, -FILE_SUFFIX.length))
    return [...new Set([...onDisk, ...this.openNames.values()])].sort()
  }

  async drop(target: DatabaseTarget) {
    const file = this.fileFor(target)
    await this.handles.get(file)?.close()
    for (const candidate of [file, `${file}~`]) {
      await fs.promises.rm(candidate, { force: true })
    }
  }

  newId() {
    return ulid()
  }

  async closeAll() {
    for (const handle of [...this.handles.values()]) await handle.close()
  }
}
