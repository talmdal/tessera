// plugins/app.state/src/privileged/AppStateStore.ts
//
// Application state (window bounds, sidebar, the shell's theme preference)
// as documents in the `app` database: collection `app-state.entries`, one
// document per key, `{ id: key, value }`.
import type { AppState, Collection, Database, Document, Json, StorageEngine } from '@tessera/types'

export const APP_DATABASE = 'app'
export const ENTRIES = 'app-state.entries'

interface Entry extends Document {
  id: string
  value: Json
}

export class AppStateStore implements AppState {
  private db!: Database
  private entries!: Collection<Entry>

  constructor(private readonly engine: StorageEngine) {}

  async init() {
    this.db = await this.engine.open({ name: APP_DATABASE })
    this.entries = this.db.collection<Entry>(ENTRIES)
  }

  /** The stored value, or the default (which is returned, not stored). */
  async get<T>(key: string, defaultFn?: () => T): Promise<T | undefined> {
    const entry = await this.entries.get(key)
    if (entry) return entry.value as T
    return defaultFn?.()
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.entries.replace({ id: key, value: value as Json }, { upsert: true })
  }

  /** Merges `patch` into the stored object (or into {} if nothing, or a non-object, is stored). */
  async update<T>(key: string, patch: Partial<T>): Promise<void> {
    await this.db.transaction(async tx => {
      const entries = tx.collection<Entry>(ENTRIES)
      const existing = (await entries.get(key))?.value
      const base = typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {}
      await entries.replace({ id: key, value: { ...base, ...(patch as Json & object) } }, { upsert: true })
    })
  }

  async remove(key: string): Promise<void> {
    await this.entries.deleteOne({ id: key })
  }

  /** Writes buffered changes; called on shutdown. Nothing to do once the engine has closed the database. */
  async flush(): Promise<void> {
    if (this.db.isOpen) await this.db.flush()
  }
}
