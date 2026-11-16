// @vitest-environment node
// The archived months: what an archive removed, packed one document per account and month (docs/budget-design.md,
// Phase B0 results), read back as totals, and the accounts plugin's `removedTotals` read defensively.
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { ArchivedTotal } from '@tessera/accounts-api'
import { BUDGET_COLLECTIONS } from '@tessera/budget-api'
import { ARCHIVE_YIELD_EVERY, addArchivedMonths, budgetArchiver, readRemovedTotals } from '../../../plugins/budget/src/privileged/participants'
import { countedTotals, scopeOf } from '../../../plugins/budget/src/privileged/status'
import { BUDGET_SCHEMA } from '../../../plugins/budget/src/privileged/schema'
import type { ArchivedMonth } from '../../../plugins/budget/src/privileged/store'

async function months() {
  const db = await new KitStorageEngine(memoryDriver()).open({ name: 'budget' }, { schema: BUDGET_SCHEMA.collections })
  return db.collection<ArchivedMonth>(BUDGET_COLLECTIONS.archivedMonths)
}
const total = (over: Partial<ArchivedTotal>): ArchivedTotal =>
  ({ accountId: 'A', month: '2025-03', categoryId: 'groceries', transferAccountId: null, inflow: 0, outflow: 0, count: 0, currency: 'CAD', subLedgerId: 'personal', ...over })
const none = async () => {}

describe('archived months', () => {
  it('pack an archive\'s totals one document per account and month, categories and transfers as entries', async () => {
    const c = await months()
    await addArchivedMonths(c, [
      total({ outflow: 5000, count: 2 }),
      total({ categoryId: 'dining', inflow: 100, outflow: 700, count: 2 }),
      total({ categoryId: null, outflow: 41, count: 1 }),
      total({ categoryId: null, transferAccountId: 'B', outflow: 50000, count: 1, transferSubLedgerId: 'business' }),
      total({ month: '2025-04', outflow: 1, count: 1 }),
      total({ accountId: 'C', subLedgerId: null, currency: 'USD', outflow: 9, count: 1 })
    ], none)
    const docs = (await c.find()).map(({ id: _id, rev: _rev, ...d }) => d)
    expect(docs).toEqual(expect.arrayContaining([
      { accountId: 'A', month: '2025-03', currency: 'CAD', subLedgerId: 'personal', categories: { groceries: [0, 5000, 2], dining: [100, 700, 2], '': [0, 41, 1] }, transfers: { B: [0, 50000, 1, 'business'] } },
      { accountId: 'A', month: '2025-04', currency: 'CAD', subLedgerId: 'personal', categories: { groceries: [0, 1, 1] }, transfers: {} },
      { accountId: 'C', month: '2025-03', currency: 'USD', subLedgerId: null, categories: { groceries: [0, 9, 1] }, transfers: {} }
    ]))
    expect(docs).toHaveLength(3)
  })

  it('add a second archive of the same months to the first, with where the account is now', async () => {
    const c = await months()
    await addArchivedMonths(c, [total({ outflow: 5000, count: 2 }), total({ categoryId: null, transferAccountId: 'B', outflow: 50000, count: 1, transferSubLedgerId: 'business' })], none)
    await addArchivedMonths(c, [
      total({ outflow: 1000, count: 1, subLedgerId: 'household' }), total({ categoryId: 'dining', outflow: 7, count: 1, subLedgerId: 'household' }),
      total({ categoryId: null, transferAccountId: 'B', inflow: 10, count: 1, transferSubLedgerId: 'business', subLedgerId: 'household' })
    ], none)
    const [doc] = await c.find()
    expect(doc).toMatchObject({ subLedgerId: 'household', categories: { groceries: [0, 6000, 3], dining: [0, 7, 1] }, transfers: { B: [10, 50000, 2, 'business'] } })
    expect(await c.count()).toBe(1)
  })

  it('let the event loop turn every so many writes', async () => {
    const c = await months()
    const turn = vi.fn(none)
    await addArchivedMonths(c, Array.from({ length: ARCHIVE_YIELD_EVERY + 5 }, (_, i) => total({ accountId: `A${i}`, outflow: 1, count: 1 })), turn)
    expect(turn).toHaveBeenCalledTimes(1)
    expect(await c.count()).toBe(ARCHIVE_YIELD_EVERY + 5)
  })

  it('read back as what the archive removed; an account that\'s gone, by the sub-ledger and currency kept with it', () => {
    const doc = (over: Partial<ArchivedMonth>): ArchivedMonth =>
      ({ accountId: 'A', month: '2025-03', currency: 'CAD', subLedgerId: 'personal', categories: { groceries: [0, 5000, 2], '': [3, 0, 1] }, transfers: { B: [0, 700, 1, 'business'], S: [0, 100, 1, 'personal'] }, ...over })
    const subLedgers = [{ id: 'personal', parentId: null, name: 'Personal', order: 0 }, { id: 'business', parentId: null, name: 'Business', order: 1 }]
    const accounts = [{ id: 'A', name: 'Chequing', subLedgerId: 'personal', currency: 'CAD' }, { id: 'S', name: 'Savings', subLedgerId: 'personal', currency: 'CAD' }]
    const scope = scopeOf({ subLedgerId: 'personal', currency: 'CAD' }, subLedgers, accounts)
    const byId = new Map(accounts.map(a => [a.id, a]))
    const read = (docs: ArchivedMonth[]) => countedTotals([], docs, scope, byId, 'CAD').map(t => [t.accountId, t.categoryId, t.transferAccountId, t.inflow, t.outflow, t.count, t.archived])
    // An account that exists: its entries; the transfer with Savings (inside) left out, with B (gone, was in Business) kept
    expect(read([doc({})])).toEqual([
      ['A', 'groceries', null, 0, 5000, 2, true], ['A', null, null, 3, 0, 1, true], ['A', null, 'B', 0, 700, 1, true]
    ])
    // An account the archive removed: counted by where it was, and in what currency
    expect(read([doc({ accountId: 'gone' })])).toHaveLength(3)
    expect(read([doc({ accountId: 'gone', subLedgerId: 'business' })])).toEqual([])
    expect(read([doc({ accountId: 'gone', currency: 'USD' })])).toEqual([])
  })
})

