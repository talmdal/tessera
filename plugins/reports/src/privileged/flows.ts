// The flows source's rules (`reports.flows`): which totals count for a scope, which group each counts in, and the
// rows and members a query asks for. Pure, over what accounts.service returned, so every rule is tested on plain data.
// The rule is the budget's, generalised to a report's scope: voided transactions are already left out of the totals;
// every clearing status counts; a transfer counts when it crosses the scope; money in and out with no category count
// apart, in with the income and out with the expenses. See docs/reporting-design.md, "What counts: the flows source".
import {
  ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, type AccountScope, type ArchivedTotal, type Category, type TransactionTotal
} from '@tessera/accounts-api'
import type { SubLedger } from '@tessera/ledger-api'
import {
  FLOWS_SOURCE, ReportsError, addDays, firstDayOf, lastDayOf, monthOf, monthsBetween,
  type DimensionField, type Member, type ReportSourceContribution, type SourceRow
} from '@tessera/reports-api'
import { counts, covers, type Placed } from './ledgerView'

export type FlowGroup = 'income' | 'expense' | 'transferIn' | 'transferOut'

export const GROUPS: { id: FlowGroup, label: string, sign: 1 | -1 }[] = [
  { id: 'income', label: 'Income', sign: 1 },
  { id: 'expense', label: 'Expenses', sign: -1 },
  { id: 'transferIn', label: 'Transfers in', sign: 1 },
  { id: 'transferOut', label: 'Transfers out', sign: -1 }
]

const TYPE_VALUES = ACCOUNT_TYPES.map(t => ({ id: t, label: ACCOUNT_TYPE_LABELS[t] }))

/** The measures that are balances at the period's edges rather than flows: by time and account only. */
export const BALANCE_MEASURES = ['openingBalance', 'closingBalance', 'opened'] as const
const BALANCE_DIMENSIONS = ['month', 'account', 'subLedger', 'accountType']

/** What `reports.flows` can report on. */
export const FLOWS_CONTRIBUTION: ReportSourceContribution = {
  id: FLOWS_SOURCE,
  label: 'Transactions',
  description: 'What went in and out: every transaction in the ledger, and the totals archives kept.',
  service: FLOWS_SOURCE,
  time: 'range',
  drillDown: true,
  fields: [
    { kind: 'dimension', key: 'month', label: 'Month', type: 'time' },
    { kind: 'dimension', key: 'group', label: 'Income or expense', type: 'enum', signed: true, values: GROUPS },
    { kind: 'dimension', key: 'flow', label: 'Income, expenses and transfers', type: 'member', tree: true, signed: true, values: GROUPS, noneLabel: 'Uncategorised', plural: 'rows' },
    { kind: 'dimension', key: 'category', label: 'Category', type: 'member', tree: true, noneLabel: 'Uncategorised', plural: 'categories' },
    { kind: 'dimension', key: 'payee', label: 'Payee', type: 'member', noneLabel: 'No payee', plural: 'payees' },
    { kind: 'dimension', key: 'account', label: 'Account', type: 'member', plural: 'accounts' },
    { kind: 'dimension', key: 'subLedger', label: 'Sub-ledger', type: 'member', tree: true, noneLabel: '(the ledger)', plural: 'sub-ledgers' },
    { kind: 'dimension', key: 'accountType', label: 'Account type', type: 'enum', values: TYPE_VALUES },
    { kind: 'dimension', key: 'otherAccount', label: 'Other account', type: 'member', noneLabel: '(not a transfer)', plural: 'accounts' },
    { kind: 'dimension', key: 'otherSubLedger', label: 'Other sub-ledger', type: 'member', tree: true, noneLabel: '(the ledger)', plural: 'sub-ledgers' },
    { kind: 'measure', key: 'amount', label: 'Amount', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'net', label: 'Net', unit: 'money', combine: 'sum', negativeIsBad: true },
    { kind: 'measure', key: 'moneyIn', label: 'Money in', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'moneyOut', label: 'Money out', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'count', label: 'Transactions', unit: 'count', combine: 'sum' },
    { kind: 'measure', key: 'openingBalance', label: 'Opening balance', unit: 'money', combine: 'none', dimensions: BALANCE_DIMENSIONS },
    { kind: 'measure', key: 'closingBalance', label: 'Closing balance', unit: 'money', combine: 'none', dimensions: BALANCE_DIMENSIONS },
    { kind: 'measure', key: 'opened', label: 'Accounts opened', unit: 'money', combine: 'sum', dimensions: BALANCE_DIMENSIONS }
  ]
}

