// core/storage/memory/MemoryStorageEngine.ts
//
// The in-memory storage engine: the reference implementation of the contract
// in tessera-types/storage.ts, and the backend domain-plugin tests run
// against. Everything is the shared kit (KitDatabase over MapStores); this
// file only keeps the stores. Nothing is persisted beyond the engine
// instance, but a database survives close() and open() on the same engine,
// so the conformance suite's persistence tests hold for it too.
import type { Database, DatabaseTarget, Json, OpenOptions, StorageCapabilities, StorageEngine } from '@tessera/types'
import { invalidArgument } from '../errors'
import { type DatabaseBackend, KitDatabase } from '../kit/KitDatabase'
import { type DocumentStore, MapStore } from '../kit/DocumentStore'
import { ulid } from '../ulid'

class MapBackend implements DatabaseBackend {
  readonly stores = new Map<string, MapStore>()
  readonly meta = new Map<string, Json>()

  store(name: string): DocumentStore | undefined {
    return this.stores.get(name)
  }

  createStore(name: string) {
    const store = new MapStore()
    this.stores.set(name, store)
    return store
  }

  deleteStore(name: string) {
    return this.stores.delete(name)
  }

  renameStore(from: string, to: string) {
    const store = this.stores.get(from)!
    this.stores.delete(from)
    this.stores.set(to, store)
  }

  storeNames() {
    return [...this.stores.keys()]
  }

  metaGet(key: string) {
    return this.meta.get(key)
  }

  metaSet(key: string, value: Json) {
    this.meta.set(key, value)
  }

  metaDelete(key: string) {
    this.meta.delete(key)
  }

  touched() {}

  async flush() {}

  async close() {}
}

const targetKey = (target: DatabaseTarget) => ('path' in target ? `path:${target.path}` : `name:${target.name}`)

export class MemoryStorageEngine implements StorageEngine {
  readonly id: string = 'memory'
  private readonly backends = new Map<string, MapBackend>()
  private readonly handles = new Map<string, KitDatabase>()

  capabilities(): StorageCapabilities {
    return { aggregate: 'emulated', regex: 'emulated', textSearch: 'emulated', writeThrough: true }
  }

  async open(target: DatabaseTarget, options: OpenOptions = {}): Promise<Database> {
    const key = targetKey(target)
    const name = 'path' in target ? target.path : target.name
    if (typeof name !== 'string' || name === '') throw invalidArgument('A database needs a name or path')

    let handle = this.handles.get(key)
    if (!handle) {
      let backend = this.backends.get(key)
      if (!backend) this.backends.set(key, backend = new MapBackend())
      handle = new KitDatabase(name, this.id, backend, options, () => { this.handles.delete(key) })
      this.handles.set(key, handle)
    }
    for (const schema of options.schema ?? []) await handle.createCollection(schema)
    return handle
  }

  async list() {
    return [...this.backends.keys()].filter(key => key.startsWith('name:')).map(key => key.slice(5)).sort()
  }

  async drop(target: DatabaseTarget) {
    const key = targetKey(target)
    await this.handles.get(key)?.close()
    this.backends.delete(key)
  }

  newId() {
    return ulid()
  }

  async closeAll() {
    for (const handle of [...this.handles.values()]) await handle.close()
  }
}
