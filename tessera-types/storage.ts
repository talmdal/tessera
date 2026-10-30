// The storage engine contract: a document database in the MongoDB style.
// An engine opens named databases, a database holds named collections, a
// collection holds JSON documents with a string `id` and an engine-maintained
// `rev`. Queries, updates and aggregations are plain data, so every backend
// can answer them and they can be logged, tested and carried over IPC.
//
// Design: docs/storage-engine-design.md. The shared evaluators a backend can
// build on live in core/storage/; the conformance suite every backend must
// pass is tests/storage/conformance.ts.

import { Disposable } from '.'

// ---------------------------------------------------------------------------
// Documents

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/**
 * What callers write. `id` is optional on insert (the engine assigns a ULID)
 * and required everywhere else. `rev` is owned by the engine: it is ignored
 * on insert and may not be set by an update.
 */
export interface Document {
  id?: string
  rev?: number
  [field: string]: Json | undefined
}

/** What the engine returns: the document plus its identity and revision. */
export type Stored<T extends Document = Document> = T & { id: string, rev: number }

// ---------------------------------------------------------------------------
// Engine

export type DatabaseTarget = { name: string } | { path: string }

export interface StorageEngine {
  /** Backend id: 'memory', 'loki', 'sqlite'. */
  readonly id: string
  capabilities(): StorageCapabilities
  /**
   * Opens a database, creating it if absent. A name is resolved under the
   * engine's storage folder; a path is used as given (a vault file). Opening
   * a database that is already open returns the same handle.
   */
  open(target: DatabaseTarget, options?: OpenOptions): Promise<Database>
  /** Names of the databases under the engine's storage folder (open or not). */
  list(): Promise<string[]>
  /** Closes the database if open and deletes it. */
  drop(target: DatabaseTarget): Promise<void>
  /** A new sortable unique id (ULID). */
  newId(): string
  /** Closes every open database. The providing plugin calls this on shutdown. */
  closeAll(): Promise<void>
}

export interface OpenOptions {
  /** Every write fails with READ_ONLY. */
  readOnly?: boolean
  /**
   * Collections and indexes to ensure before `open` resolves. When given,
   * `autoCreate` defaults to false, so a typo in a collection name is an
   * UNKNOWN_COLLECTION error rather than a new collection.
   */
  schema?: CollectionSchema[]
  /** Create a collection on its first write. Defaults to true without `schema`, false with it. */
  autoCreate?: boolean
}

/**
 * Every operator and stage in this contract works on every backend: what a
 * backend can't evaluate natively, the shared kit in core/storage/ emulates
 * over a scan. Capabilities therefore never gate a feature; they say what is
 * fast, so a caller (or a test) can tell native from emulated.
 */
export interface StorageCapabilities {
  /** $group, $lookup and the rest: evaluated by the backend or by the shared interpreter. */
  aggregate: 'native' | 'emulated'
  /** $regex: backend regex support or the shared evaluator. */
  regex: 'native' | 'emulated'
  /** $text: a full-text index (SQLite FTS5, later) or word matching over a scan. */
  textSearch: 'native' | 'emulated'
  /** Write-through backends commit to disk on every transaction; buffered ones need flush(). */
  writeThrough: boolean
}

// ---------------------------------------------------------------------------
// Database

export interface Database {
  /** The name or path it was opened with. */
  readonly name: string
  /** Backend id. */
  readonly engine: string
  readonly isOpen: boolean
  readonly readOnly: boolean

  /** A handle; touches nothing until used. */
  collection<T extends Document = Document>(name: string): Collection<T>
  listCollections(): Promise<CollectionInfo[]>
  /** Creates the collection, or ensures the indexes if it exists. */
  createCollection(schema: CollectionSchema): Promise<void>
  /** Resolves false if there was no such collection. */
  dropCollection(name: string): Promise<boolean>
  renameCollection(from: string, to: string): Promise<void>

  /**
   * Runs `work` atomically: every write in it is visible to later reads in
   * it, none is visible outside until it commits, and none survives if it
   * throws. Transactions on one database run one at a time. A write made
   * outside a transaction while one is running (through `db.collection(...)`
   * rather than `tx.collection(...)`) makes the transaction fail with
   * CONFLICT at commit.
   */
  transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R>

  /**
   * Fires after a commit, once per collection and kind of change, never for
   * rolled-back work. A write outside a transaction counts as a transaction
   * of one.
   */
  onDidChange(listener: (event: ChangeEvent) => void): Disposable