/** A counted piece of a total: its group, its figures, and what it is of. */
export interface Piece {
  group: FlowGroup
  month: string
  accountId: string
  categoryId: string | null
  otherAccountId: string | null
  payeeId: string | null
  amount: number
  moneyIn: number
  moneyOut: number
  count: number
  archived: boolean
}

/**
 * The pieces a total counts as, over a scope. A category's total is one piece, in its kind's group, its amount net of
 * refunds (or reversals). A total with no category, or a category no longer there, is money in with the income and
 * money out with the expenses, never netted. A transfer across the scope is money in and money out, by the other
 * account. A total with money both ways gives one piece each way; its count goes with the money out (a total doesn't
 * say how many went each way), so every transaction is counted once.
 */
export function piecesOf(
  t: Pick<TransactionTotal, 'accountId' | 'month' | 'categoryId' | 'transferAccountId' | 'inflow' | 'outflow' | 'count' | 'payeeId'>,
  categories: ReadonlyMap<string, Pick<Category, 'kind'>>,
  archived: boolean
): Piece[] {
  const base = { month: t.month, accountId: t.accountId, payeeId: t.payeeId ?? null, archived }
  if (t.transferAccountId !== null) {
    return [
      ...(t.inflow > 0 ? [{ ...base, group: 'transferIn' as const, categoryId: null, otherAccountId: t.transferAccountId, amount: t.inflow, moneyIn: t.inflow, moneyOut: 0, count: t.outflow > 0 ? 0 : t.count }] : []),
      ...(t.outflow > 0 ? [{ ...base, group: 'transferOut' as const, categoryId: null, otherAccountId: t.transferAccountId, amount: t.outflow, moneyIn: 0, moneyOut: t.outflow, count: t.count }] : [])
    ]
  }
  const kind = t.categoryId === null ? undefined : categories.get(t.categoryId)?.kind
  if (kind === undefined) {
    return [
      ...(t.inflow > 0 ? [{ ...base, group: 'income' as const, categoryId: null, otherAccountId: null, amount: t.inflow, moneyIn: t.inflow, moneyOut: 0, count: t.outflow > 0 ? 0 : t.count }] : []),
      ...(t.outflow > 0 ? [{ ...base, group: 'expense' as const, categoryId: null, otherAccountId: null, amount: t.outflow, moneyIn: 0, moneyOut: t.outflow, count: t.count }] : [])
    ]
  }
  return [{
    ...base, group: kind, categoryId: t.categoryId, otherAccountId: null,
    amount: kind === 'income' ? t.inflow - t.outflow : t.outflow - t.inflow, moneyIn: t.inflow, moneyOut: t.outflow, count: t.count
  }]
}

/** The account on the other side of an archived transfer that is gone from the ledger: where the total says it was. */
const otherPlace = (total: Pick<ArchivedTotal, 'transferAccountId' | 'transferSubLedgerId'>, placed: ReadonlyMap<string, Placed>): Placed | undefined =>
  total.transferAccountId === null ? undefined : placed.get(total.transferAccountId)

/**
 * Whether a total counts for a scope: its account counted (in scope and currency) and, for a transfer, its other
 * account outside the scope. An account judged where it is, or (removed) where it was; a transfer's other account
 * unknown to the ledger, by the sub-ledger its archived total kept.
 */
export function countsFor(
  t: Pick<ArchivedTotal, 'accountId' | 'transferAccountId'> & { transferSubLedgerId?: string | null, currency?: string, subLedgerId?: string | null },
  scope: AccountScope,
  placed: ReadonlyMap<string, Placed>,
  currency: string | undefined
): boolean {
  const account = placed.get(t.accountId)
  const own = account
    ? counts(scope, account, currency)
    // Known only from its archived total (an archive before its record was kept): where and in what it was
    : t.currency !== undefined && (currency === undefined || t.currency === currency) && scope.covers({ id: t.accountId, subLedgerId: t.subLedgerId ?? null })
  if (!own) return false
  if (t.transferAccountId === null) return true
  const other = otherPlace(t, placed)
  if (other) return !covers(scope, other)
  return !scope.covers({ id: t.transferAccountId, subLedgerId: t.transferSubLedgerId ?? null })
}

export interface FlowsInput {
  live: readonly TransactionTotal[]
  archived: readonly ArchivedTotal[]
  categories: readonly Category[]
  placed: ReadonlyMap<string, Placed>
  subLedgers: readonly SubLedger[]
  payees: ReadonlyMap<string, string>
  /** One scope, or one per column (sub-ledgers side by side). */
  scopes: AccountScope[]
  /** Sub-ledgers side by side: each row says which scope (column) it is of. */
  sideBySide?: boolean
  currency: string | undefined
  dimensions: readonly string[]
  measures: readonly string[]
}

