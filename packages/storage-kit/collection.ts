import type {
  Collection, DeleteResult, Doc, Filter, FindOptions, IndexDefinition, JsonObject, NewDoc, Page, PageOptions,
  QueryPlan, ReplaceOptions, Sort, Stage, Update, UpdateOptions, UpdateResult, WriteOptions
} from '@tessera/types'
import { runPipeline } from './aggregate'
import { StorageError } from './errors'
import { compileFilter, equalities, Matcher } from './filter'
import { clone, equals, normalize, setPath } from './json'
import { compareBy, decodeCursor, encodeCursor, sortDocs, sortKey } from './sort'
import { Change, CollectionState, toIndexSpec } from './state'
import { applyUpdate, validateUpdate } from './update'

/** Where a collection's reads come from and its writes go: the database itself, or one transaction of it. */
export interface CollectionContext {
  /** The visible state, or undefined if the collection doesn't exist yet. Throws UNKNOWN_COLLECTION if it may not. */
  read(name: string): CollectionState | undefined
  /** Runs `compute` against the visible state (an empty one if the collection doesn't exist yet) and commits its changes. */
  write<R>(name: string, compute: (state: CollectionState) => { result: R, changes: Change[] }): Promise<R>
  changeIndexes(name: string, change: (state: CollectionState) => void): Promise<void>
  newId(): string
}

const EMPTY = new CollectionState()

const argument = (message: string) => new StorageError('INVALID_ARGUMENT', message)

const wholeCount = (value: number | undefined, what: string, min = 0) => {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min) throw argument(`${what} must be an integer of at least ${min}`)
  return value
}

const byId = (a: Doc, b: Doc) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Strips `id` and `rev`, which the engine owns, from what a caller wrote. */
function content(doc: unknown): JsonObject {
  const copy = normalize(doc) as JsonObject
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) throw new StorageError('INVALID_DOCUMENT', 'a document must be an object')
  delete copy.rev
  return copy
}

const bareContent = (doc: JsonObject) => { const { id, rev, ...rest } = doc; return rest as JsonObject }

function checkId(id: unknown): string {
  if (typeof id !== 'string' || id === '') throw new StorageError('INVALID_DOCUMENT', 'a document id must be a non-empty string')
  return id
}

/** The one implementation of every Collection method, over any CollectionContext. */
export class KitCollection<T extends object = JsonObject> implements Collection<T> {
  constructor(readonly name: string, private readonly ctx: CollectionContext) {}

  private state() { return this.ctx.read(this.name) ?? EMPTY }

  /** Documents that may match: by id or unique index when the filter pins them, else all. */
  private candidates(state: CollectionState, filter: Filter | undefined): { docs: Iterable<Doc>, plan: QueryPlan } {
    const pinned = equalities(filter)
    if (typeof pinned.id === 'string') {
      const doc = state.get(pinned.id)
      return { docs: doc ? [doc] : [], plan: { strategy: 'id' } }
    }
    for (const index of state.indexes.values()) {
      if (!index.unique || !index.fields.every(f => f in pinned)) continue
      const probe = {} as JsonObject
      for (const field of index.fields) setPath(probe, field, pinned[field])
      const key = state.keyOf(index, probe as Doc)
      const id = key === undefined ? undefined : state.owner(index.name, key)
      const doc = id === undefined ? undefined : state.get(id)
      return { docs: doc ? [doc] : [], plan: { strategy: 'index', index: index.name } }
    }
    return { docs: state.docs.values(), plan: { strategy: 'scan' } }
  }

  private matching(filter: Filter | undefined): Doc[] {
    const matcher: Matcher = compileFilter(filter)
    const state = this.state()
    const found: Doc[] = []
    for (const doc of this.candidates(state, filter).docs) if (matcher(doc)) found.push(doc)
    return found
  }

  private ordered(filter: Filter | undefined, sort?: Sort): Doc[] {
    const found = this.matching(filter)
    return sort === undefined ? found.sort(byId) : sortDocs(found, sort)
  }

  // ---- reads

  async get(id: string) {
    const doc = this.state().get(id)
    return doc && clone(doc as JsonObject) as Doc<T>
  }

  async getMany(ids: string[]) {
    const state = this.state()
    return ids.flatMap(id => { const doc = state.get(id); return doc ? [clone(doc as JsonObject) as Doc<T>] : [] })
  }

  async findOne(filter?: Filter, options: { sort?: Sort } = {}) {
    const [first] = await this.find(filter, { sort: options.sort, limit: 1 })
    return first
  }

  async find(filter?: Filter, options: FindOptions = {}) {
    const skip = wholeCount(options.skip, 'skip') ?? 0
    const limit = wholeCount(options.limit, 'limit')
    const rows = this.ordered(filter, options.sort).slice(skip, limit === undefined ? undefined : skip + limit)
    return rows.map(doc => clone(doc as JsonObject) as Doc<T>)
  }

  async findPage(filter: Filter | undefined, options: PageOptions): Promise<Page<Doc<T>>> {
    const limit = wholeCount(options.limit, 'limit', 1)!
    const key = sortKey(options.sort)
    let rows = this.ordered(filter, options.sort)
    if (options.cursor !== undefined) {
      const after = decodeCursor(options.cursor, key)
      rows = rows.filter(doc => compareBy(key, doc, after) > 0)
    }
    const items = rows.slice(0, limit)
    const page: Page<Doc<T>> = { items: items.map(doc => clone(doc as JsonObject) as Doc<T>) }
    if (rows.length > limit) page.nextCursor = encodeCursor(key, items[items.length - 1])
    return page
  }

  async count(filter?: Filter) { return this.matching(filter).length }

