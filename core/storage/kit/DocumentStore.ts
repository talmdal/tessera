// core/storage/kit/DocumentStore.ts
//
// What KitCollection and KitDatabase need from a backend for one collection:
// documents by id, the declared indexes, the unique-index maps, and a
// version counter. MapStore is the in-memory implementation, used by the
// memory engine and by every backend as the transaction overlay.
import type { IndexSpec, Json, JsonObject } from '@tessera/types'
import { StorageError } from '../errors'
import { canonical, getPath } from '../json'

export interface DocumentStore {
  readonly size: number
  get(id: string): JsonObject | undefined
  /** Every document, in any order. Documents are treated as immutable: a write replaces, never edits. */
  values(): Iterable<JsonObject>
  /** Inserts or replaces. Index maintenance is the caller's job (see put/remove). */
  set(id: string, doc: JsonObject): void
  delete(id: string): void

  indexes: IndexSpec[]
  /** Unique index name → key → id. Documents missing any indexed field are left out (sparse). */
  unique: Map<string, Map<string, string>>
  /** Bumped by every committed write; transactions check it at commit. */
  version: number

  /** A copy for a transaction to work on. */
  snapshot(): MapStore
  /** Adopts the overlay's state for the documents a transaction wrote. */
  apply(overlay: MapStore, touched: Set<string>): void
}

export class MapStore implements DocumentStore {
  docs = new Map<string, JsonObject>()
  indexes: IndexSpec[] = []
  unique = new Map<string, Map<string, string>>()
  version = 0

  get size() {
    return this.docs.size
  }

  get(id: string) {
    return this.docs.get(id)
  }

  values() {
    return this.docs.values()
  }

  set(id: string, doc: JsonObject) {
    this.docs.set(id, doc)
  }

  delete(id: string) {
    this.docs.delete(id)
  }

  snapshot(): MapStore {
    const copy = new MapStore()
    copy.docs = new Map(this.docs)
    copy.indexes = [...this.indexes]
    copy.unique = cloneUnique(this.unique)
    copy.version = this.version
    return copy
  }

  apply(overlay: MapStore) {
    this.docs = overlay.docs
    this.unique = overlay.unique
  }
}

export const cloneUnique = (unique: Map<string, Map<string, string>>) =>
  new Map([...unique].map(([name, keys]) => [name, new Map(keys)]))

// ---------------------------------------------------------------------------
// Index maintenance, shared by every backend.

export function indexKey(doc: JsonObject, fields: string[]): string | undefined {
  const values: Json[] = []
  for (const field of fields) {
    const value = getPath(doc, field)
    if (value === undefined) return undefined
    values.push(value)
  }
  return canonical(values)
}

/** Throws UNIQUE_VIOLATION if `doc` would duplicate another document's unique key. */
export function checkUnique(store: DocumentStore, collection: string, doc: JsonObject, id: string): void {
  for (const index of store.indexes) {
    if (!index.unique) continue
    const key = indexKey(doc, index.fields)
    if (key === undefined) continue
    const other = store.unique.get(index.name)?.get(key)
    if (other !== undefined && other !== id) {
      throw new StorageError('UNIQUE_VIOLATION', `Unique index "${index.name}" on ${collection} already has ${index.fields.join(', ')} = ${key}`,
        { collection, index: index.name, id: other })
    }
  }
}

/** Builds a unique index over existing data, or throws UNIQUE_VIOLATION. */
export function buildUnique(store: DocumentStore, collection: string, spec: IndexSpec): Map<string, string> {
  const keys = new Map<string, string>()
  for (const doc of store.values()) {
    const id = doc.id as string
    const key = indexKey(doc, spec.fields)
    if (key === undefined) continue
    const other = keys.get(key)
    if (other !== undefined) {
      throw new StorageError('UNIQUE_VIOLATION', `Cannot create unique index "${spec.name}" on ${collection}: ${other} and ${id} share ${key}`,
        { collection, index: spec.name, id: other })
    }
    keys.set(key, id)
  }
  return keys
}

/** Rebuilds every unique map from the data, for a backend that has just loaded a collection. */
export function rebuildUnique(store: DocumentStore, collection: string): void {
  store.unique = new Map()
  for (const spec of store.indexes) {
    if (spec.unique) store.unique.set(spec.name, buildUnique(store, collection, spec))
  }
}

function unindex(store: DocumentStore, doc: JsonObject | undefined): void {
  if (!doc) return
  for (const index of store.indexes) {
    if (!index.unique) continue
    const key = indexKey(doc, index.fields)
    if (key !== undefined) store.unique.get(index.name)?.delete(key)
  }
}

function index(store: DocumentStore, doc: JsonObject, id: string): void {
  for (const spec of store.indexes) {
    if (!spec.unique) continue
    const key = indexKey(doc, spec.fields)
    if (key !== undefined) store.unique.get(spec.name)!.set(key, id)
  }
}

/** Inserts or replaces a document, keeping the unique maps right. Throws UNIQUE_VIOLATION first. */
export function put(store: DocumentStore, collection: string, id: string, doc: JsonObject): void {
  checkUnique(store, collection, doc, id)
  unindex(store, store.get(id))
  store.set(id, doc)
  index(store, doc, id)
}

export function remove(store: DocumentStore, id: string): void {
  unindex(store, store.get(id))
  store.delete(id)
}
