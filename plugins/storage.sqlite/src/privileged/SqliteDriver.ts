import fs from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync, StatementSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import {
  checkDatabaseName, ioError, StorageError,
  type BackendDriver, type IndexSpec, type LoadedDatabase, type StorageBackend, type StorageChange
} from '@tessera/storage-kit'
import type { DatabaseTarget, Doc, Json, SnapshotOptions } from '@tessera/types'

const EXTENSION = '.sqlite'

/** Files SQLite may keep beside a database. */
const SIDE_FILES = ['-wal', '-shm', '-journal'] as const

/** Pages copied per step of a snapshot (4 KB each); the main thread runs between steps. Node's default. */
const PAGES_PER_STEP = 100
/** The share of a snapshot's progress that is the copy; the check after it is the rest. */
const COPY_SHARE = 0.9

/**
 * The end of a snapshot, run in a worker thread because it is synchronous and took up to 190 ms at 56 MB on the main
 * thread (docs/backup-restore-design.md, Phase 0 results): leave WAL mode, so the copy is one file and reading it
 * never leaves side files beside it; write the snapshot's meta; check the copy. Given as a string (`eval`), so the
 * plugin's bundle needs no second file. The database is closed before the answer is sent, so the file is free.
 */
const FINISH_SNAPSHOT = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
let answer
try {
  const db = new DatabaseSync(workerData.file)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    const put = db.prepare('INSERT INTO tessera_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    for (const [key, value] of workerData.meta) put.run(key, value)
    const problems = db.prepare('PRAGMA quick_check').all().map(row => row.quick_check)
    answer = problems.length === 1 && problems[0] === 'ok'
      ? { ok: true }
      : { ok: false, message: 'the copy failed its check: ' + problems.slice(0, 3).join('; ') }
  } finally {
    db.close()
  }
} catch (err) {
  answer = { ok: false, message: err && err.message ? err.message : String(err) }
}
parentPort.postMessage(answer)
`

function finishSnapshot(file: string, meta: [string, string][]): Promise<void> {
  return new Promise((resolve, reject) => {
    // stderr is kept: the worker would otherwise print Node's "SQLite is experimental" warning on every snapshot
    const worker = new Worker(FINISH_SNAPSHOT, { eval: true, workerData: { file, meta }, stderr: true })
    let stderr = ''
    worker.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += String(chunk) })
    let settled = false
    worker.once('message', (answer: { ok: boolean, message?: string }) => {
      settled = true
      if (answer.ok) resolve()
      else reject(new Error(answer.message))
    })
    worker.once('error', err => { settled = true; reject(err) })
    worker.once('exit', code => {
      if (!settled) reject(new Error(`the snapshot's check stopped (exit code ${code})${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

/** Removes a file and its side files; a failure to remove is not reported, since the caller already has an error. */
function removeWithSideFiles(file: string) {
  for (const candidate of [file, ...SIDE_FILES.map(suffix => file + suffix)]) {
    try { fs.rmSync(candidate, { force: true }) } catch { /* nothing more to do */ }
  }
}

export interface SqliteDriverOptions {
  /** Where databases opened by name live. */
  directory: string
}

/**
 * Three fixed tables, so a collection name is only ever a bound value and never an SQL identifier:
 * `tessera_documents (collection, id, doc)`, `tessera_collections (name, indexes)`, `tessera_meta (key, value)`.
 * Write-through: each committed batch is one `BEGIN IMMEDIATE … COMMIT`, durable when `commit` returns, so a
 * crash leaves the previous state and `flush` has nothing to do.
 */
class SqliteBackend implements StorageBackend {
  private readonly statements = new Map<string, StatementSync>()

  private constructor(private readonly db: DatabaseSync, private readonly readOnly: boolean) {}

