import type { AppState, Collection, Database, Json, StorageEngine } from '@tessera/types'

/** One document per key: `{ id: key, value }`. */
type Entry = { value: Json }

/** The application's own database, apart from any vault. */
const DATABASE = 'app'
const COLLECTION = 'app-state.entries'

export class AppStateStore implements AppState {
  private db!: Database
  private entries!: Collection<Entry>

  constructor(private readonly engine: StorageEngine) {}

  async init() {
    this.db = await this.engine.open({ name: DATABASE })
    this.entries = this.db.collection<Entry>(COLLECTION)
  }

  /** Never writes: a missing key yields the default without storing it. */
  async get<T>(key: string, defaultFn?: () => T): Promise<T | undefined> {
    const entry = await this.entries.get(key)
    if (entry) return entry.value as T
    return defaultFn?.()
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.entries.replace({ id: key, value: value as Json }, { upsert: true })
  }

  async update<T>(key: string, patch: Partial<T>): Promise<void> {
    await this.db.transaction(async tx => {
      const entries = tx.collection<Entry>(COLLECTION)
      const existing = await entries.get(key)
      const next = { ...(existing?.value as object ?? {}), ...patch } as Json
      await entries.replace({ id: key, value: next }, { upsert: true })
    })
  }

  async remove(key: string): Promise<void> {
    await this.entries.deleteOne({ id: key })
  }

  async flush(): Promise<void> {
    await this.db.flush()
  }
}
