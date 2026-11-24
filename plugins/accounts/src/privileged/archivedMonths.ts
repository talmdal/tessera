// What archives removed, kept as totals (since accounts-api 1.15): one document per account and month, its categories',
// transfers' and payees' totals packed as flat arrays of numbers, each id its place in one dictionary of ids. Phase R0
// measured this packing: with payees, smaller than nested objects without them, and no slower to archive
// (docs/reporting-design.md, "Archived months" and Phase R0 results, 3). Pure, but for the readers and writers at the
// end, which take the collections.
import {
  AccountsError, isIsoDate, BALANCE_DATES_MAX,
  type Account, type ArchivedTotal, type BalancePoint, type BalanceQuery, type RemovedAccount, type TotalsQuery
} from '@tessera/accounts-api'
import type { Doc } from '@tessera/types'
import type { Collections, StoredAccount, StoredArchivedAccount, StoredArchivedMonth, StoredTransaction } from './store'
import { invalid, toAccount } from './store'
import { sortTotals } from './transactionsCore'

/** [inflow, outflow, count]. */
export type Entry = [number, number, number]
/** A transfer's entry, with the other account's sub-ledger when it was archived (null: the ledger itself). */
export type TransferEntry = [number, number, number, string | null]

/** One account's month, unpacked: by category ('' for uncategorised), other account, and category then payee ('' none). */
export interface MonthTotals {
  categories: Map<string, Entry>
  transfers: Map<string, TransferEntry>
  payees: Map<string, Map<string, Entry>>
}

/** The fields of `StoredArchivedMonth` that hold totals. */
export type PackedTotals = Pick<StoredArchivedMonth, 'categories' | 'transfers' | 'payees'>

const CATEGORY_STRIDE = 4
const TRANSFER_STRIDE = 5
const PAYEE_STRIDE = 5

/**
 * The dictionary: ids numbered by their place in a list that only grows, so a number written once always means the
 * same id. '' (none) is −1 and never listed.
 */
export class IdNumbers {
  private readonly index = new Map<string, number>()
  private readonly start: number

  constructor(readonly ids: string[] = []) {
    ids.forEach((id, n) => this.index.set(id, n))
    this.start = ids.length
  }

  /** The id's number, adding it if it is new; −1 for '' or null. */
  numberOf(id: string | null): number {
    if (id === null || id === '') return -1
    let n = this.index.get(id)
    if (n === undefined) {
      n = this.ids.length
      this.ids.push(id)
      this.index.set(id, n)
    }
    return n
  }

  /** The id's number if it has one (−1 for '' or null, undefined for an id never numbered). */
  find(id: string | null): number | undefined {
    return id === null || id === '' ? -1 : this.index.get(id)
  }

  /** The id a number stands for: '' for −1. Throws for a number the dictionary doesn't have: damaged data. */
  idOf(n: number): string {
    if (n === -1) return ''
    const id = this.ids[n]
    if (id === undefined) throw new AccountsError('INVALID', `The archived totals name id number ${n}, which isn’t in their dictionary.`)
    return id
  }

  /** Ids were added since it was read: the dictionary's document needs writing. */
  get grew(): boolean {
    return this.ids.length > this.start
  }
}

export const emptyMonth = (): MonthTotals => ({ categories: new Map(), transfers: new Map(), payees: new Map() })

/** An entry's counts: the first three of an `Entry` or a `TransferEntry`. */
type Counts = [number, number, number, ...unknown[]]

const addTo = (entry: Counts, amount: number) => {
  if (amount >= 0) entry[0] += amount
  else entry[1] -= amount
  entry[2]++
}

/**
 * Adds one transaction (not voided: the caller leaves those out, as totals do) to its month. A transfer is kept by its
 * other account, with that account's sub-ledger; anything else by category, and by category and payee.
 */
