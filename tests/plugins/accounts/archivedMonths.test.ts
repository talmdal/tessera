// @vitest-environment node
// What archives removed, kept as totals (accounts-api 1.15): the packing (flat arrays of numbers against one dictionary of
// ids), merging a second archive's months, the rows archivedTotals gives, and balances at dates. Pure functions; the
// archive itself is tested in archive.test.ts. See docs/reporting-design.md, "Archived months".
import { describe, expect, it } from 'vitest'
import { BALANCE_DATES_MAX } from '@tessera/accounts-api'
import {
  IdNumbers, addTransaction, balanceHistory, checkBalanceQuery, emptyMonth, historyAccounts, mergeInto, monthNet, pack, rowsOf, unpack,
  type MonthTotals
} from '../../../plugins/accounts/src/privileged/archivedMonths'
import type { StoredArchivedMonth } from '../../../plugins/accounts/src/privileged/store'

/** A small deterministic random source (mulberry32). */
function random(seed: number) {
  let s = seed
  const next = () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n) }
}

/** A month of random transactions: categories, none, transfers with a sub-ledger or the ledger, payees or none. */
function randomMonth(seed: number): MonthTotals {
  const r = random(seed)
  const month = emptyMonth()
  for (let i = 0, n = 1 + r.int(40); i < n; i++) {
    const amount = r.int(200000) - 150000
    if (r.next() < 0.2) addTransaction(month, { amount, transferAccountId: `acct-${r.int(4)}` }, r.next() < 0.5 ? null : `sub-${r.int(3)}`)
    else addTransaction(month, { amount, ...(r.next() < 0.9 && { categoryId: `cat-${r.int(12)}` }), ...(r.next() < 0.8 && { payeeId: `payee-${r.int(20)}` }) }, null)
  }
  return month
}

/** A month's totals as plain data, for comparing. */
const plain = (m: MonthTotals) => ({
  categories: Object.fromEntries([...m.categories].sort()),
  transfers: Object.fromEntries([...m.transfers].sort()),
  payees: Object.fromEntries([...m.payees].sort().map(([k, v]) => [k, Object.fromEntries([...v].sort())]))
})

const doc = (over: Partial<StoredArchivedMonth>): StoredArchivedMonth => ({
  accountId: 'A', month: '2024-03', name: 'Chequing', currency: 'CAD', subLedgerId: null, categories: [], transfers: [], payees: [], ...over
})

describe('the dictionary of ids', () => {
  it('numbers ids in the order met, never renumbers them, and has −1 for none', () => {
    const ids = new IdNumbers(['x', 'y'])
    expect([ids.numberOf('y'), ids.numberOf('z'), ids.numberOf('x'), ids.numberOf('z')]).toEqual([1, 2, 0, 2])
    expect([ids.numberOf(''), ids.numberOf(null)]).toEqual([-1, -1])
    expect(ids.ids).toEqual(['x', 'y', 'z'])
    expect(ids.grew).toBe(true)
    expect([ids.idOf(2), ids.idOf(-1)]).toEqual(['z', ''])
    expect([ids.find('x'), ids.find('w'), ids.find('')]).toEqual([0, undefined, -1])
    expect(new IdNumbers(['a']).grew).toBe(false)
  })

  it('refuses a number it doesn’t have: the data is damaged', () => {
    expect(() => new IdNumbers(['a']).idOf(1)).toThrow('isn’t in their dictionary')
  })
})