  /** Per-database key/value bookkeeping, e.g. schema versions. Not transactional. */
  readonly meta: DatabaseMeta

  /** Writes buffered changes. No-op for write-through backends. */
  flush(): Promise<void>
  close(): Promise<void>
}

export interface DatabaseMeta {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
}

export interface Transaction {
  collection<T extends Document = Document>(name: string): Collection<T>
}

export interface ChangeEvent {
  database: string
  collection: string
  kind: 'insert' | 'update' | 'delete'
  ids: string[]
}

// ---------------------------------------------------------------------------
// Collections

export interface IndexSpec {
  name: string
  fields: string[]
  unique?: boolean
}

export interface CollectionSchema {
  name: string
  indexes?: IndexSpec[]
}

export interface CollectionInfo {
  name: string
  indexes: IndexSpec[]
  count: number
}

export interface Collection<T extends Document = Document> {
  readonly name: string

  // Reads. Every document returned is a copy: editing it changes nothing
  // until it is written back.

  get(id: string): Promise<Stored<T> | undefined>
  /** Same order as `ids`; undefined where there is no such document. */
  getMany(ids: string[]): Promise<(Stored<T> | undefined)[]>
  findOne(filter?: Filter, options?: FindOneOptions): Promise<Stored<T> | undefined>
  find(filter?: Filter, options?: FindOptions): Promise<Stored<T>[]>
  /**
   * Cursor pagination. `next` is an opaque cursor for the page after this
   * one, absent on the last page. The order is `sort` then `id`, so pages
   * stay correct while documents are inserted or deleted.
   */
  findPage(filter: Filter | undefined, options: PageOptions): Promise<Page<Stored<T>>>
  count(filter?: Filter): Promise<number>
  /** The whole collection, in id order, for migrations and exports. */
  scan(options?: { batchSize?: number }): AsyncIterable<Stored<T>>

  // Writes. Each resolves after the write is durable for a write-through
  // backend, or buffered for a buffered one.

  /** Assigns an id if absent; DUPLICATE_ID if the id exists. */
  insert(doc: T): Promise<Stored<T>>
  /** All or nothing. */
  insertMany(docs: T[]): Promise<Stored<T>[]>
  /**
   * Replaces the whole document. NOT_FOUND unless `upsert`; CONFLICT if
   * `expectedRev` is given and differs from the stored rev.
   */
  replace(doc: T & { id: string }, options?: ReplaceOptions): Promise<Stored<T>>
  /** Applies `update` to the first match (in id order). With `upsert`, inserts from the filter's equalities plus the update when nothing matches. */
  updateOne(filter: Filter, update: Update, options?: { upsert?: boolean }): Promise<UpdateResult>
  updateMany(filter: Filter, update: Update): Promise<UpdateResult>
  /** Resolves the number deleted (0 or 1). */
  deleteOne(filter: Filter): Promise<number>
  deleteMany(filter: Filter): Promise<number>

  // Reporting

  aggregate<R extends JsonObject = JsonObject>(pipeline: Stage[]): Promise<R[]>

  // Schema. Index changes are not transactional: inside transaction() they are INVALID_ARGUMENT.

  ensureIndex(index: IndexSpec): Promise<void>
  dropIndex(name: string): Promise<void>
  indexes(): Promise<IndexSpec[]>
  /** The backend's plan for a query: which index it would use, whether it scans. Free-form, for tests and diagnostics. */
  explain(filter?: Filter, options?: FindOptions): Promise<Json>
}

export type Sort = { [field: string]: 1 | -1 }

/** `{ a: 1, b: 1 }` keeps a and b (and id unless `id: 0`); `{ a: 0 }` drops a. Not both. */
export type Projection = { [field: string]: 0 | 1 }

export interface FindOneOptions {
  sort?: Sort
  skip?: number
  projection?: Projection
}

export interface FindOptions extends FindOneOptions {
  limit?: number
}

export interface PageOptions {
  sort?: Sort
  limit: number
  /** The `next` of the previous page. */
  after?: string
  projection?: Projection
}

export interface Page<T> {
  items: T[]
  next?: string
}

export interface ReplaceOptions {
  expectedRev?: number
  upsert?: boolean
}

export interface UpdateResult {
  matched: number
  /** Documents whose content actually changed (and whose rev was bumped). */
  modified: number
  upsertedId?: string
}

// ---------------------------------------------------------------------------
// Filters: a closed subset of the MongoDB query language, as data.