export function addTransaction(
  month: MonthTotals,
  t: Pick<StoredTransaction, 'amount' | 'categoryId' | 'transferAccountId' | 'payeeId'>,
  otherSubLedgerId: string | null
): void {
  if (t.transferAccountId !== undefined) {
    let entry = month.transfers.get(t.transferAccountId)
    if (!entry) month.transfers.set(t.transferAccountId, entry = [0, 0, 0, otherSubLedgerId])
    addTo(entry, t.amount)
    return
  }
  const category = t.categoryId ?? ''
  let entry = month.categories.get(category)
  if (!entry) month.categories.set(category, entry = [0, 0, 0])
  addTo(entry, t.amount)
  let byPayee = month.payees.get(category)
  if (!byPayee) month.payees.set(category, byPayee = new Map())
  const payee = t.payeeId ?? ''
  let payeeEntry = byPayee.get(payee)
  if (!payeeEntry) byPayee.set(payee, payeeEntry = [0, 0, 0])
  addTo(payeeEntry, t.amount)
}

/** Adds `more` into `into`. A transfer's sub-ledger is the latest archive's: where the other account was most recently. */
export function mergeInto(into: MonthTotals, more: MonthTotals): MonthTotals {
  const add = (a: Counts, b: Readonly<Counts>) => { a[0] += b[0]; a[1] += b[1]; a[2] += b[2] }
  for (const [k, e] of more.categories) {
    const x = into.categories.get(k)
    if (x) add(x, e); else into.categories.set(k, [...e])
  }
  for (const [k, e] of more.transfers) {
    const x = into.transfers.get(k)
    if (x) { add(x, e); x[3] = e[3] } else into.transfers.set(k, [...e])
  }
  for (const [k, byPayee] of more.payees) {
    let x = into.payees.get(k)
    if (!x) into.payees.set(k, x = new Map())
    for (const [p, e] of byPayee) {
      const y = x.get(p)
      if (y) add(y, e); else x.set(p, [...e])
    }
  }
  return into
}

/** Packs a month's totals against the dictionary, which gains any id it hasn't numbered yet. */
export function pack(month: MonthTotals, ids: IdNumbers): PackedTotals {
  const categories: number[] = [], transfers: number[] = [], payees: number[] = []
  for (const [k, [i, o, n]] of month.categories) categories.push(ids.numberOf(k), i, o, n)
  for (const [k, [i, o, n, sub]] of month.transfers) transfers.push(ids.numberOf(k), i, o, n, ids.numberOf(sub))
  for (const [k, byPayee] of month.payees) for (const [p, [i, o, n]] of byPayee) payees.push(ids.numberOf(k), ids.numberOf(p), i, o, n)
  return { categories, transfers, payees }
}

/** Unpacks a month's totals. Throws for arrays of the wrong length or numbers the dictionary lacks: damaged data. */
export function unpack(packed: PackedTotals, ids: IdNumbers): MonthTotals {
  const month = emptyMonth()
  const check = (list: unknown, stride: number, what: string): number[] => {
    if (!Array.isArray(list) || list.length % stride !== 0 || !list.every(Number.isSafeInteger)) {
      throw new AccountsError('INVALID', `The archived totals of a month hold damaged ${what}.`)
    }
    return list
  }
  const c = check(packed.categories, CATEGORY_STRIDE, 'categories')
  for (let k = 0; k < c.length; k += CATEGORY_STRIDE) month.categories.set(ids.idOf(c[k]), [c[k + 1], c[k + 2], c[k + 3]])
  const t = check(packed.transfers, TRANSFER_STRIDE, 'transfers')
  for (let k = 0; k < t.length; k += TRANSFER_STRIDE) {
    const sub = ids.idOf(t[k + 4])
    month.transfers.set(ids.idOf(t[k]), [t[k + 1], t[k + 2], t[k + 3], sub === '' ? null : sub])
  }
  const p = check(packed.payees ?? [], PAYEE_STRIDE, 'payees')
  for (let k = 0; k < p.length; k += PAYEE_STRIDE) {
    const category = ids.idOf(p[k])
    let byPayee = month.payees.get(category)
    if (!byPayee) month.payees.set(category, byPayee = new Map())
    byPayee.set(ids.idOf(p[k + 1]), [p[k + 2], p[k + 3], p[k + 4]])
  }
  return month
}