  async *scan(filter?: Filter, options: { batchSize?: number } = {}) {
    const size = wholeCount(options.batchSize, 'batchSize', 1) ?? 500
    const rows = this.ordered(filter)   // a snapshot: stored documents are never mutated
    for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size).map(doc => clone(doc as JsonObject) as Doc<T>)
  }

  async aggregate<R = JsonObject>(pipeline: Stage[]) {
    const docs = [...this.state().docs.values()].sort(byId)
    const lookup = (from: string) => [...(this.ctx.read(from)?.docs.values() ?? [])].sort(byId)
    return runPipeline(docs, pipeline, lookup) as R[]
  }

  async explain(filter?: Filter) {
    compileFilter(filter)
    return this.candidates(this.state(), filter).plan
  }

  // ---- writes

  async insert(doc: NewDoc<T>) { return (await this.insertMany([doc]))[0] }

  async insertMany(docs: NewDoc<T>[]) {
    const prepared = docs.map(input => {
      const body = content(input)
      const id = body.id === undefined ? this.ctx.newId() : checkId(body.id)
      return { ...body, id, rev: 1 } as Doc
    })
    return this.ctx.write(this.name, state => {
      const seen = new Set<string>()
      for (const doc of prepared) {
        if (state.get(doc.id) || seen.has(doc.id)) throw new StorageError('DUPLICATE_ID', `"${this.name}" already has a document with id "${doc.id}"`)
        seen.add(doc.id)
      }
      state.check(prepared.map(after => ({ after })))
      return { result: prepared.map(doc => clone(doc as JsonObject) as Doc<T>), changes: prepared.map(after => ({ after })) }
    })
  }

  async replace(input: NewDoc<T> & { id: string }, options: ReplaceOptions = {}) {
    const body = content(input)
    const id = checkId(body.id)
    return this.ctx.write(this.name, state => {
      const before = state.get(id)
      if (!before) {
        if (!options.upsert) throw new StorageError('NOT_FOUND', `"${this.name}" has no document with id "${id}"`)
        const after = { ...body, id, rev: 1 } as Doc
        const changes = [{ after }]
        state.check(changes)
        return { result: clone(after as JsonObject) as Doc<T>, changes }
      }
      expectRev(before, options)
      if (equals(bareContent(before), bareContent(body))) return { result: clone(before as JsonObject) as Doc<T>, changes: [] }
      const after = { ...body, id, rev: before.rev + 1 } as Doc
      const changes = [{ before, after }]
      state.check(changes)
      return { result: clone(after as JsonObject) as Doc<T>, changes }
    })
  }

  private async modify(filter: Filter, update: Update, many: boolean, options: UpdateOptions = {}): Promise<UpdateResult> {
    validateUpdate(update)
    const matcher = compileFilter(filter)
    return this.ctx.write<UpdateResult>(this.name, state => {
      const found: Doc[] = []
      for (const doc of this.candidates(state, filter).docs) if (matcher(doc)) found.push(doc)
      found.sort(byId)
      const targets = many ? found : found.slice(0, 1)

      if (targets.length === 0) {
        if (!options.upsert || many) return { result: { matched: 0, modified: 0 }, changes: [] }
        const seed: JsonObject = {}
        for (const [path, value] of Object.entries(equalities(filter))) setPath(seed, path, value)
        const body = applyUpdate(seed, update)
        const id = body.id === undefined ? this.ctx.newId() : checkId(body.id)
        const after = { ...body, id, rev: 1 } as Doc
        const changes = [{ after }]
        state.check(changes)
        return { result: { matched: 0, modified: 0, upsertedId: id }, changes }
      }

      const changes: Change[] = []
      for (const before of targets) {
        expectRev(before, options)
        const next = applyUpdate(before, update)
        if (!equals(next, before)) changes.push({ before, after: { ...next, rev: before.rev + 1 } as Doc })
      }
      state.check(changes)
      return { result: { matched: targets.length, modified: changes.length }, changes }
    })
  }


  updateOne(filter: Filter, update: Update, options?: UpdateOptions) { return this.modify(filter, update, false, options) }
  updateMany(filter: Filter, update: Update) { return this.modify(filter, update, true) }

  private async remove(filter: Filter | undefined, many: boolean, options: WriteOptions = {}): Promise<DeleteResult> {
    const matcher = compileFilter(filter)
    return this.ctx.write(this.name, state => {
      const found: Doc[] = []
      for (const doc of this.candidates(state, filter).docs) if (matcher(doc)) found.push(doc)
      found.sort(byId)
      const targets = many ? found : found.slice(0, 1)
      for (const doc of targets) expectRev(doc, options)
      return { result: { deleted: targets.length }, changes: targets.map(before => ({ before })) }
    })
  }

  deleteOne(filter: Filter, options?: WriteOptions) { return this.remove(filter, false, options) }
  deleteMany(filter?: Filter) { return this.remove(filter, true) }

  // ---- indexes

  async ensureIndex(index: IndexDefinition) {
    const spec = toIndexSpec(index)
    await this.ctx.changeIndexes(this.name, state => state.addIndex(spec))
    return spec.name
  }

  async dropIndex(name: string) { await this.ctx.changeIndexes(this.name, state => state.removeIndex(name)) }

  async indexes() { return [...this.state().indexes.values()].map(index => ({ ...index, fields: [...index.fields] })) }
}

function expectRev(doc: Doc, options: WriteOptions) {
  if (options.expectedRev !== undefined && options.expectedRev !== doc.rev) {
    throw new StorageError('CONFLICT', `document "${doc.id}" is at revision ${doc.rev}, not ${options.expectedRev}`)
  }
}

