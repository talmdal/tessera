export interface StorageEngine {
  init(): Promise<void>

  listCollections(): Promise<string[]>

  get<T>(collection: string, query: Query): Promise<T[]>

  getOne<T>(collection: string, query: Query): Promise<T | null>

  insert<T>(collection: string, doc: T): Promise<void>

  upsert<T>(collection: string, query: Query, doc: T): Promise<void>

  update<T>(collection: string, query: Query, update: Partial<T>): Promise<number>

  delete(collection: string, query: Query): Promise<number>

  close(): Promise<void>

  capabilities(): StorageEngineCapabilities

  /** A transaction to commit or roll back yourself. Prefer `transaction`, which also serialises them. */
  beginTransaction(): Promise<StorageTransaction>

  /**
   * Runs `fn` in a transaction, committing when it resolves and rolling back
   * when it throws. Transactions run one at a time: each starts from a
   * snapshot, so two that overlapped would each commit a state without the
   * other's changes. Rejects if the engine does not support transactions.
   */
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>
}

export type Query =
  | { [key: string]: any }
  | ((doc: any) => boolean)

export interface StorageEngineCapabilities {
  transactions: boolean
}

export interface StorageTransaction {
  get<T>(collection: string, query: Query): Promise<T[]>
  getOne<T>(collection: string, query: Query): Promise<T | null>
  insert<T>(collection: string, doc: T): Promise<void>
  upsert<T>(collection: string, query: Query, doc: T): Promise<void>
  update<T>(collection: string, query: Query, update: Partial<T>): Promise<number>
  delete(collection: string, query: Query): Promise<number>

  commit(): Promise<void>
  rollback(): Promise<void>
}
