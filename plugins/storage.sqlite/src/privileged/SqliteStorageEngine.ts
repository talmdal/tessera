// plugins/storage.sqlite/src/privileged/SqliteStorageEngine.ts
//
// The SQLite backend for the storage contract in tessera-types/storage.ts,
// on node:sqlite (built into Node and Electron's Node, synchronous, no
// native module to rebuild — which settles the packaging question from
// docs/vault-design.md). One SQLite file per database
// (`<dir>/<name>.sqlite`, or the path given).
//
// Strategy: native storage, shared semantics. Three fixed tables hold
// everything, so collection names never become SQL identifiers:
//
//   tessera_documents    (collection, id, doc JSON)  PRIMARY KEY (collection, id)
//   tessera_collections  (name, indexes JSON)        declared indexes
//   tessera_meta         (key, value JSON)           Database.meta
//
// Each collection is cached in memory on first touch and every write is
// mirrored to SQLite. Writes queue on a batch that DatabaseBackend.touched()
// commits in one SQL transaction — KitDatabase calls it exactly once per
// committed operation, so an updateMany or a multi-collection transaction
// is one atomic, durable commit (WAL journal), and a crash mid-operation
// leaves the previous state. There is no save delay and nothing to flush:
// capabilities report writeThrough. Queries and aggregation run through the
// shared kit over the cache (`aggregate/regex/textSearch: 'emulated'`);
// pushing them down to SQL is a later optimisation behind the same flags.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Database,
  DatabaseTarget,
  IndexSpec,
  Json,
  JsonObject,
  Logger,
  OpenOptions,
  StorageCapabilities,
  StorageEngine
} from '@tessera/types'
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