/**
 * A field condition is a literal (deep equality) or an object of operators.
 * Field paths may be dotted. An object literal without `$` keys is compared
 * whole, so `{ address: { city: 'X' } }` matches only exactly that object;
 * use `'address.city'` to match a field inside it.
 */
export type FieldFilter = { [field: string]: Json | FieldOperators }

export interface FieldOperators {
  $eq?: Json
  $ne?: Json
  /** Comparisons apply between values of the same JSON type; anything else is false. Strings compare lexically. */
  $gt?: Json
  $gte?: Json
  $lt?: Json
  $lte?: Json
  $in?: Json[]
  $nin?: Json[]
  /** True when the field is present (even if null). */
  $exists?: boolean
  /** Pattern as a string (not a RegExp), with optional flags in `$options`. Non-strings never match. */
  $regex?: string
  $options?: string
  /** The field is an array containing a value deep-equal to this. */
  $contains?: Json
}

/**
 * Full-text search. Every whitespace-separated term in `$search` must occur
 * as a whole word, case-insensitively, in at least one of `$fields`.
 * Ranking is not part of the contract.
 */
export interface TextFilter {
  $text: { $search: string, $fields: string[] }
}

export type Filter =
  | FieldFilter
  | { $and: Filter[] }
  | { $or: Filter[] }
  | { $not: Filter }
  | TextFilter

// ---------------------------------------------------------------------------
// Updates: operators only. A bare object is INVALID_UPDATE, so replace and
// patch can't be confused. `id` and `rev` may not be touched.

export interface Update {
  $set?: { [field: string]: Json }
  $unset?: { [field: string]: true }
  /** Missing fields start at 0; a non-numeric value is INVALID_UPDATE. */
  $inc?: { [field: string]: number }
  /** Appends; a missing field becomes a one-element array; a non-array is INVALID_UPDATE. */
  $push?: { [field: string]: Json }
  /** Removes every element deep-equal to the value. */
  $pull?: { [field: string]: Json }
}

// ---------------------------------------------------------------------------
// Aggregation: the reporting surface. A pipeline is evaluated either by the
// backend (SQLite: one SELECT) or by the shared interpreter over a scan.

export type Stage =
  | { $match: Filter }
  | { $project: { [field: string]: 0 | 1 | Expression } }
  | { $group: GroupStage }
  | { $sort: Sort }
  | { $skip: number }
  | { $limit: number }
  /** One output document per element of the named array field ('$splits'). Documents without the array, or with an empty one, are dropped. */
  | { $unwind: string }
  /** Adds `as`: the documents of `from` (same database) whose `foreignField` equals this document's `localField`. */
  | { $lookup: { from: string, localField: string, foreignField: string, as: string } }
  /** Replaces the stream with one document, `{ [name]: count }`. */
  | { $count: string }

export interface GroupStage {
  /** The grouping key: an expression, or null for one group. */
  _id: Expression | null
  [output: string]: Accumulator | Expression | null
}

/**
 * A field reference ('$amount', '$account.name'), a literal, or an operator.
 * An object or array literal is a literal unless it holds an operator key.
 */
export type Expression =
  | Json
  | { $substr: [Expression, number, number] }
  | { $concat: Expression[] }
  | { $add: Expression[] }
  | { $subtract: [Expression, Expression] }
  | { $multiply: Expression[] }
  | { $divide: [Expression, Expression] }
  | { $abs: Expression }
  | { $ifNull: [Expression, Expression] }
  /** `[filter, then, else]`: the filter is applied to the current document. */
  | { $cond: [Filter, Expression, Expression] }
  /** On ISO date strings ('2026-01-16' or a full timestamp). */
  | { $year: Expression }
  | { $month: Expression }

export type Accumulator =
  | { $sum: Expression }
  | { $avg: Expression }
  | { $min: Expression }
  | { $max: Expression }
  | { $count: Record<string, never> }
  | { $first: Expression }
  | { $last: Expression }
  | { $push: Expression }

// ---------------------------------------------------------------------------
// Errors

export type StorageErrorCode =
  | 'NOT_OPEN'
  | 'READ_ONLY'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_ID'
  | 'UNIQUE_VIOLATION'
  | 'UNKNOWN_COLLECTION'
  | 'UNSUPPORTED_QUERY'
  | 'INVALID_DOCUMENT'
  | 'INVALID_UPDATE'
  | 'INVALID_ARGUMENT'
  | 'IO'

/** Every error a storage engine throws has a stable `code`; the message is for people. */
export interface StorageErrorLike extends Error {
  readonly code: StorageErrorCode
  readonly details?: JsonObject
}