/** The key a piece has in a dimension. */
export function keyOf(dimension: string, p: Piece, input: FlowsInput, categories: ReadonlyMap<string, Category>): string | null {
  const account = input.placed.get(p.accountId)
  switch (dimension) {
    case 'month': return p.month
    case 'group': return p.group
    case 'flow':
      if (p.group === 'transferIn' || p.group === 'transferOut') return `${p.group}:${p.otherAccountId}`
      return p.categoryId !== null && categories.has(p.categoryId) ? p.categoryId : `uncategorised:${p.group}`
    case 'category': return p.categoryId !== null && categories.has(p.categoryId) ? p.categoryId : null
    case 'payee': return p.payeeId
    case 'account': return p.accountId
    case 'subLedger': return account?.subLedgerId ?? null
    case 'accountType': return account?.type ?? null
    case 'otherAccount': return p.otherAccountId
    case 'otherSubLedger': return p.otherAccountId === null ? null : input.placed.get(p.otherAccountId)?.subLedgerId ?? null
    default: throw new ReportsError('INVALID', `Source “${FLOWS_SOURCE}” has no dimension “${dimension}”.`)
  }
}

/** A piece's figure of a measure. */
export const figure = (measure: string, p: Piece): number => {
  switch (measure) {
    case 'amount': return p.amount
    case 'net': return p.moneyIn - p.moneyOut
    case 'moneyIn': return p.moneyIn
    case 'moneyOut': return p.moneyOut
    case 'count': return p.count
    default: return 0                    // balances: worked out apart (`balanceRows`)
  }
}

/** Rows keyed by the dimensions asked, summed, in order of first appearance; one set per scope. */
export function flowRows(input: FlowsInput): { rows: SourceRow[], pieces: number, transfers: boolean } {
  const categories = new Map(input.categories.map(c => [c.id, c]))
  const rows = new Map<string, SourceRow>()
  let pieces = 0
  let transfers = false
  const add = (t: TransactionTotal | ArchivedTotal, archived: boolean) => {
    input.scopes.forEach((scope, s) => {
      if (!countsFor(t, scope, input.placed, input.currency)) return
      for (const p of piecesOf(t, categories, archived)) {
        pieces++
        if (p.otherAccountId !== null) transfers = true
        const keys = input.dimensions.map(d => keyOf(d, p, input, categories))
        const id = `${s}\u0000${keys.map(k => k ?? '\u0001').join('\u0000')}`
        let row = rows.get(id)
        if (!row) rows.set(id, row = { keys, values: input.measures.map(() => 0), ...(input.sideBySide && { scope: s }) })
        input.measures.forEach((m, j) => { row!.values[j] += figure(m, p) })
      }
    })
  }
  for (const t of input.live) add(t, false)
  for (const t of input.archived) add(t, true)
  return { rows: [...rows.values()], pieces, transfers }
}

/** The members the rows' keys need, and their ancestors, labelled as the register labels them. */
export function flowMembers(rows: readonly SourceRow[], input: FlowsInput, fields: readonly DimensionField[]): Record<string, Member[]> {
  const categories = new Map(input.categories.map(c => [c.id, c]))
  const subLedgers = new Map(input.subLedgers.map(s => [s.id, s]))
  const out: Record<string, Member[]> = {}
  input.dimensions.forEach((dimension, i) => {
    const field = fields.find(f => f.key === dimension)
    if (!field || field.type !== 'member') return
    const found = new Map<string, Member>()
    const accountLabel = (id: string) => {
      const a = input.placed.get(id)
      return a ? (a.removed ? `${a.name} (archived)` : a.name) : '(deleted account)'
    }
    const category = (id: string, parentOfTop: string | null) => {
      for (let c = categories.get(id); c && !found.has(c.id); c = c.parentId === null ? undefined : categories.get(c.parentId)) {
        found.set(c.id, { id: c.id, label: c.name, parentId: c.parentId ?? parentOfTop })
      }
    }
    const subLedger = (id: string) => {
      for (let s = subLedgers.get(id); s && !found.has(s.id); s = s.parentId === null ? undefined : subLedgers.get(s.parentId)) {
        found.set(s.id, { id: s.id, label: s.name, parentId: s.parentId, order: s.order })
      }
    }
    for (const row of rows) {
      const key = row.keys[i]
      if (key === null || found.has(key)) continue
      switch (dimension) {
        case 'flow': {
          if (key.startsWith('uncategorised:')) {
            found.set(key, { id: key, label: 'Uncategorised', parentId: key.slice('uncategorised:'.length), none: true })
          } else if (key.startsWith('transferIn:') || key.startsWith('transferOut:')) {
            const [group, ...rest] = key.split(':')
            found.set(key, { id: key, label: accountLabel(rest.join(':')), parentId: group })
          } else {
            category(key, categories.get(key) ? topKind(key, categories) : null)
          }
          break
        }
        case 'category': category(key, null); break
        case 'payee': found.set(key, { id: key, label: input.payees.get(key) ?? '(deleted payee)' }); break
        case 'account': case 'otherAccount': found.set(key, { id: key, label: accountLabel(key) }); break
        case 'subLedger': case 'otherSubLedger': subLedger(key); if (!found.has(key)) found.set(key, { id: key, label: '(deleted sub-ledger)' }); break
      }
    }
    out[dimension] = [...found.values()].sort((a, b) => a.label.localeCompare(b.label))
  })
  return out
}