/** The month's net (money in less money out) and its count, straight from the packed arrays: no dictionary needed. */
export function monthNet(packed: Pick<PackedTotals, 'categories' | 'transfers'>): { net: number, count: number } {
  let net = 0, count = 0
  for (let k = 0; k < packed.categories.length; k += CATEGORY_STRIDE) { net += packed.categories[k + 1] - packed.categories[k + 2]; count += packed.categories[k + 3] }
  for (let k = 0; k < packed.transfers.length; k += TRANSFER_STRIDE) { net += packed.transfers[k + 1] - packed.transfers[k + 2]; count += packed.transfers[k + 3] }
  return { net, count }
}

/**
 * A kept month's totals as `ArchivedTotal` rows, as `transactionTotals` rows are made (`AccountsService.archivedTotals`),
 * with where its account was and its name. With `byPayee`, categories come by payee, and transfers with a null payee.
 */
export function rowsOf(doc: StoredArchivedMonth, ids: IdNumbers, query: Pick<TotalsQuery, 'includeTransfers' | 'byPayee'>): ArchivedTotal[] {
  const month = unpack(doc, ids)
  const base = { accountId: doc.accountId, month: doc.month, currency: doc.currency, subLedgerId: doc.subLedgerId, accountName: doc.name }
  const rows: ArchivedTotal[] = []
  if (query.byPayee === true) {
    for (const [category, byPayee] of month.payees) {
      for (const [payee, [inflow, outflow, count]] of byPayee) {
        rows.push({ ...base, categoryId: category === '' ? null : category, transferAccountId: null, inflow, outflow, count, payeeId: payee === '' ? null : payee })
      }
    }
  } else {
    for (const [category, [inflow, outflow, count]] of month.categories) {
      rows.push({ ...base, categoryId: category === '' ? null : category, transferAccountId: null, inflow, outflow, count })
    }
  }
  if (query.includeTransfers === true) {
    for (const [other, [inflow, outflow, count, sub]] of month.transfers) {
      rows.push({ ...base, categoryId: null, transferAccountId: other, transferSubLedgerId: sub, inflow, outflow, count, ...(query.byPayee === true && { payeeId: null }) })
    }
  }
  return rows
}

