// core/storage/kit/KitCollection.ts
//
// The Collection implementation every backend shares. All semantics live
// here (validation, filters, updates, paging, aggregation, unique indexes);
// a backend supplies DocumentStores through a Scope and persists them.
import type {
  Collection,
  Document,
  Filter,
  FindOneOptions,
  FindOptions,
  IndexSpec,
  Json,
  JsonObject,
  Page,
  PageOptions,
  ReplaceOptions,
  Stage,
  Stored,
  Update,
  UpdateResult
} from '@tessera/types'
import { runPipeline } from '../aggregate'
import { compareToCursor, decodeCursor, encodeCursor } from '../cursor'
import { normalizeDocument, sameIndex, validateCollectionName, validateIndexSpec } from '../documents'
import { StorageError, invalidArgument, invalidDocument } from '../errors'
import { compileFilter, filterEqualities, filterFields } from '../filter'
import { cloneJson, setPath } from '../json'
import { compileProjection } from '../projection'
import { compileSort, sortFields } from '../sort'
import { ulid } from '../ulid'
import { applyUpdate } from '../update'
import { type DocumentStore, buildUnique, put, remove } from './DocumentStore'

export type ChangeKind = 'insert' | 'update' | 'delete'

/** What a collection handle needs from its owner: a live database or a transaction. */
export interface Scope {
  readonly database: string
  readonly engine: string
  readonly inTransaction: boolean
  /** The store to read, or undefined for a collection that doesn't exist yet. Throws NOT_OPEN / UNKNOWN_COLLECTION. */
  read(name: string): DocumentStore | undefined
  /** The store to write, created if allowed. Throws NOT_OPEN / READ_ONLY / UNKNOWN_COLLECTION. */
  write(name: string): DocumentStore
  /** Records a change to be announced after commit. */
  changed(name: string, kind: ChangeKind, ids: string[]): void
  /** Runs after a direct (non-transactional) write; a no-op inside a transaction. */
  committed(name: string): void
  /** The backend's answer to explain(); the kit adds what it knows. */
  plan?(name: string, filter: Filter | undefined, options: FindOptions): JsonObject
}

export class KitCollection<T extends Document> implements Collection<T> {
  constructor(readonly name: string, private readonly scope: Scope) {
    validateCollectionName(name)
  }

  private docs(): JsonObject[] {
    return [...(this.scope.read(this.name)?.values() ?? [])]
  }

  private out(doc: JsonObject): Stored<T> {
    return cloneJson(doc) as unknown as Stored<T>
  }

  private present(doc: JsonObject, project: (doc: JsonObject) => JsonObject): Stored<T> {
    return project(cloneJson(doc)) as unknown as Stored<T>
  }

  private matching(filter: Filter | undefined): JsonObject[] {
    const predicate = compileFilter(filter)
    return this.docs().filter(predicate)
  }

  private ordered(filter: Filter | undefined, options: FindOptions = {}): JsonObject[] {
    const { sort, skip = 0, limit } = options
    if (!Number.isInteger(skip) || skip < 0) throw invalidArgument('skip must be a non-negative integer')
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw invalidArgument('limit must be a non-negative integer')
    const docs = this.matching(filter).sort(compileSort(sort))
    return docs.slice(skip, limit === undefined ? undefined : skip + limit)
  }

  // Reads

  async get(id: string) {
    const doc = this.scope.read(this.name)?.get(id)
    return doc && this.out(doc)
  }

  async getMany(ids: string[]) {
    const store = this.scope.read(this.name)
    return ids.map(id => {
      const doc = store?.get(id)
      return doc && this.out(doc)
    })
  }

  async findOne(filter?: Filter, options: FindOneOptions = {}) {
    const [doc] = this.ordered(filter, { ...options, limit: 1 })
    return doc && this.present(doc, compileProjection(options.projection))
  }

  async find(filter?: Filter, options: FindOptions = {}) {
    const project = compileProjection(options.projection)
    return this.ordered(filter, options).map(doc => this.present(doc, project))
  }