/** The group a category's tree sits under in `flow`: its top ancestor's kind. */
export function topKind(id: string, categories: ReadonlyMap<string, Category>): string {
  let c = categories.get(id)!
  while (c.parentId !== null && categories.has(c.parentId)) c = categories.get(c.parentId)!
  return c.kind
}

// ---- Balances at the period's edges (Cash Flow's balance rows)

/** The dates balances are needed at: the day before each month's (or the period's) first day, and its last day. */
export function balanceDates(range: { from: string, to: string }, byMonth: boolean): { month: string | null, start: string, end: string }[] {
  if (!byMonth) return [{ month: null, start: range.from, end: range.to }]
  return monthsBetween(monthOf(range.from), monthOf(range.to)).map(month => ({
    month,
    start: firstDayOf(month) < range.from ? range.from : firstDayOf(month),
    end: lastDayOf(month) > range.to ? range.to : lastDayOf(month)
  }))
}

export interface BalanceInput {
  range: { from: string, to: string }
  /** Each account's balance at each date asked (none before it opened, or where its history is incomplete). */
  balances: ReadonlyMap<string, ReadonlyMap<string, number>>
  placed: ReadonlyMap<string, Placed>
  scopes: AccountScope[]
  sideBySide?: boolean
  currency: string | undefined
  dimensions: readonly string[]
  measures: readonly string[]
}

/**
 * Opening balance, closing balance and accounts opened, by the dimensions asked (month, account, sub-ledger, account
 * type): for each counted account, its balance the day before each span and at its end, and its opening balance if it
 * opened within it. So opening + net + opened = closing, the identity Cash Flow is held to.
 */
export function balanceRows(input: BalanceInput): { rows: SourceRow[], unknown: Placed[] } {
  const rows = new Map<string, SourceRow>()
  const unknown = new Set<Placed>()
  const spans = balanceDates(input.range, input.dimensions.includes('month'))
  const at = (account: Placed, date: string): number => {
    const value = input.balances.get(account.id)?.get(date)
    if (value === undefined && account.openingDate <= date) unknown.add(account)
    return value ?? 0
  }
  input.scopes.forEach((scope, s) => {
    for (const account of input.placed.values()) {
      if (!counts(scope, account, input.currency)) continue
      for (const span of spans) {
        const opening = at(account, addDays(span.start, -1))
        const closing = at(account, span.end)
        const opened = account.openingDate >= span.start && account.openingDate <= span.end ? account.openingBalance : 0
        if (opening === 0 && closing === 0 && opened === 0 && account.openingDate > span.end) continue
        const keys = input.dimensions.map(d => {
          switch (d) {
            case 'month': return span.month
            case 'account': return account.id
            case 'subLedger': return account.subLedgerId
            case 'accountType': return account.type
            default: throw new ReportsError('INVALID', `Balances can’t be broken down by “${d}”.`)
          }
        })
        const id = `${s}\u0000${keys.map(k => k ?? '\u0001').join('\u0000')}`
        let row = rows.get(id)
        if (!row) rows.set(id, row = { keys, values: input.measures.map(() => 0), ...(input.sideBySide && { scope: s }) })
        input.measures.forEach((m, j) => {
          row!.values[j] += m === 'openingBalance' ? opening : m === 'closingBalance' ? closing : m === 'opened' ? opened : 0
        })
      }
    }
  })
  return { rows: [...rows.values()], unknown: [...unknown] }
}
