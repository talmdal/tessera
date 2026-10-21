import { AppState, StorageEngine } from "@tessera/types"
import { TransactionManager } from "../../../../core/storage/TransactionManager"

type Result<T> = {key: string, value: T}

export class AppStateStore implements AppState {
  private trxMgr: TransactionManager
  constructor(private storage: StorageEngine) {
    this.trxMgr = new TransactionManager(storage)
  }

  async init() {
    const exists = await this.storage.getOne('app.state', { key: '__init__' })
    if (!exists) {
      await this.storage.insert('app.state', { key: '__init__', value: true })
    }
  }

  async get<T>(key: string, defaultFn?: () => T): Promise<T | undefined> {
    const entry = (await this.storage.getOne('app.state', { key })) as Result<T>
    if (entry) return entry.value

    if (!defaultFn) return undefined

    const value = defaultFn()
    await this.trxMgr.run(async tx => {
      await tx.insert('app.state', { key, value })
    })
    return value
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.trxMgr.run(async tx => {
      await tx.upsert('app.state', { key }, { key, value })
    })
  }

  async update<T>(key: string, patch: Partial<T>): Promise<void> {
    await this.trxMgr.run(async tx => {
      const existing = await tx.getOne<{ key: string; value: T }>('app.state', { key })
      const next = { ...(existing?.value ?? {}), ...patch }
      await tx.upsert('app.state', { key }, { key, value: next })
    })
  }

  async remove(key: string): Promise<void> {
    await this.trxMgr.run(async tx => {
      await tx.delete('app.state', { key })
    })
  }

  async flush(): Promise<void> {
    // Loki autosave handles this; hook exists for future engines
  }
}
