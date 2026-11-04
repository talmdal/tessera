// The `storage.engine` service contract: a document database in the MongoDB style.
// An engine opens named databases, a database holds named collections, a collection holds JSON
// documents with a string `id`. Queries, updates and aggregations are plain data, so any backend
// can answer them. See docs/storage-engine-redesign.md.
import type { Disposable } from '.'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** A stored document: what the caller wrote, plus the `id` and `rev` the engine maintains. */
export type Doc<T extends object = JsonObject> = T & { id: string, rev: number }

/** A document to insert: `id` is generated when omitted; `rev` is the engine's. */
export type NewDoc<T extends object = JsonObject> = T & { id?: string }

// ---- Queries -------------------------------------------------------------------------------

export interface Operators {
  $eq?: Json; $ne?: Json
  $gt?: Json; $gte?: Json; $lt?: Json; $lte?: Json
  $in?: Json[]; $nin?: Json[]
  $exists?: boolean
  /** Pattern as a string (not a RegExp), with optional flags. */
  $regex?: string; $options?: string
  /** The array field contains the value. */
  $contains?: Json
}

export type FieldFilter = { [field: string]: Json | Operators | undefined }

/** Case-insensitive whole-word search for every term of `$search` over the named fields. */
export type TextFilter = { $text: { $search: string, $fields: string[] } }

export type Filter = FieldFilter | { $and: Filter[] } | { $or: Filter[] } | { $not: Filter } | TextFilter

export type Sort = { [field: string]: 1 | -1 }

export interface Update {
  $set?: { [field: string]: Json }
  $unset?: { [field: string]: true }
  $inc?: { [field: string]: number }
  $push?: { [field: string]: Json }
  $pull?: { [field: string]: Json }
}

// ---- Aggregation ---------------------------------------------------------------------------

export type Expression =
  | `$${string}`
  | Json
  | { $substr: [Expression, number, number] }
  | { $concat: Expression[] }
  | { $add: Expression[] } | { $subtract: [Expression, Expression] }
  | { $multiply: Expression[] } | { $divide: [Expression, Expression] }
  | { $abs: Expression } | { $ifNull: [Expression, Expression] }
  | { $cond: [Filter, Expression, Expression] }
  | { $year: Expression } | { $month: Expression }

export type Accumulator =
  | { $sum: Expression } | { $avg: Expression } | { $min: Expression } | { $max: Expression }
  | { $count: {} } | { $first: Expression } | { $last: Expression } | { $push: Expression }

export type Stage =
  | { $match: Filter }
  | { $project: { [field: string]: 0 | 1 | Expression } }
  | { $group: { _id: Expression | null, [output: string]: Accumulator | Expression | null } }
  | { $sort: Sort }
  | { $skip: number }
  | { $limit: number }
  | { $unwind: string }
  | { $lookup: { from: string, localField: string, foreignField: string, as: string } }
  | { $count: string }

// ---- Collections ---------------------------------------------------------------------------

export interface IndexDefinition {
  /** Defaults to the fields joined with `+`. */
  name?: string
  fields: string[]
  /** Sparse: a document missing any of the fields is not entered, so optional keys don't collide. */
  unique?: boolean
}

export interface FindOptions { sort?: Sort, skip?: number, limit?: number }

export interface PageOptions { sort?: Sort, limit: number, cursor?: string }
export interface Page<T> { items: T[], nextCursor?: string }

export interface WriteOptions {
  /** The write fails with CONFLICT unless the document is at this revision. */
  expectedRev?: number
}
export interface ReplaceOptions extends WriteOptions { upsert?: boolean }
export interface UpdateOptions extends WriteOptions { upsert?: boolean }

export interface UpdateResult { matched: number, modified: number, upsertedId?: string }
export interface DeleteResult { deleted: number }

export interface QueryPlan { strategy: 'id' | 'index' | 'scan', index?: string }

/**
 * Documents returned are copies: editing one changes nothing until it is written back. `id` and `rev`
 * are the only fields the engine adds.
 */
export interface Collection<T extends object = JsonObject> {
  readonly name: string

  get(id: string): Promise<Doc<T> | undefined>
  getMany(ids: string[]): Promise<Doc<T>[]>
  findOne(filter?: Filter, options?: { sort?: Sort }): Promise<Doc<T> | undefined>
  /** Without `sort`, in id order; any sort ends with `id` ascending as a tie-break. */
  find(filter?: Filter, options?: FindOptions): Promise<Doc<T>[]>
  findPage(filter: Filter | undefined, options: PageOptions): Promise<Page<Doc<T>>>
  count(filter?: Filter): Promise<number>
  /** Batches of matches in id order, for reads too large for one array. */
  scan(filter?: Filter, options?: { batchSize?: number }): AsyncIterable<Doc<T>[]>

