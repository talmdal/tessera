import type { Doc, IndexDefinition } from '@tessera/types'
import { StorageError } from './errors'
import { getPath, stableStringify } from './json'

export type IndexSpec = Required<IndexDefinition>

/** One document's change: absent `before` is an insert, absent `after` a delete. */
export interface Change { before?: Doc, after?: Doc }

export function toIndexSpec(index: IndexDefinition): IndexSpec {
  if (!index || !Array.isArray(index.fields) || index.fields.length === 0 || index.fields.some(f => typeof f !== 'string' || !f)) {
    throw new StorageError('INVALID_ARGUMENT', 'an index needs a non-empty list of field names')
  }
  return { name: index.name || index.fields.join('+'), fields: [...index.fields], unique: Boolean(index.unique) }
}

/**
 * Everything the kit knows about one collection: its documents (never mutated once stored, so they can be
 * shared between a state and its clone), its index definitions and the key maps that enforce unique indexes.
 */
export class CollectionState {
  readonly docs = new Map<string, Doc>()
  readonly indexes = new Map<string, IndexSpec>()
  private readonly keys = new Map<string, Map<string, string>>()
  /** Bumped by every commit; a transaction that wrote a collection fails if this moved under it. */
  version = 0

  static from(indexes: IndexSpec[], docs: Iterable<Doc>): CollectionState {
    const state = new CollectionState()
    for (const index of indexes) state.indexes.set(index.name, index)
    for (const doc of docs) state.docs.set(doc.id, doc)
    for (const index of indexes) if (index.unique) state.rebuild(index)
    return state
  }

  clone(): CollectionState {
    const copy = new CollectionState()
    for (const [id, doc] of this.docs) copy.docs.set(id, doc)
    for (const [name, index] of this.indexes) copy.indexes.set(name, index)
    for (const [name, map] of this.keys) copy.keys.set(name, new Map(map))
    copy.version = this.version
    return copy
  }

  get(id: string): Doc | undefined { return this.docs.get(id) }

  /** The key a document has in an index; undefined if it lacks a field (sparse). */
  keyOf(index: IndexSpec, doc: Doc): string | undefined {
    const values = index.fields.map(field => getPath(doc, field))
    return values.some(v => v === undefined) ? undefined : stableStringify(values as never)
  }

  /** The id of the document holding `key` in a unique index. */
  owner(index: string, key: string): string | undefined { return this.keys.get(index)?.get(key) }

  private rebuild(index: IndexSpec) {
    const map = new Map<string, string>()
    for (const doc of this.docs.values()) {
      const key = this.keyOf(index, doc)
      if (key === undefined) continue
      if (map.has(key)) throw new StorageError('UNIQUE_VIOLATION', `unique index "${index.name}" would be violated by existing documents`)
      map.set(key, doc.id)
    }
    this.keys.set(index.name, map)
  }

  /** Adds an index; fails, changing nothing, if existing documents break a unique one. */
  addIndex(index: IndexSpec) {
    const existing = this.indexes.get(index.name)
    if (existing) {
      if (existing.unique === index.unique && existing.fields.join() === index.fields.join()) return
      throw new StorageError('INVALID_ARGUMENT', `index "${index.name}" already exists with a different definition`)
    }
    if (index.unique) this.rebuild(index)
    this.indexes.set(index.name, index)
  }

  removeIndex(name: string) {
    if (!this.indexes.delete(name)) throw new StorageError('INVALID_ARGUMENT', `no index named "${name}"`)
    this.keys.delete(name)
  }

  /** Throws UNIQUE_VIOLATION if applying the changes in order would duplicate a unique key. Changes nothing. */
  check(changes: Change[]) {
    for (const index of this.indexes.values()) {
      if (!index.unique) continue
      const overrides = new Map<string, string | null>()
      const ownerOf = (key: string) => overrides.has(key) ? overrides.get(key)! : this.owner(index.name, key)
      for (const { before, after } of changes) {
        const was = before && this.keyOf(index, before)
        if (before && was !== undefined && ownerOf(was) === before.id) overrides.set(was, null)
        const now = after && this.keyOf(index, after)
        if (after && now !== undefined) {
          const holder = ownerOf(now)
          if (holder !== undefined && holder !== null && holder !== after.id) {
            throw new StorageError('UNIQUE_VIOLATION', `unique index "${index.name}" already has a document with ${index.fields.join(', ')} = ${now}`)
          }
          overrides.set(now, after.id)
        }
      }
    }
  }

  /** Applies changes already passed through `check`. */
  apply(changes: Change[]) {
    for (const { before, after } of changes) {
      if (before) {
        for (const index of this.indexes.values()) {
          if (!index.unique) continue
          const key = this.keyOf(index, before)
          if (key !== undefined && this.keys.get(index.name)?.get(key) === before.id) this.keys.get(index.name)!.delete(key)
        }
        this.docs.delete(before.id)
      }
      if (after) {
        this.docs.set(after.id, after)
        for (const index of this.indexes.values()) {
          if (!index.unique) continue
          const key = this.keyOf(index, after)
          if (key !== undefined) this.keys.get(index.name)!.set(key, after.id)
        }
      }
    }
  }
}