  static open(file: string, readOnly: boolean): SqliteBackend {
    if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file, { readOnly })
    try {
      if (!readOnly) {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA synchronous = NORMAL')
        db.exec(`
          CREATE TABLE IF NOT EXISTS tessera_documents (collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS tessera_collections (name TEXT PRIMARY KEY, indexes TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS tessera_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
          PRAGMA user_version = 1;
        `)
      }
      return new SqliteBackend(db, readOnly)
    } catch (err) {
      db.close()
      throw err
    }
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }

  async load(): Promise<LoadedDatabase> {
    const docs = new Map<string, Doc[]>()
    for (const row of this.statement('SELECT collection, doc FROM tessera_documents').all() as { collection: string, doc: string }[]) {
      const list = docs.get(row.collection) ?? []
      list.push(JSON.parse(row.doc))
      docs.set(row.collection, list)
    }
    const collections = (this.statement('SELECT name, indexes FROM tessera_collections').all() as { name: string, indexes: string }[])
      .map(row => ({ name: row.name, indexes: JSON.parse(row.indexes) as IndexSpec[], docs: docs.get(row.name) ?? [] }))
    const meta: Record<string, Json> = {}
    for (const row of this.statement('SELECT key, value FROM tessera_meta').all() as { key: string, value: string }[]) {
      meta[row.key] = JSON.parse(row.value)
    }
    return { collections, meta }
  }

  async commit(changes: StorageChange[]) {
    if (this.readOnly) throw new StorageError('READ_ONLY', 'database is read-only')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const change of changes) this.apply(change)
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* the original error is the one to report */ }
      throw err
    }
  }

  private apply(change: StorageChange) {
    switch (change.type) {
      case 'collection':
        this.statement('INSERT INTO tessera_collections (name, indexes) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET indexes = excluded.indexes')
          .run(change.name, JSON.stringify(change.indexes))
        break
      case 'drop':
        this.statement('DELETE FROM tessera_documents WHERE collection = ?').run(change.name)
        this.statement('DELETE FROM tessera_collections WHERE name = ?').run(change.name)
        break
      case 'rename':
        this.statement('UPDATE tessera_documents SET collection = ? WHERE collection = ?').run(change.to, change.from)
        this.statement('UPDATE tessera_collections SET name = ? WHERE name = ?').run(change.to, change.from)
        break
      case 'put':
        this.statement('INSERT INTO tessera_documents (collection, id, doc) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc')
          .run(change.collection, change.doc.id, JSON.stringify(change.doc))
        break
      case 'delete':
        this.statement('DELETE FROM tessera_documents WHERE collection = ? AND id = ?').run(change.collection, change.id)
        break
      case 'meta':
        if (change.value === undefined) this.statement('DELETE FROM tessera_meta WHERE key = ?').run(change.key)
        else {
          this.statement('INSERT INTO tessera_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(change.key, JSON.stringify(change.value))
        }
    }
  }

  async flush() {}

  /**
   * SQLite's online backup API (`backup()`): its steps run off the main thread, and writes made through this
   * connection meanwhile are carried into the copy, which is one committed state when it ends.
   */
  async snapshot(file: string, { meta, signal, onProgress }: SnapshotOptions) {
    const target = path.resolve(file)
    const abandoned = () => new StorageError('ABORTED', `the snapshot to ${target} was abandoned`)
    if (signal?.aborted) throw abandoned()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      // Exclusive: backup() would silently replace a database already there
      fs.closeSync(fs.openSync(target, 'wx'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('INVALID_ARGUMENT', `${target} already exists`)
      throw err
    }
    try {
      await backup(this.db, target, {
        rate: PAGES_PER_STEP,
        progress: ({ totalPages, remainingPages }) => {
          // Throwing here cancels the backup (it leaves the file, removed below)
          if (signal?.aborted) throw abandoned()
          if (totalPages > 0) onProgress?.(COPY_SHARE * (1 - remainingPages / totalPages))
        }
      })
      if (signal?.aborted) throw abandoned()
      await finishSnapshot(target, Object.entries(meta ?? {}).map(([key, value]) => [key, JSON.stringify(value)]))
      if (signal?.aborted) throw abandoned()
    } catch (err) {
      removeWithSideFiles(target)
      throw signal?.aborted ? abandoned() : err
    }
    onProgress?.(1)
  }

  async close() {
    this.statements.clear()
    this.db.close()
  }
}

/** A database's meta, read-only and without loading its documents. */
function readMetaOf(file: string): Record<string, Json> {
  if (!fs.existsSync(file)) throw new StorageError('NOT_FOUND', `there is no database at ${file}`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch (err) {
    throw ioError(`could not read ${file}`, err)
  }
  try {
    const hasMeta = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'tessera_meta'").get()
    if (!hasMeta) return {}
    const meta: Record<string, Json> = {}
    for (const row of db.prepare('SELECT key, value FROM tessera_meta').all() as { key: string, value: string }[]) {
      meta[row.key] = JSON.parse(row.value)
    }
    return meta
  } catch (err) {
    throw ioError(`could not read the meta of ${file}`, err)
  } finally {
    db.close()
  }
}

export function sqliteDriver(options: SqliteDriverOptions): BackendDriver {
  const fileOf = (target: DatabaseTarget) =>
    'name' in target ? path.join(options.directory, checkDatabaseName(target.name) + EXTENSION) : path.resolve(target.path)

  return {
    id: 'storage-sqlite',
    capabilities: { transactions: true, aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', durability: 'write-through' },
    async open(target, { readOnly }) { return SqliteBackend.open(fileOf(target), readOnly) },
    async list() {
      if (!fs.existsSync(options.directory)) return []
      return fs.readdirSync(options.directory)
        .filter(file => file.endsWith(EXTENSION))
        .map(file => file.slice(0, -EXTENSION.length))
        .sort()
    },
    async readMeta(target) { return readMetaOf(fileOf(target)) },
    async drop(target) {
      const file = fileOf(target)
      for (const candidate of [file, ...SIDE_FILES.map(suffix => file + suffix)]) fs.rmSync(candidate, { force: true })
    }
  }
}