  async findPage(filter: Filter | undefined, options: PageOptions): Promise<Page<Stored<T>>> {
    const { sort, limit, after } = options
    if (!Number.isInteger(limit) || limit < 1) throw invalidArgument('findPage needs a positive limit')
    let docs = this.matching(filter).sort(compileSort(sort))
    if (after !== undefined) {
      const keys = decodeCursor(after, sort)
      docs = docs.filter(doc => compareToCursor(doc, keys, sort) > 0)
    }
    const page = docs.slice(0, limit)
    const project = compileProjection(options.projection)
    return {
      items: page.map(doc => this.present(doc, project)),
      ...(docs.length > limit ? { next: encodeCursor(page[page.length - 1], sort) } : {})
    }
  }

  async count(filter?: Filter) {
    return this.matching(filter).length
  }

  async *scan(options: { batchSize?: number } = {}): AsyncIterable<Stored<T>> {
    const batchSize = options.batchSize ?? 500
    const snapshot = this.docs().sort(compileSort(undefined))
    for (let i = 0; i < snapshot.length; i += batchSize) {
      for (const doc of snapshot.slice(i, i + batchSize)) yield this.out(doc)
    }
  }

  // Writes

  private insertInto(store: DocumentStore, doc: T): JsonObject {
    const clean = normalizeDocument(doc)
    const id = (clean.id as string | undefined) ?? ulid()
    if (store.get(id)) throw new StorageError('DUPLICATE_ID', `${this.name} already has a document with id ${id}`, { collection: this.name, id })
    const stored = { ...clean, id, rev: 1 }
    put(store, this.name, id, stored)
    return stored
  }

  async insert(doc: T) {
    const store = this.scope.write(this.name)
    const stored = this.insertInto(store, doc)
    this.scope.changed(this.name, 'insert', [stored.id as string])
    this.scope.committed(this.name)
    return this.out(stored)
  }

  async insertMany(docs: T[]) {
    if (!Array.isArray(docs)) throw invalidArgument('insertMany needs an array')
    const store = this.scope.write(this.name)
    // All or nothing: validate and apply against a scratch copy, then adopt it.
    const scratch = store.snapshot()
    const stored = docs.map(doc => this.insertInto(scratch, doc))
    store.apply(scratch, new Set(stored.map(doc => doc.id as string)))
    this.scope.changed(this.name, 'insert', stored.map(doc => doc.id as string))
    this.scope.committed(this.name)
    return stored.map(doc => this.out(doc))
  }

  async replace(doc: T & { id: string }, options: ReplaceOptions = {}) {
    const clean = normalizeDocument(doc)
    if (typeof clean.id !== 'string') throw invalidDocument('replace needs a document with an id')
    const id = clean.id
    const store = this.scope.write(this.name)
    const existing = store.get(id)
    if (options.expectedRev !== undefined && existing?.rev !== options.expectedRev) {
      throw new StorageError('CONFLICT', `${this.name}/${id} is at rev ${existing?.rev ?? 'none'}, not ${options.expectedRev}`,
        { collection: this.name, id, rev: (existing?.rev as number | undefined) ?? null })
    }
    if (!existing && !options.upsert) throw new StorageError('NOT_FOUND', `${this.name} has no document with id ${id}`, { collection: this.name, id })
    const stored = { ...clean, id, rev: existing ? (existing.rev as number) + 1 : 1 }
    put(store, this.name, id, stored)
    this.scope.changed(this.name, existing ? 'update' : 'insert', [id])
    this.scope.committed(this.name)
    return this.out(stored)
  }

  private applyTo(store: DocumentStore, docs: JsonObject[], update: Update): UpdateResult {
    let modified = 0
    const ids: string[] = []
    for (const doc of docs) {
      const { doc: next, changed } = applyUpdate(doc, update)
      if (!changed) continue
      next.rev = (doc.rev as number) + 1
      put(store, this.name, doc.id as string, next)
      modified++
      ids.push(doc.id as string)
    }
    if (ids.length) this.scope.changed(this.name, 'update', ids)
    return { matched: docs.length, modified }
  }

