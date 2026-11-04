import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  checkDatabaseName, StorageError,
  type BackendDriver, type IndexSpec, type LoadedDatabase, type StorageBackend, type StorageChange
} from '@tessera/storage-kit'
import type { DatabaseTarget, Doc, Json } from '@tessera/types'

const EXTENSION = '.sqlite'

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

  async close() {
    this.statements.clear()
    this.db.close()
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
    async drop(target) {
      const file = fileOf(target)
      for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(candidate, { force: true })
    }
  }
}