describe('packing a month', () => {
  it('round-trips every entry exactly, on random months, through flat arrays of numbers only', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const month = randomMonth(seed)
      const ids = new IdNumbers()
      const packed = pack(month, ids)
      // Numbers only: R0 found objects keyed by numbers ("12") made the archive's writes four times slower
      for (const list of [packed.categories, packed.transfers, packed.payees]) expect(list.every(Number.isSafeInteger), `seed ${seed}`).toBe(true)
      expect(packed.categories.length % 4 + packed.transfers.length % 5 + packed.payees.length % 5).toBe(0)
      // Through JSON, as stored, and a dictionary read back
      const stored = JSON.parse(JSON.stringify({ ...packed, ids: ids.ids }))
      expect(plain(unpack(stored, new IdNumbers(stored.ids))), `seed ${seed}`).toEqual(plain(month))
    }
  })

  it('keeps the categories’ totals by payee adding up to the categories’, and leaves transfers out of payees', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const month = randomMonth(seed)
      for (const [category, [inflow, outflow, count]] of month.categories) {
        const byPayee = [...month.payees.get(category)!.values()]
        expect(byPayee.reduce((s, e) => [s[0] + e[0], s[1] + e[1], s[2] + e[2]], [0, 0, 0]), `seed ${seed}`).toEqual([inflow, outflow, count])
      }
      expect([...month.payees.keys()].sort()).toEqual([...month.categories.keys()].sort())
    }
  })

  it('adds a second archive’s month into the first’s, the transfer’s sub-ledger the latest', () => {
    const first = emptyMonth(), second = emptyMonth(), whole = emptyMonth()
    const a = [{ amount: -500, categoryId: 'food', payeeId: 'metro' }, { amount: 200, categoryId: 'food', payeeId: 'metro' }, { amount: -900 }]
    const b = [{ amount: -300, categoryId: 'food', payeeId: 'loblaws' }, { amount: -100 }, { amount: 50, categoryId: 'gifts' }]
    for (const t of a) { addTransaction(first, t, null); addTransaction(whole, t, null) }
    for (const t of b) { addTransaction(second, t, null); addTransaction(whole, t, null) }
    addTransaction(first, { amount: -1000, transferAccountId: 'sav' }, 'personal')
    addTransaction(second, { amount: 400, transferAccountId: 'sav' }, 'savings')
    addTransaction(whole, { amount: -1000, transferAccountId: 'sav' }, 'savings')
    addTransaction(whole, { amount: 400, transferAccountId: 'sav' }, 'savings')
    expect(plain(mergeInto(first, second))).toEqual(plain(whole))
  })

  it('refuses damaged arrays rather than misreading them', () => {
    const ids = new IdNumbers(['c'])
    expect(() => unpack({ categories: [0, 1, 2], transfers: [], payees: [] }, ids)).toThrow('damaged categories')
    expect(() => unpack({ categories: [], transfers: [0, 1, 2, 3, 'x' as never], payees: [] }, ids)).toThrow('damaged transfers')
    expect(() => unpack({ categories: [5, 1, 2, 3], transfers: [], payees: [] }, ids)).toThrow('isn’t in their dictionary')
  })

  it('gives a month’s net and count from its arrays, without the dictionary', () => {
    const month = emptyMonth()
    addTransaction(month, { amount: -500, categoryId: 'food' }, null)
    addTransaction(month, { amount: 1200, categoryId: 'pay' }, null)
    addTransaction(month, { amount: -300, transferAccountId: 'sav' }, null)
    expect(monthNet(pack(month, new IdNumbers()))).toEqual({ net: 400, count: 3 })
  })
})

describe('the rows archivedTotals gives', () => {
  const ids = new IdNumbers()
  const month = emptyMonth()
  addTransaction(month, { amount: -500, categoryId: 'food', payeeId: 'metro' }, null)
  addTransaction(month, { amount: -300, categoryId: 'food' }, null)
  addTransaction(month, { amount: 2000, payeeId: 'boss' }, null)
  addTransaction(month, { amount: -1000, transferAccountId: 'sav' }, 'personal')
  const stored = doc({ accountId: 'A', month: '2024-03', name: 'Old Chequing', subLedgerId: 'home', ...pack(month, ids) })
  const base = { accountId: 'A', month: '2024-03', currency: 'CAD', subLedgerId: 'home', accountName: 'Old Chequing' }

  it('are by category, with where the account was and its name; transfers only when asked, with the other sub-ledger', () => {
    expect(new Set(rowsOf(stored, ids, {}))).toEqual(new Set([
      { ...base, categoryId: 'food', transferAccountId: null, inflow: 0, outflow: 800, count: 2 },
      { ...base, categoryId: null, transferAccountId: null, inflow: 2000, outflow: 0, count: 1 }
    ]))
    expect(rowsOf(stored, ids, { includeTransfers: true })).toContainEqual(
      { ...base, categoryId: null, transferAccountId: 'sav', transferSubLedgerId: 'personal', inflow: 0, outflow: 1000, count: 1 })
  })

  it('are by payee when asked, none under null, and transfers with a null payee', () => {
    expect(new Set(rowsOf(stored, ids, { byPayee: true, includeTransfers: true }))).toEqual(new Set([
      { ...base, categoryId: 'food', transferAccountId: null, payeeId: 'metro', inflow: 0, outflow: 500, count: 1 },
      { ...base, categoryId: 'food', transferAccountId: null, payeeId: null, inflow: 0, outflow: 300, count: 1 },
      { ...base, categoryId: null, transferAccountId: null, payeeId: 'boss', inflow: 2000, outflow: 0, count: 1 },
      { ...base, categoryId: null, transferAccountId: 'sav', transferSubLedgerId: 'personal', payeeId: null, inflow: 0, outflow: 1000, count: 1 }
    ]))
  })
})

