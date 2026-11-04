import type { Doc, Json } from '@tessera/types'
import type { BackendDriver, LoadedDatabase, StorageBackend, StorageChange } from './backend'
import { KitStorageEngine } from './engine'
import { clone } from './json'
import type { IndexSpec } from './state'

interface Stored { indexes: IndexSpec[], docs: Map<string, Doc> }
interface Files { collections: Map<string, Stored>, meta: Map<string, Json> }

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
  constructor(readonly files: Files = { collections: new Map(), meta: new Map() }) {}

  async load(): Promise<LoadedDatabase> {
    return {
      collections: [...this.files.collections].map(([name, s]) => ({ name, indexes: s.indexes, docs: [...s.docs.values()] })),
      meta: Object.fromEntries(this.files.meta)
    }
  }
  async commit(changes: StorageChange[]) { applyTo(this.files, changes) }
  async flush() {}
  async close() {}
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
      return new MemoryBackend(databases.get(key))
    },
    async list() { return [...databases.keys()].sort() },
    async drop(target) { databases.delete(keyOf(target)) }
  }
}

export const createMemoryEngine = () => new KitStorageEngine(memoryDriver())
