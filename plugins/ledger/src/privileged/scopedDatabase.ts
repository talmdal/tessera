// What a contributor sees of the open ledger: its own collections and meta keys (`<contributor>.…`), nothing else.
import type { ChangeEvent, CollectionSchema, Database, DatabaseMeta, Transaction } from '@tessera/types'
import { LedgerError } from '@tessera/ledger-api'

function guard(contributor: string) {
  const prefix = `${contributor}.`
  return (name: string) => {
    if (typeof name !== 'string' || !name.startsWith(prefix)) {
      throw new LedgerError('INVALID', `"${contributor}" may only use names starting with "${prefix}", not "${String(name)}"`)
    }
    return name
  }
}

/** A transaction limited to the contributor's collections. */
export function scopedTransaction(tx: Transaction, contributor: string): Transaction {
  const check = guard(contributor)
  return { collection: name => tx.collection(check(name)) }
}

/**
 * The open ledger's database as one contributor may use it. Collections and meta keys outside `<contributor>.` are
 * rejected, change events are filtered to its own collections, and closing and copying the database (`snapshot`) are
 * the ledger's job, not a contributor's.
 */
export function scopedDatabase(db: Database, contributor: string): Database {
  const check = guard(contributor)
  const mine = (name: string) => name.startsWith(`${contributor}.`)

  // async, so a refused key rejects like any other failure rather than throwing before a promise exists
  const meta: DatabaseMeta = {
    get: async key => db.meta.get(check(key)),
    set: async (key, value) => db.meta.set(check(key), value),
    delete: async key => db.meta.delete(check(key))
  }

  return {
    get name() { return db.name },
    get readOnly() { return db.readOnly },
    collection: name => db.collection(check(name)),
    listCollections: async () => (await db.listCollections()).filter(mine),
    createCollection: (schema: CollectionSchema) => db.createCollection({ ...schema, name: check(schema.name) }),
    dropCollection: name => db.dropCollection(check(name)),
    renameCollection: (from, to) => db.renameCollection(check(from), check(to)),
    transaction: work => db.transaction(tx => work(scopedTransaction(tx, contributor))),
    onDidChange: listener => db.onDidChange(event => {
      const own: ChangeEvent = {
        changes: event.changes.filter(change => mine(change.collection)),
        structure: event.structure.filter(change => mine(change.collection))
      }
      if (own.changes.length + own.structure.length > 0) listener(own)
    }),
    meta,
    flush: () => db.flush(),
    // A copy of the whole ledger would hold every other contributor's data too: backups are the ledger's job
    snapshot: () => Promise.reject(new LedgerError('INVALID', 'A contributor can’t copy the ledger; the ledger makes its backups')),
    close: () => Promise.reject(new LedgerError('INVALID', 'The ledger closes its database; use ledger.session.close()'))
  }
}
