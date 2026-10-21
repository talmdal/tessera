import { StorageEngine, StorageTransaction, StorageEngineCapabilities, Query } from '@tessera/types'
import Loki from 'lokijs'
import type { Collection } from 'lokijs'
import { LokiFsAdapter } from 'lokijs';

const adapter = new LokiFsAdapter();

const isPredicate = (query: Query): query is (doc: any) => boolean =>
  typeof query === 'function'


export class LokiStorageEngine implements StorageEngine {
  private db: Loki
  private collections: Map<string, Collection<any>> = new Map()

  constructor(private dbPath: string) {
    console.log(`Creating database at path ${dbPath}`)

    this.db = new Loki(dbPath, {
      adapter: adapter,
      autoload: false,
      autosave: true,
      autosaveInterval: 2000
    })
  }

  async init(): Promise<void> {  // Load the adapter module directly
    await new Promise<void>((resolve, reject) => {
      this.db.loadDatabase({}, (err?: Error) => {
        if (err) {
          console.log(`Manual load failed: ${JSON.stringify(err)}`);
          return reject(err)
        }

        console.log('Manual load complete');
        resolve()
      })
    })
  }

  capabilities(): StorageEngineCapabilities {
    return { transactions: true }
  }

  private getCollection(name: string) {
    if (!this.collections.has(name)) {
      let col = this.db.getCollection(name)
      if (!col) col = this.db.addCollection(name)
      this.collections.set(name, col)
    }
    return this.collections.get(name)!
  }

  async listCollections() {
    return this.db.listCollections().map(c => c.name)
  }

  async get<T>(collection: string, query: Query): Promise<T[]> {
    const col = this.getCollection(collection)
    if (isPredicate(query)) return col.find().filter(query)
    return col.find(query)
  }

  async getOne<T>(collection: string, query: Query): Promise<T | null> {
    const col = this.getCollection(collection)
    if (isPredicate(query)) return col.find().find(query) ?? null
    return col.findOne(query)
  }

  async insert<T>(collection: string, doc: T) {
    const col = this.getCollection(collection)
    col.insert(doc)
  }

  async update<T>(collection: string, query: Query, update: Partial<T>) {
    const col = this.getCollection(collection)
    const docs = isPredicate(query)
      ? col.find().filter(query)
      : col.find(query)

    docs.forEach(d => Object.assign(d, update))
    col.update(docs)
    return docs.length
  }

  async delete(collection: string, query: Query) {
    const col = this.getCollection(collection)
    const docs = isPredicate(query)
      ? col.find().filter(query)
      : col.find(query)

    docs.forEach(d => col.remove(d))
    return docs.length
  }

  async upsert<T>(collection: string, query: Query, doc: T): Promise<void> {
    const existing = await this.getOne<T>(collection, query)
    if (existing) {
      await this.update<T>(collection, query, doc)
    } else {
      await this.insert<T>(collection, doc)
    }
  }

  async beginTransaction(): Promise<StorageTransaction> {
    const engine = this
    // Clone the entire Loki database state
    const clone = this.db.copy()

    // Map of cloned collections
    const cloneCollections = new Map<string, Collection<any>>()
    clone.listCollections().forEach(meta => {
      const col = clone.getCollection(meta.name)
      cloneCollections.set(meta.name, col)
    })

    const getCol = (name: string) => {
      if (!cloneCollections.has(name)) {
        let col = clone.getCollection(name)
        if (!col) col = clone.addCollection(name)
        cloneCollections.set(name, col)
      }
      return cloneCollections.get(name)!
    }

    const tx: StorageTransaction = {
      async get<T>(collection: string, query: Query): Promise<T[]> {
        const col = getCol(collection)
        if (isPredicate(query)) return col.find().filter(query)
        return col.find(query)
      },

      async getOne<T>(collection: string, query: Query): Promise<T | null> {
        const col = getCol(collection)
        if (isPredicate(query)) return col.find().find(query) ?? null
        return col.findOne(query)
      },

      async insert<T>(collection: string, doc: T) {
        const col = getCol(collection)
        col.insert(doc)
      },

      async update<T>(collection: string, query: Query, update: Partial<T>) {
        const col = getCol(collection)
        const docs = isPredicate(query)
          ? col.find().filter(query)
          : col.find(query)

        docs.forEach(d => Object.assign(d, update))
        col.update(docs)
        return docs.length
      },

      async delete(collection: string, query: Query) {
        const col = getCol(collection)
        const docs = isPredicate(query)
          ? col.find().filter(query)
          : col.find(query)

        docs.forEach(d => col.remove(d))
        return docs.length
      },

      async upsert<T>(collection: string, query: Query, doc: T) {
        const col = getCol(collection)
        const existing = isPredicate(query)
          ? col.find().find(query) ?? null
          : col.findOne(query)

        if (existing) {
          const docs = isPredicate(query)
            ? col.find().filter(query)
            : col.find(query)

          docs.forEach(d => Object.assign(d, doc))
          col.update(docs)
        } else {
          col.insert(doc)
        }
      },

      async commit() {
        // Replace the live DB with the clone
        engine.db = clone

        // Rebuild collection map
        engine.collections.clear()
        clone.listCollections().forEach(meta => {
          const col = clone.getCollection(meta.name)
          engine.collections.set(meta.name, col)
        })

        // Persist
        await new Promise<void>(resolve => {
          engine.db.saveDatabase(() => resolve())
        })
      },

      async rollback() {
        // Simply drop the clone and its collections
        cloneCollections.clear()
      }
    }

    return tx
  }

  async close(): Promise<void> {
    return new Promise(resolve => {
      this.db.close(() => resolve())
    })
  }
}