// ---- Balances at dates

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** The index of the first of `dates` (sorted) on or after `date`; `dates.length` when none is. */
function firstOnOrAfter(dates: readonly string[], date: string): number {
  let lo = 0, hi = dates.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** An account as balance history needs it: where it starts, and from when its history is whole. */
export interface HistoryAccount {
  id: string
  openingDate: string
  /**
   * The balance its history is built from: the one it opened with, before any archive carried anything into it; or,
   * when its history is incomplete, the one it has now, which every archive carried its total into.
   */
  openingBalance: number
  /**
   * Its history before this date is incomplete (an archive before 1.15 took some of it without keeping the totals):
   * no point before it, and its archived months aren't used, since the opening balance already holds them all.
   */
  incompleteBefore?: string
  removed?: true
}

/** The accounts of the ledger, and those archives removed, as balance history takes them. */
export function historyAccounts(accounts: readonly Doc<StoredAccount>[] | readonly Account[], removed: readonly StoredArchivedAccount[]): HistoryAccount[] {
  const live = accounts.map(a => {
    const incomplete = a.archived !== undefined && (a.archived.countWithTotals ?? 0) < a.archived.count && a.lastArchiveDate !== undefined
    return incomplete
      // From its last archive date on, the opening balance now (everything archived carried into it) and what is left
      ? { id: a.id, openingDate: a.openingDate, openingBalance: a.openingBalance, incompleteBefore: a.lastArchiveDate! }
      : { id: a.id, openingDate: a.openingDate, openingBalance: a.archived?.originalOpeningBalance ?? a.openingBalance }
  })
  const gone = [...removed]
    .sort((a, b) => a.name.localeCompare(b.name))
    // One removed with an incomplete history is known only from then on: empty, as an archive removes only those
    .map(r => r.complete
      ? { id: r.accountId, openingDate: r.openingDate, openingBalance: r.openingBalance, removed: true as const }
      : { id: r.accountId, openingDate: r.openingDate, openingBalance: 0, removed: true as const, incompleteBefore: r.removedBefore })
  return [...live, ...gone]
}

/**
 * Each account's balance at the end of each date (`AccountsService.balanceHistory`): one pass over the transactions,
 * each added into its account's bucket for the first date on or after it (a binary search over the dates), then running
 * sums from the opening balance. An archived month adds its net from its first day, so a date inside it sees it as of its
 * end, marked not exact. No sort and no cache: 187 to 291
 * ms for 120 month ends at 100,000 transactions in Phase R0. `transactions` may hold more than is needed (any date,
 * voided ones): they are filtered here.
 */
export function balanceHistory(
  dates: readonly string[],
  accounts: readonly HistoryAccount[],
  transactions: Iterable<Pick<StoredTransaction, 'accountId' | 'date' | 'amount' | 'voided'>>,
  archived: readonly Pick<StoredArchivedMonth, 'accountId' | 'month' | 'categories' | 'transfers'>[]
): BalancePoint[] {
  const sorted = [...new Set(dates)].sort()
  const index = new Map(accounts.map((a, i) => [a.id, i]))
  const buckets = accounts.map(() => new Array<number>(sorted.length + 1).fill(0))
  for (const t of transactions) {
    if (t.voided) continue
    const i = index.get(t.accountId)
    if (i !== undefined) buckets[i][firstOnOrAfter(sorted, t.date)] += t.amount
  }
  const inexact = accounts.map(() => new Set<number>())
  for (const m of archived) {
    const i = index.get(m.accountId)
    if (i === undefined || accounts[i].incompleteBefore !== undefined) continue
    // From the month's first day on, with the whole month's archived net: a date inside the month, before its end, sees
    // it as of the month's end (archived totals are kept by month), and isn't exact
    const first = firstOnOrAfter(sorted, `${m.month}-01`), end = monthEnd(m.month)
    buckets[i][first] += monthNet(m).net
    for (let d = first; d < sorted.length && sorted[d] < end; d++) inexact[i].add(d)
  }
  const points: BalancePoint[] = []
  accounts.forEach((a, i) => {
    let balance = a.openingBalance
    sorted.forEach((date, d) => {
      balance += buckets[i][d]
      if (date < a.openingDate) return
      if (a.incompleteBefore !== undefined && date < a.incompleteBefore) return
      points.push({ accountId: a.id, date, balance, exact: !inexact[i].has(d), ...(a.removed && { removed: true as const }) })
    })
  })
  return points
}

/** Checks a `BalanceQuery`. Throws INVALID naming the field at fault. */
export function checkBalanceQuery(query: BalanceQuery): BalanceQuery {
  if (typeof query !== 'object' || query === null || !Array.isArray(query.dates)) throw invalid('dates', 'Give the dates as a list of YYYY-MM-DD.')
  if (query.dates.length === 0) throw invalid('dates', 'Give at least one date.')
  if (new Set(query.dates).size > BALANCE_DATES_MAX) throw invalid('dates', `Give at most ${BALANCE_DATES_MAX} dates.`)
  const bad = query.dates.find(d => !isIsoDate(d))
  if (bad !== undefined) throw invalid('dates', `Give each date as YYYY-MM-DD: “${String(bad)}” isn’t one.`)
  if (query.accountIds !== undefined && (!Array.isArray(query.accountIds) || query.accountIds.some(id => typeof id !== 'string'))) {
    throw invalid('accountIds', 'Give the accounts as a list of their ids.')
  }
  return query
}

// ---- Reading and writing, through the collections

/** The dictionary, as stored. */
export async function readIds(c: Collections): Promise<IdNumbers> {
  const doc = await c.archivedIds.findOne({ key: 'ids' })
  return new IdNumbers(Array.isArray(doc?.ids) ? [...doc.ids] : [])
}

/** Writes the dictionary if it grew. */
export async function writeIds(c: Collections, ids: IdNumbers): Promise<void> {
  if (!ids.grew) return
  const doc = await c.archivedIds.findOne({ key: 'ids' })
  if (doc) await c.archivedIds.replace({ ...doc, ids: ids.ids })
  else await c.archivedIds.insert({ key: 'ids', ids: ids.ids })
}

/** `AccountsService.archivedTotals`: the kept months from `from`'s month to `to`'s, as rows, in `transactionTotals` order. */
export async function readArchivedTotals(c: Collections, query: TotalsQuery): Promise<ArchivedTotal[]> {
  const docs = await c.archivedMonths.find({ month: { $gte: query.from.slice(0, 7), $lte: query.to.slice(0, 7) } })
  if (docs.length === 0) return []
  const ids = await readIds(c)
  const only = query.accountIds === undefined ? undefined : new Set(query.accountIds)
  const rows = docs.filter(d => only === undefined || only.has(d.accountId)).flatMap(d => rowsOf(d, ids, query))
  return sortTotals(rows)
}

/** `AccountsService.removedAccounts`: the records archives kept of the accounts they removed, by name. */
export async function readRemovedAccounts(c: Collections): Promise<RemovedAccount[]> {
  return (await c.archivedAccounts.find())
    .map(r => ({
      id: r.accountId, name: r.name, type: r.type, currency: r.currency, subLedgerId: r.subLedgerId, openingDate: r.openingDate,
      openingBalance: r.openingBalance, ...(r.closedOn !== undefined && { closedOn: r.closedOn }), removedBefore: r.removedBefore, complete: r.complete
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** `AccountsService.balanceHistory`, over the collections. `order`: the ledger's accounts, in navigator order. */
export async function readBalanceHistory(c: Collections, query: BalanceQuery, order: (accounts: Account[]) => Account[]): Promise<BalancePoint[]> {
  const dates = [...new Set(query.dates)].sort()
  const last = dates[dates.length - 1]
  const [accounts, removed, transactions, archived] = await Promise.all([
    c.accounts.find(), c.archivedAccounts.find(),
    c.transactions.find({ date: { $lte: last } }),
    c.archivedMonths.find({ month: { $lte: last.slice(0, 7) } })
  ])
  const only = query.accountIds === undefined ? undefined : new Set(query.accountIds)
  const ordered = order(accounts.map(toAccount))
  const wanted = historyAccounts(ordered, removed).filter(a => only === undefined || only.has(a.id))
  return balanceHistory(dates, wanted, transactions, archived)
}

/**
 * Deleting a sub-ledger moves what archived totals say was in it to its parent (`to`; null for the ledger itself), as
 * the budget moves its own: the archived months' own sub-ledger, their transfers' other sub-ledger, and the records of
 * removed accounts. Accounts that still exist are judged where they are now, so this matters for those removed.
 */
export async function reparentArchived(c: Collections, from: string, to: string | null): Promise<void> {
  const ids = await readIds(c)
  // Transfers name the sub-ledger by number: only if it was ever numbered can an entry point at it
  const fromN = ids.find(from)
  const toN = fromN === undefined ? -1 : ids.numberOf(to)
  for (const doc of await c.archivedMonths.find()) {
    let changed = false
    const transfers = [...doc.transfers]
    if (fromN !== undefined) {
      for (let k = 0; k < transfers.length; k += TRANSFER_STRIDE) {
        if (transfers[k + 4] === fromN) { transfers[k + 4] = toN; changed = true }
      }
    }
    if (doc.subLedgerId === from || changed) {
      await c.archivedMonths.replace({ ...doc, transfers, subLedgerId: doc.subLedgerId === from ? to : doc.subLedgerId })
    }
  }
  await c.archivedAccounts.updateMany({ subLedgerId: from }, { $set: { subLedgerId: to } })
  await writeIds(c, ids)
}
