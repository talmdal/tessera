// The sub-ledger tree, stored in the ledger's own `ledger.subledgers` collection.
import type { Collection, Database, Doc, Transaction } from '@tessera/types'
import {
  LEDGER_COLLECTIONS, LedgerError, descendantIds, isLedgerError, nameKey, uniqueName, validateLedgerName,
  type SubLedger, type SubLedgerParticipant
} from '@tessera/ledger-api'
import { scopedTransaction } from './scopedDatabase'

/** A stored sub-ledger: the public shape plus the key its name is compared by. */
interface Stored {
  parentId: string | null
  name: string
  nameKey: string
  order: number
  notes?: string
}

const toSubLedger = ({ id, parentId, name, order, notes, rev }: Doc<Stored>): SubLedger =>
  ({ id, parentId, name, order, rev, ...(notes !== undefined && { notes }) })

/** Storage errors that mean something to the user, as ledger errors; anything else as it was. */
export function translate(err: unknown): unknown {
  if (isLedgerError(err)) return err
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') return new LedgerError('DUPLICATE_NAME', 'A sub-ledger with this name is already there.', 'name')
  if (code === 'CONFLICT') return new LedgerError('CONFLICT', 'This sub-ledger was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new LedgerError('READ_ONLY', 'This ledger is open read-only.')
  if (code === 'NOT_OPEN') return new LedgerError('NO_LEDGER', 'No ledger is open.')
  return err
}

function checkedName(name: unknown): string {
  if (typeof name !== 'string') throw new LedgerError('INVALID', 'Enter a name.', 'name')
  const problem = validateLedgerName(name)
  if (problem) throw new LedgerError('INVALID', problem, 'name')
  return name.trim()
}

/**
 * Creates, renames, moves and deletes sub-ledgers. Every change is one storage transaction, so sibling order and
 * the participants' items never end up half-moved. `db` throws NO_LEDGER while no ledger is open.
 */
export class SubLedgers {
  constructor(
    private readonly db: () => Database,
    private readonly participants: () => [string, SubLedgerParticipant][]
  ) {}

  private collection(tx?: Transaction): Collection<Stored> {
    return (tx ?? this.db()).collection<Stored>(LEDGER_COLLECTIONS.subLedgers)
  }

  async list(): Promise<SubLedger[]> {
    try {
      return (await this.collection().find()).map(toSubLedger)
    } catch (err) { throw translate(err) }
  }

  private async write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.db().transaction(work)
    } catch (err) { throw translate(err) }
  }

  private async existing(collection: Collection<Stored>, id: string): Promise<Doc<Stored>> {
    const found = typeof id === 'string' ? await collection.get(id) : undefined
    if (!found) throw new LedgerError('NOT_FOUND', 'That sub-ledger no longer exists.')
    return found
  }

  private async parent(collection: Collection<Stored>, parentId: string | null): Promise<void> {
    if (parentId === null) return
    if (!(await collection.get(parentId))) throw new LedgerError('NOT_FOUND', 'The parent ledger no longer exists.', 'parentId')
  }

  private async siblings(collection: Collection<Stored>, parentId: string | null) {
    return collection.find({ parentId }, { sort: { order: 1 } })
  }

  async create(input: { name: string, parentId: string | null, notes?: string }): Promise<SubLedger> {
    const name = checkedName(input?.name)
    const parentId = input.parentId ?? null
    return this.write(async tx => {
      const collection = this.collection(tx)
      await this.parent(collection, parentId)
      const siblings = await this.siblings(collection, parentId)
      if (siblings.some(s => s.nameKey === nameKey(name))) {
        throw new LedgerError('DUPLICATE_NAME', `There is already a “${name}” there.`, 'name')
      }
      const order = siblings.reduce((max, s) => Math.max(max, s.order), -1) + 1
      const created = await collection.insert({
        parentId, name, nameKey: nameKey(name), order,
        ...(input.notes !== undefined && { notes: input.notes })
      })
      return toSubLedger(created)
    })
  }

  async rename(id: string, newName: string, options: { expectedRev?: number } = {}): Promise<SubLedger> {
    const name = checkedName(newName)
    return this.write(async tx => {
      const collection = this.collection(tx)
      const current = await this.existing(collection, id)
      const siblings = await this.siblings(collection, current.parentId)
      if (siblings.some(s => s.id !== id && s.nameKey === nameKey(name))) {
        throw new LedgerError('DUPLICATE_NAME', `There is already a “${name}” there.`, 'name')
      }
      const { rev, ...rest } = current
      const renamed = await collection.replace({ ...rest, name, nameKey: nameKey(name) },
        options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev })
      return toSubLedger(renamed)
    })
  }

  /** Moves a sub-ledger under `to` (null: the ledger itself), at `index` among its new siblings (default: last). */
  async move(id: string, to: string | null, index?: number): Promise<void> {
    const target = to ?? null
    await this.write(async tx => {
      const collection = this.collection(tx)
      const moving = await this.existing(collection, id)
      await this.parent(collection, target)
      if (target !== null) {
        const all = (await collection.find()).map(toSubLedger)
        if (target === id || descendantIds(all, id).has(target)) {
          throw new LedgerError('CYCLE', `“${moving.name}” can’t be moved into itself or one of its own sub-ledgers.`)
        }
      }

      const siblings = (await this.siblings(collection, target)).filter(s => s.id !== id)
      if (target !== moving.parentId && siblings.some(s => s.nameKey === moving.nameKey)) {
        throw new LedgerError('DUPLICATE_NAME', `There is already a “${moving.name}” there.`)
      }
      const at = index === undefined ? siblings.length : Math.max(0, Math.min(Math.trunc(index), siblings.length))
      const ordered = [...siblings.slice(0, at), moving, ...siblings.slice(at)]

      // Renumber densely; write only what changed
      for (const [order, doc] of ordered.entries()) {
        const parentId = doc.id === id ? target : doc.parentId
        if (doc.order === order && doc.parentId === parentId) continue
        await collection.updateOne({ id: doc.id }, { $set: { order, parentId } })
      }
      // …and close the gap it left behind
      if (moving.parentId !== target) {
        for (const [order, doc] of (await this.siblings(collection, moving.parentId)).entries()) {
          if (doc.order !== order) await collection.updateOne({ id: doc.id }, { $set: { order } })
        }
      }
    })
  }

  /**
   * Deletes a sub-ledger after moving everything in it to its parent: each participant's items, then its own
   * sub-ledgers (after the parent's existing ones, renamed " (2)"… where a name is taken). One transaction: if a
   * participant throws, nothing changes.
   */
  async delete(id: string): Promise<{ movedTo: string | null }> {
    return this.write(async tx => {
      const collection = this.collection(tx)
      const doomed = await this.existing(collection, id)
      const parentId = doomed.parentId

      for (const [contributor, participant] of this.participants()) {
        await participant.reparent(scopedTransaction(tx, contributor), id, parentId)
      }

      // Deleted before its children move up, so a child named like it ("Business" in "Business") can take its place
      const children = await this.siblings(collection, id)
      await collection.deleteOne({ id })

      const staying = await this.siblings(collection, parentId)
      const taken = new Set(staying.map(s => s.nameKey))
      let order = staying.reduce((max, s) => Math.max(max, s.order), -1)
      for (const child of children) {
        const name = uniqueName(child.name, taken)
        taken.add(nameKey(name))
        await collection.updateOne({ id: child.id }, { $set: { parentId, order: ++order, name, nameKey: nameKey(name) } })
      }
      return { movedTo: parentId }
    })
  }
}