const FILE_SUFFIX = '.sqlite'
const NAME = /^[A-Za-z0-9][\w.-]*$/

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS tessera_documents (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    doc        TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS tessera_collections (
    name    TEXT PRIMARY KEY,
    indexes TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tessera_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

function io(message: string, file: string, cause: unknown): StorageError {
  const why = cause instanceof Error ? cause.message : String(cause)
  return new StorageError('IO', `${message}: ${why}`, { file }, { cause })
}

// ---------------------------------------------------------------------------
// DocumentStore over one collection's rows, cached in memory

class SqliteStore implements DocumentStore {
  private readonly docs = new Map<string, JsonObject>()
  private declared: IndexSpec[]
  unique = new Map<string, Map<string, string>>()
  version = 0

  constructor(readonly name: string, private readonly backend: SqliteBackend, indexes: IndexSpec[]) {
    this.declared = indexes
    for (const row of backend.rowsOf(name)) this.docs.set(row.id, JSON.parse(row.doc) as JsonObject)
    rebuildUnique(this, name)
  }

  get indexes(): IndexSpec[] {
    return this.declared
  }

  set indexes(indexes: IndexSpec[]) {
    this.declared = indexes.map(i => ({ ...i, fields: [...i.fields] }))
    this.backend.queueIndexes(this.name, this.declared)
  }

  get size() {
    return this.docs.size
  }

  get(id: string) {
    return this.docs.get(id)
  }

  values() {
    return this.docs.values()
  }

  set(id: string, doc: JsonObject) {
    this.docs.set(id, doc)
    this.backend.queuePut(this.name, id, doc)
  }

  delete(id: string) {
    this.docs.delete(id)
    this.backend.queueDelete(this.name, id)
  }

  snapshot(): MapStore {
    const copy = new MapStore()
    for (const [id, doc] of this.docs) copy.docs.set(id, doc)
    copy.indexes = this.declared
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
// DatabaseBackend over one SQLite file

class SqliteBackend implements DatabaseBackend {
  private readonly db: DatabaseSync
  private readonly stores = new Map<string, SqliteStore>()
  /** Declared collections, loaded at open; stores are built (and cached) on first touch. */
  private readonly declared = new Map<string, IndexSpec[]>()
  /** Mirror writes queued since the last touched(); committed as one SQL transaction. */
  private pending: (() => void)[] = []

  private readonly putDoc: ReturnType<DatabaseSync['prepare']>
  private readonly dropDoc: ReturnType<DatabaseSync['prepare']>
  private readonly putIndexes: ReturnType<DatabaseSync['prepare']>

  constructor(private readonly file: string) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(file)
      db.exec(SCHEMA)
    } catch (err) {
      // Opening succeeds on any file; it is the schema that fails on one
      // that isn't SQLite. Release the connection, or the file stays locked
      // (on Windows it can't be deleted while a handle is open).
      try {
        db?.close()
      } catch {
        // The original error matters more.
      }
      throw io(`Failed to open ${file}`, file, err)
    }
    this.db = db
    this.putDoc = this.db.prepare('INSERT OR REPLACE INTO tessera_documents (collection, id, doc) VALUES (?, ?, ?)')
    this.dropDoc = this.db.prepare('DELETE FROM tessera_documents WHERE collection = ? AND id = ?')
    this.putIndexes = this.db.prepare('INSERT OR REPLACE INTO tessera_collections (name, indexes) VALUES (?, ?)')
    for (const row of this.db.prepare('SELECT name, indexes FROM tessera_collections').all() as unknown as { name: string, indexes: string }[]) {
      this.declared.set(row.name, JSON.parse(row.indexes) as IndexSpec[])
    }
  }

  // Used by SqliteStore -----------------------------------------------------

  rowsOf(name: string): { id: string, doc: string }[] {
    return this.db.prepare('SELECT id, doc FROM tessera_documents WHERE collection = ?').all(name) as unknown as { id: string, doc: string }[]
  }

  queuePut(collection: string, id: string, doc: JsonObject) {
    const text = JSON.stringify(doc)
    this.pending.push(() => this.putDoc.run(collection, id, text))
  }

  queueDelete(collection: string, id: string) {
    this.pending.push(() => this.dropDoc.run(collection, id))
  }

  queueIndexes(name: string, indexes: IndexSpec[]) {
    const text = JSON.stringify(indexes)
    this.declared.set(name, indexes)
    this.pending.push(() => this.putIndexes.run(name, text))
  }

  // DatabaseBackend ---------------------------------------------------------

  store(name: string): DocumentStore | undefined {
    const cached = this.stores.get(name)
    if (cached) return cached
    const indexes = this.declared.get(name)
    if (indexes === undefined) return undefined
    const store = new SqliteStore(name, this, indexes)
    this.stores.set(name, store)
    return store
  }

  createStore(name: string) {
    this.declared.set(name, [])
    const store = new SqliteStore(name, this, [])
    this.stores.set(name, store)
    store.indexes = []          // queues the registry row; written on the next touched()
    return store
  }

  deleteStore(name: string) {
    if (!this.declared.delete(name)) return false
    this.stores.delete(name)
    this.run('delete collection', () => {
      this.transaction(() => {
        this.db.prepare('DELETE FROM tessera_documents WHERE collection = ?').run(name)
        this.db.prepare('DELETE FROM tessera_collections WHERE name = ?').run(name)
      })
    })
    return true
  }

  renameStore(from: string, to: string) {
    this.run('rename collection', () => {
      this.transaction(() => {
        this.db.prepare('UPDATE tessera_documents SET collection = ? WHERE collection = ?').run(to, from)
        this.db.prepare('UPDATE tessera_collections SET name = ? WHERE name = ?').run(to, from)
      })
    })
    this.declared.set(to, this.declared.get(from)!)
    this.declared.delete(from)
    const store = this.stores.get(from)
    if (store) {
      this.stores.delete(from)
      this.stores.set(to, new SqliteStore(to, this, this.declared.get(to)!))
      this.stores.get(to)!.version = store.version
    }
  }

  storeNames() {
    return [...this.declared.keys()]
  }

  metaGet(key: string): Json | undefined {
    const row = this.db.prepare('SELECT value FROM tessera_meta WHERE key = ?').get(key) as unknown as { value: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.value) as Json)
  }

  metaSet(key: string, value: Json) {
    const text = JSON.stringify(value)
    this.pending.push(() => this.db.prepare('INSERT OR REPLACE INTO tessera_meta (key, value) VALUES (?, ?)').run(key, text))
  }

  metaDelete(key: string) {
    this.pending.push(() => this.db.prepare('DELETE FROM tessera_meta WHERE key = ?').run(key))
  }

  /** One committed operation: write everything it queued in one SQL transaction. */
  touched() {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.run('write', () => this.transaction(() => { for (const write of batch) write() }))
  }

  plan(): JsonObject {
    return { file: this.file, persisted: true, writeThrough: true }
  }

  async flush() {
    // Write-through: between operations only writes queued by an operation
    // that failed part-way can be outstanding; persist them so disk matches
    // memory.
    this.touched()
  }

  async close() {
    this.touched()
    this.run('close', () => this.db.close())
  }

  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original error matters more.
      }
      throw err
    }
  }

  private run(what: string, work: () => void) {
    try {
      work()
    } catch (err) {
      if (err instanceof StorageError) throw err
      throw io(`Failed to ${what} in ${this.file}`, this.file, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Engine

export interface SqliteStorageEngineOptions {
  /** Folder for named databases, created if absent. */
  dir: string
  log?: Logger
}

export class SqliteStorageEngine implements StorageEngine {
  readonly id: string = 'sqlite'
  private readonly dir: string
  private readonly handles = new Map<string, KitDatabase>()
  /** Open named databases that may not be listed yet, for list(). */
  private readonly openNames = new Map<string, string>()

  private readonly log: Logger

  constructor(options: SqliteStorageEngineOptions) {
    this.dir = options.dir
    this.log = options.log ?? console
  }

  capabilities(): StorageCapabilities {
    return { aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', writeThrough: true }
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

    let handle = this.handles.get(file)
    if (!handle) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
      } catch (err) {
        throw io(`Cannot create ${path.dirname(file)}`, file, err)
      }
      const backend = new SqliteBackend(file)
      this.log.info(`[storage-sqlite] Opened database "${'path' in target ? target.path : target.name}" at ${file}`)
      handle = new KitDatabase('path' in target ? target.path : target.name, this.id, backend, options, () => {
        this.handles.delete(file)
        this.openNames.delete(file)
      })
      this.handles.set(file, handle)
      if ('name' in target) this.openNames.set(file, target.name)
    }
    for (const schema of options.schema ?? []) await handle.createCollection(schema)
    return handle
  }

  async list() {
    let entries: string[]
    try {
      entries = await fs.promises.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw io(`Failed to list ${this.dir}`, this.dir, err)
    }
    const onDisk = entries.filter(entry => entry.endsWith(FILE_SUFFIX)).map(entry => entry.slice(0, -FILE_SUFFIX.length))
    return [...new Set([...onDisk, ...this.openNames.values()])].sort()
  }

  async drop(target: DatabaseTarget) {
    const file = this.fileFor(target)
    await this.handles.get(file)?.close()
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
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
