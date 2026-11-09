import type { Database, DatabaseTarget, Json, OpenOptions, StorageCapabilities, StorageEngine } from '@tessera/types'
import type { BackendDriver } from './backend'
import { KitDatabase } from './database'
import { ioError, StorageError } from './errors'
import { ulid } from './ulid'

/** A name that is safe to use as a file name on any platform. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/

export function checkDatabaseName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new StorageError('INVALID_ARGUMENT', `"${String(name)}" is not a valid database name (letters, digits, "." "_" "-" and spaces)`)
  }
  return name
}

const keyOf = (target: DatabaseTarget) => {
  if ('name' in target) return `name:${checkDatabaseName(target.name)}`
  if (typeof target.path !== 'string' || target.path === '') throw new StorageError('INVALID_ARGUMENT', 'a database path must be a non-empty string')
  return `path:${target.path}`
}

/** The StorageEngine for any driver: tracks open databases and wraps each driver backend in a KitDatabase. */
export class KitStorageEngine implements StorageEngine {
  private readonly open_ = new Map<string, Promise<Database>>()

  constructor(private readonly driver: BackendDriver) {}

  get id() { return this.driver.id }

  capabilities(): StorageCapabilities { return this.driver.capabilities }

  async open(target: DatabaseTarget, options: OpenOptions = {}): Promise<Database> {
    const key = keyOf(target)
    const existing = this.open_.get(key)
    if (existing) return existing

    const opening = (async () => {
      const backend = await this.driver.open(target, { readOnly: Boolean(options.readOnly) })
        .catch(err => { throw ioError(`could not open database "${'name' in target ? target.name : target.path}"`, err) })
      return KitDatabase.open(backend, {
        ...options,
        name: 'name' in target ? target.name : target.path,
        newId: () => ulid(),
        onClosed: () => { this.open_.delete(key) }
      })
    })()
    this.open_.set(key, opening)
    opening.catch(() => { if (this.open_.get(key) === opening) this.open_.delete(key) })
    return opening
  }

  /** Databases on disk plus any opened by name that a buffering backend hasn't written yet. */
  async list() {
    const names = new Set(await this.driver.list())
    for (const key of this.open_.keys()) if (key.startsWith('name:')) names.add(key.slice(5))
    return [...names].sort()
  }

  /** An open database answers from memory (what it holds may not be on disk yet); any other goes to the driver. */
  async readMeta(target: DatabaseTarget): Promise<Record<string, Json>> {
    const open = this.open_.get(keyOf(target))
    if (open) {
      const db = await open.catch(() => undefined)
      if (db instanceof KitDatabase) {
        try { return db.metaCopy() } catch { /* closed meanwhile: read what it left */ }
      }
    }
    try {
      return await this.driver.readMeta(target)
    } catch (err) {
      throw ioError(`could not read the meta of database "${'name' in target ? target.name : target.path}"`, err)
    }
  }

  async drop(target: DatabaseTarget) {
    const open = this.open_.get(keyOf(target))
    if (open) await (await open).close()
    await this.driver.drop(target)
  }

  newId() { return ulid() }

  async closeAll() {
    const errors: unknown[] = []
    for (const opening of [...this.open_.values()]) {
      try { await (await opening).close() } catch (err) { errors.push(err) }
    }
    if (errors.length > 0) throw errors[0]
  }
}
