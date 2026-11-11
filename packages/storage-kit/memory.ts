import type { Doc, Json, SnapshotOptions } from '@tessera/types'
import type { BackendDriver, LoadedDatabase, StorageBackend, StorageChange } from './backend'
import { KitStorageEngine } from './engine'
import { StorageError } from './errors'
import { clone } from './json'
import type { IndexSpec } from './state'

interface Stored { indexes: IndexSpec[], docs: Map<string, Doc> }
interface Files { collections: Map<string, Stored>, meta: Map<string, Json> }

/** A deep copy, as a file written out and read back would be. */
const copyOf = (files: Files): Files => ({
  collections: new Map([...files.collections].map(([name, s]) =>
    [name, { indexes: clone(s.indexes as never), docs: new Map([...s.docs].map(([id, doc]) => [id, clone(doc as never)])) }])),
  meta: new Map([...files.meta].map(([key, value]) => [key, clone(value as never)]))
})

/** Applies a batch to plain maps: what both a memory backend and a test double for a real one need. */
function applyTo(files: Files, changes: StorageChange[]) {
  for (const change of changes) {
    switch (change.type) {
      case 'collection': {
        const existing = files.collections.get(change.name)
        files.collections.set(change.name, { indexes: change.indexes, docs: existing?.docs ?? new Map() })
        break
      }
      case 'drop': files.collections.delete(change.name); break
      case 'rename': {
        const stored = files.collections.get(change.from)
        if (stored) { files.collections.delete(change.from); files.collections.set(change.to, stored) }
        break
      }
      case 'put': files.collections.get(change.collection)?.docs.set(change.doc.id, clone(change.doc as never)); break
      case 'delete': files.collections.get(change.collection)?.docs.delete(change.id); break
      case 'meta':
        if (change.value === undefined) files.meta.delete(change.key)
        else files.meta.set(change.key, change.value)
    }
  }
}

/** A backend that keeps nothing beyond the process. `files` is exposed so tests can reopen what was written. */
export class MemoryBackend implements StorageBackend {
  /**
   * @param store Where a snapshot goes: the driver's map of databases, keyed as `open` keys them. Without one (a
   *   backend made on its own), snapshots are refused.
   */
  constructor(readonly files: Files = { collections: new Map(), meta: new Map() }, private readonly store?: Map<string, Files>) {}

  async load(): Promise<LoadedDatabase> {
    return {
      collections: [...this.files.collections].map(([name, s]) => ({ name, indexes: s.indexes, docs: [...s.docs.values()] })),
      meta: Object.fromEntries(this.files.meta)
    }
  }
  async commit(changes: StorageChange[]) { applyTo(this.files, changes) }
  async flush() {}
  /** Nothing to give back: maps hold only what is there. */
  async compact() {}
  async close() {}

  /** Synchronous from the first check to the copy, so the copy is one committed state. */
  async snapshot(file: string, { meta, signal, onProgress }: SnapshotOptions) {
    if (!this.store) throw new StorageError('INVALID_ARGUMENT', 'this memory backend has nowhere to put a snapshot')
    if (signal?.aborted) throw new StorageError('ABORTED', 'the snapshot was abandoned')
    if (this.store.has(file)) throw new StorageError('INVALID_ARGUMENT', `${file} already exists`)
    const copy = copyOf(this.files)
    for (const [key, value] of Object.entries(meta ?? {})) copy.meta.set(key, clone(value as never))
    this.store.set(file, copy)
    onProgress?.(1)
  }
}

/** The driver for databases that live in memory, keyed by name or path: a reference backend for tests. */
export function memoryDriver(): BackendDriver & { databases: Map<string, Files> } {
  const databases = new Map<string, Files>()
  const keyOf = (target: { name: string } | { path: string }) => 'name' in target ? target.name : target.path
  return {
    id: 'storage-memory',
    capabilities: { transactions: true, aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', durability: 'none' },
    databases,
    async open(target) {
      const key = keyOf(target)
      if (!databases.has(key)) databases.set(key, { collections: new Map(), meta: new Map() })
      return new MemoryBackend(databases.get(key), databases)
    },
    async list() { return [...databases.keys()].sort() },
    /** Never creates a database, unlike `open`. */
    async readMeta(target) {
      const files = databases.get(keyOf(target))
      if (!files) throw new StorageError('NOT_FOUND', `there is no database "${keyOf(target)}"`)
      return Object.fromEntries([...files.meta].map(([key, value]) => [key, clone(value as never)]))
    },
    async drop(target) { databases.delete(keyOf(target)) }
  }
}

export const createMemoryEngine = () => new KitStorageEngine(memoryDriver())
