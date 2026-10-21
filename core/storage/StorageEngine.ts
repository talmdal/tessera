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

  beginTransaction(): Promise<StorageTransaction>
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