describe('the accounts plugin\'s removedTotals, read defensively', () => {
  it('keeps the well-formed ones and says how many it left out, or that there were none to read', () => {
    expect(readRemovedTotals({ removedTotals: [total({ outflow: 1, count: 1 }), { accountId: 7 }, total({ month: '2025-3' }), total({ inflow: -1 }), null] }))
      .toEqual({ totals: [total({ outflow: 1, count: 1 })], skipped: 4, missing: false })
    expect(readRemovedTotals({ transactionIds: [] })).toEqual({ totals: [], skipped: 0, missing: true })
    expect(readRemovedTotals(undefined)).toEqual({ totals: [], skipped: 0, missing: true })
  })

  it('removes nothing, so says nothing in the Archive dialog or the message after it, and warns about what it couldn\'t keep', async () => {
    const log = { warn: vi.fn() }
    const committed = vi.fn()
    const archiver = budgetArchiver({ turn: none, committed, log })
    expect(await archiver.describe('2026-01-01', {})).toBeUndefined()
    const db = await new KitStorageEngine(memoryDriver()).open({ name: 'budget' }, { schema: BUDGET_SCHEMA.collections })
    const result = await db.transaction(tx => archiver.archive(tx, { before: '2026-01-01', options: {}, earlier: new Map([['accounts', { transactionIds: ['t'] }]]) }))
    expect(result).toEqual({ count: 0, summary: 'Nothing removed from budgets' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('shared no removedTotals'))
    archiver.committed!()
    expect(committed).toHaveBeenCalledTimes(1)
  })
})