  async updateOne(filter: Filter, update: Update, options: { upsert?: boolean } = {}) {
    const store = this.scope.write(this.name)
    const [doc] = this.matching(filter).sort(compileSort(undefined))
    let result: UpdateResult
    if (doc) {
      result = this.applyTo(store, [doc], update)
    } else if (options.upsert) {
      const seed: JsonObject = {}
      for (const [field, value] of Object.entries(filterEqualities(filter))) setPath(seed, field, value)
      const { doc: built } = applyUpdate(seed, update)
      const stored = this.insertInto(store, built as unknown as T)
      this.scope.changed(this.name, 'insert', [stored.id as string])
      result = { matched: 0, modified: 0, upsertedId: stored.id as string }
    } else {
      result = { matched: 0, modified: 0 }
    }
    this.scope.committed(this.name)
    return result
  }

  async updateMany(filter: Filter, update: Update) {
    const store = this.scope.write(this.name)
    const result = this.applyTo(store, this.matching(filter), update)
    this.scope.committed(this.name)
    return result
  }

  private deleteDocs(store: DocumentStore, docs: JsonObject[]): number {
    for (const doc of docs) remove(store, doc.id as string)
    if (docs.length) this.scope.changed(this.name, 'delete', docs.map(doc => doc.id as string))
    this.scope.committed(this.name)
    return docs.length
  }

  async deleteOne(filter: Filter) {
    const store = this.scope.write(this.name)
    const [doc] = this.matching(filter).sort(compileSort(undefined))
    return this.deleteDocs(store, doc ? [doc] : [])
  }

  async deleteMany(filter: Filter) {
    const store = this.scope.write(this.name)
    return this.deleteDocs(store, this.matching(filter))
  }

  // Reporting

  async aggregate<R extends JsonObject = JsonObject>(pipeline: Stage[]) {
    const docs = this.docs().sort(compileSort(undefined)).map(doc => cloneJson(doc))
    const resolve = async (name: string) => [...(this.scope.read(name)?.values() ?? [])]
    return (await runPipeline(docs, pipeline, resolve)) as R[]
  }

  // Schema

  private schemaStore(): DocumentStore {
    if (this.scope.inTransaction) throw invalidArgument('Index changes are not transactional; make them outside transaction()')
    return this.scope.write(this.name)
  }

  async ensureIndex(spec: IndexSpec) {
    validateIndexSpec(spec)
    const store = this.schemaStore()
    const existing = store.indexes.find(i => i.name === spec.name)
    if (existing && sameIndex(existing, spec)) return
    const clean: IndexSpec = { name: spec.name, fields: [...spec.fields], ...(spec.unique ? { unique: true } : {}) }
    const keys = clean.unique ? buildUnique(store, this.name, clean) : undefined
    store.indexes = [...store.indexes.filter(i => i.name !== spec.name), clean]
    store.unique.delete(spec.name)
    if (keys) store.unique.set(spec.name, keys)
    this.scope.committed(this.name)
  }

  async dropIndex(name: string) {
    const store = this.schemaStore()
    store.indexes = store.indexes.filter(i => i.name !== name)
    store.unique.delete(name)
    this.scope.committed(this.name)
  }

  async indexes() {
    return (this.scope.read(this.name)?.indexes ?? []).map(i => ({ ...i, fields: [...i.fields] }))
  }

  async explain(filter?: Filter, options: FindOptions = {}): Promise<Json> {
    return {
      engine: this.scope.engine,
      collection: this.name,
      scan: true,
      index: null,
      filterFields: filterFields(filter),
      sortFields: sortFields(options.sort),
      ...(this.scope.plan?.(this.name, filter, options) ?? {})
    }
  }
}