describe('balances at dates', () => {
  const account = (over = {}) => ({ id: 'A', openingDate: '2024-01-01', openingBalance: 10000, ...over })
  const t = (date: string, amount: number, voided = false) => ({ accountId: 'A', date, amount, voided })

  it('are the opening balance plus every transaction on or before each date, voids left out, in any order asked', () => {
    const points = balanceHistory(['2024-03-31', '2024-01-31', '2024-02-29', '2024-01-31'], [account()],
      [t('2024-01-05', -1000), t('2024-01-31', -500), t('2024-02-10', 300, true), t('2024-03-01', 2000), t('2024-04-01', -99999)], [])
    expect(points.map(p => [p.date, p.balance, p.exact])).toEqual([
      ['2024-01-31', 8500, true], ['2024-02-29', 8500, true], ['2024-03-31', 10500, true]
    ])
  })

  it('give no point before an account opened, or before its last archive date when an archive left its history incomplete', () => {
    const dates = ['2023-12-31', '2024-06-30', '2025-06-30']
    expect(balanceHistory(dates, [account()], [], []).map(p => p.date)).toEqual(['2024-06-30', '2025-06-30'])
    // Incomplete: its archived months (partial) aren't used, since the opening balance it has now holds every archive
    const month = emptyMonth()
    addTransaction(month, { amount: -700 }, null)
    const archived = [{ accountId: 'A', month: '2024-03', ...pack(month, new IdNumbers()) }]
    expect(balanceHistory(dates, [account({ incompleteBefore: '2025-01-01' })], [t('2025-02-01', -50)], archived).map(p => [p.date, p.balance]))
      .toEqual([['2025-06-30', 9950]])
  })

  it('add an archived month at its end, and say a date inside it isn’t exact', () => {
    const month = emptyMonth()
    addTransaction(month, { amount: -700, categoryId: 'food' }, null)
    addTransaction(month, { amount: -300, transferAccountId: 'sav' }, null)
    const archived = [{ accountId: 'A', month: '2024-02', ...pack(month, new IdNumbers()) }]
    const points = balanceHistory(['2024-01-31', '2024-02-10', '2024-02-29', '2024-03-31'], [account()], [t('2024-02-05', -50)], archived)
    expect(points.map(p => [p.date, p.balance, p.exact])).toEqual([
      ['2024-01-31', 10000, true], ['2024-02-10', 8950, false], ['2024-02-29', 8950, true], ['2024-03-31', 8950, true]
    ])
  })

  it('include accounts an archive removed, from their record, marked removed, after the ledger’s', () => {
    const accounts = historyAccounts(
      [{ id: 'L', openingDate: '2024-01-01', openingBalance: 500, lastArchiveDate: '2025-01-01', archived: { count: 3, originalOpeningBalance: 100, countWithTotals: 1 } }] as never,
      [
        { accountId: 'Z', name: 'Zed', type: 'savings', currency: 'CAD', subLedgerId: null, openingDate: '2023-01-01', openingBalance: 40, removedBefore: '2025-01-01', complete: true },
        { accountId: 'B', name: 'Bee', type: 'savings', currency: 'CAD', subLedgerId: null, openingDate: '2023-01-01', openingBalance: 7, removedBefore: '2025-01-01', complete: false }
      ])
    expect(accounts).toEqual([
      // Its history before 2025 incomplete (1 of 3 archived with totals kept): from then on, from the opening balance now
      { id: 'L', openingDate: '2024-01-01', openingBalance: 500, incompleteBefore: '2025-01-01' },
      // Removed with an incomplete history: known from its removal on, when it was empty
      { id: 'B', openingDate: '2023-01-01', openingBalance: 0, removed: true, incompleteBefore: '2025-01-01' },
      { id: 'Z', openingDate: '2023-01-01', openingBalance: 40, removed: true }
    ])
    expect(balanceHistory(['2024-12-31'], accounts, [], [])).toEqual([{ accountId: 'Z', date: '2024-12-31', balance: 40, exact: true, removed: true }])
  })

  it('are asked for with dates as YYYY-MM-DD, at least one and at most BALANCE_DATES_MAX', () => {
    const problem = (query: unknown) => { try { checkBalanceQuery(query as never); return undefined } catch (err) { return (err as { field?: string, message: string }) } }
    expect(problem({ dates: ['2024-01-31'] })).toBeUndefined()
    expect(problem({ dates: [] })).toMatchObject({ field: 'dates', message: 'Give at least one date.' })
    expect(problem({ dates: ['2024-02-30'] })).toMatchObject({ field: 'dates' })
    expect(problem({ dates: 'x' })).toMatchObject({ field: 'dates' })
    expect(problem({ dates: Array.from({ length: BALANCE_DATES_MAX + 1 }, (_, i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10)) })).toMatchObject({ field: 'dates' })
    expect(problem({ dates: Array.from({ length: BALANCE_DATES_MAX + 5 }, () => '2024-01-31') })).toBeUndefined()   // repeats count once
    expect(problem({ dates: ['2024-01-31'], accountIds: [1] })).toMatchObject({ field: 'accountIds' })
  })
})