  insert(doc: NewDoc<T>): Promise<Doc<T>>
  insertMany(docs: NewDoc<T>[]): Promise<Doc<T>[]>
  /** Replaces the whole document with the same `id`. */
  replace(doc: NewDoc<T> & { id: string }, options?: ReplaceOptions): Promise<Doc<T>>
  updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult>
  updateMany(filter: Filter, update: Update): Promise<UpdateResult>
  deleteOne(filter: Filter, options?: WriteOptions): Promise<DeleteResult>
  deleteMany(filter?: Filter): Promise<DeleteResult>

  aggregate<R = JsonObject>(pipeline: Stage[]): Promise<R[]>

  /** Index changes are not transactional: inside `transaction()` they are INVALID_ARGUMENT. */
  ensureIndex(index: IndexDefinition): Promise<string>
  dropIndex(name: string): Promise<void>
  indexes(): Promise<Required<IndexDefinition>[]>
  explain(filter?: Filter): Promise<QueryPlan>
}

export interface Transaction {
  collection<T extends object = JsonObject>(name: string): Collection<T>
}

// ---- Databases -----------------------------------------------------------------------------

export interface CollectionSchema {
  name: string
  indexes?: IndexDefinition[]
}

export type DocumentChangeType = 'insert' | 'update' | 'delete'

export interface ChangeEvent {
  changes: { collection: string, id: string, type: DocumentChangeType }[]
  /** Collections created, dropped or renamed. */
  structure: { collection: string, type: 'create' | 'drop' | 'rename', renamedTo?: string }[]
}

/** Plain key/value bookkeeping (schema versions and the like). Not transactional. */
export interface DatabaseMeta {
  get<T extends Json = Json>(key: string): Promise<T | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
}

export interface Database {
  readonly name: string
  readonly readOnly: boolean
  collection<T extends object = JsonObject>(name: string): Collection<T>
  listCollections(): Promise<string[]>
  createCollection(schema: CollectionSchema): Promise<void>
  dropCollection(name: string): Promise<void>
  renameCollection(from: string, to: string): Promise<void>
  /**
   * Atomic: nothing is written unless `work` completes, and writers are serialised per database. Writes made
   * through `db.collection(...)` instead of `tx.collection(...)` are applied at once; if the transaction wrote
   * the same collection it fails with CONFLICT at commit, so neither write is silently lost.
   */
  transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R>
  /** Called once per committed transaction (or single write), after commit. */
  onDidChange(listener: (event: ChangeEvent) => void): Disposable
  readonly meta: DatabaseMeta
  /** Makes everything written so far durable. A failure is an IO error and the data stays dirty. */
  flush(): Promise<void>
  close(): Promise<void>
}

export type DatabaseTarget =
  /** Stored under the engine's own directory. */
  | { name: string }
  /** A file the user chose, e.g. a vault. */
  | { path: string }

export interface OpenOptions {
  readOnly?: boolean
  /**
   * Declares the collections. When given, a collection not in it is rejected with UNKNOWN_COLLECTION, which
   * is what stops a typo creating one; when omitted collections are created on first write.
   */
  schema?: CollectionSchema[]
}

export type Support = 'native' | 'emulated'

export interface StorageCapabilities {
  transactions: true
  /** Speed, not availability: every operator and stage works on every backend. */
  aggregate: Support
  regex: Support
  textSearch: Support
  durability: 'write-through' | 'buffered' | 'none'
}

/** The service `storage.engine`: exactly one plugin provides it. */
export interface StorageEngine {
  readonly id: string
  capabilities(): StorageCapabilities
  /** Opening a database that is already open returns the open one. */
  open(target: DatabaseTarget, options?: OpenOptions): Promise<Database>
  /** Names of the databases kept under the engine's own directory. */
  list(): Promise<string[]>
  drop(target: DatabaseTarget): Promise<void>
  /** A new time-ordered unique id (ULID). */
  newId(): string
  closeAll(): Promise<void>
}

// ---- Errors --------------------------------------------------------------------------------

export type StorageErrorCode =
  | 'NOT_OPEN' | 'READ_ONLY' | 'CONFLICT' | 'DUPLICATE_ID' | 'UNIQUE_VIOLATION'
  | 'UNKNOWN_COLLECTION' | 'UNSUPPORTED_QUERY' | 'INVALID_DOCUMENT' | 'INVALID_UPDATE'
  | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'IO'

/** Every error the engine throws carries one of these codes. */
export interface StorageErrorLike extends Error {
  readonly code: StorageErrorCode
}
