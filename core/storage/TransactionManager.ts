import { StorageEngine, StorageTransaction } from './StorageEngine'

export class TransactionManager {
  constructor(private engine: StorageEngine) {}

  async run<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    if (!this.engine.capabilities().transactions) {
      throw new Error('Storage engine does not support transactions')
    }

    const tx = await this.engine.beginTransaction()

    try {
      const result = await fn(tx)
      await tx.commit()
      return result
    } catch (err) {
      await tx.rollback()
      throw err
    }
  }
}

export async function transactionalInsertMany<T>(
  tm: TransactionManager,
  collection: string,
  docs: T[]
): Promise<number> {
  return tm.run(async tx => {
    for (const doc of docs) {
      await tx.insert(collection, doc)
    }
    return docs.length
  })
}

export async function transactionalUpdateMany<T>(
  tm: TransactionManager,
  collection: string,
  query: any,
  update: Partial<T>
): Promise<number> {
  return tm.run(async tx => {
    return tx.update(collection, query, update)
  })
}

export async function transactionalDeleteMany(
  tm: TransactionManager,
  collection: string,
  query: any
): Promise<number> {
  return tm.run(async tx => {
    return tx.delete(collection, query)
  })
}

export async function transactionalTransform<T>(
  tm: TransactionManager,
  collection: string,
  query: any,
  transform: (doc: T) => T
): Promise<number> {
  return tm.run(async tx => {
    const docs = await tx.get<T>(collection, query)
    const updated = docs.map(transform)
    updated.forEach((doc: T) => tx.update(collection, { id: (doc as any).id }, doc as Partial<T>))
    return updated.length
  })
}

export async function transactionalMove<T>(
  tm: TransactionManager,
  from: string,
  to: string,
  query: any
): Promise<number> {
  return tm.run(async tx => {
    const docs = await tx.get<T>(from, query)
    for (const doc of docs) {
      await tx.insert(to, doc)
      await tx.delete(from, { id: (doc as any).id })
    }
    return docs.length
  })
}
