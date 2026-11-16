// A budget's status, worked out from what the service gathers: which accounts it covers (the scope), which totals
// count for it, and the rows it shows with their figures. Pure, so every rule is tested without a ledger.
// See docs/budget-design.md: "Actuals", "Transfers across the budget's scope", "Which line a transaction counts
// toward" and "Budget, actual and remaining".
import { categoryLabel, type Account, type Category, type TransactionTotal } from '@tessera/accounts-api'
import { descendantIds, type TreeNode } from '@tessera/ledger-api'
import {
  BudgetError, dueDates, lineCovers, planFor, plannedAmount,
  type BreakdownEntry, type Budget, type BudgetLine, type BudgetStatus, type Figures, type LineGroup, type RowRef, type StatusRow,
  type StatusRowKind
} from '@tessera/budget-api'
import type { ArchivedMonth } from './store'

// ---- The scope: which accounts a budget covers

export interface Scope {
  /** Whether a sub-ledger (null: the ledger itself) is in the scope. */
  covers(subLedgerId: string | null): boolean
  /** Accounts in the scope, in any currency: a transfer with one of these stays inside the budget. */
  inside: ReadonlySet<string>
  /** Accounts in the scope and the budget's currency: the ones whose transactions count. */
  counted: ReadonlySet<string>
  /** Accounts in the scope left out for their currency, by name. */
  notCounted: BudgetStatus['notCounted']
}

/**
 * A budget over the whole ledger covers every account; one over a sub-ledger, the accounts in it and in every
 * sub-ledger beneath it, where each account is now. Closed accounts are covered: their past spending is spending.
 */
export function scopeOf(
  budget: Pick<Budget, 'subLedgerId' | 'currency'>,
  subLedgers: readonly TreeNode[],
  accounts: readonly Pick<Account, 'id' | 'name' | 'subLedgerId' | 'currency'>[]
): Scope {
  const within = budget.subLedgerId === null ? undefined : new Set([budget.subLedgerId, ...descendantIds(subLedgers, budget.subLedgerId)])
  const covers = (subLedgerId: string | null) => within === undefined || (subLedgerId !== null && within.has(subLedgerId))
  const inScope = accounts.filter(a => covers(a.subLedgerId))
  return {
    covers,
    inside: new Set(inScope.map(a => a.id)),
    counted: new Set(inScope.filter(a => a.currency === budget.currency).map(a => a.id)),
    notCounted: inScope.filter(a => a.currency !== budget.currency)
      .map(a => ({ accountId: a.id, name: a.name, currency: a.currency }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

// ---- Which totals count

/** A total that counts for a budget, and whether it came from an archive. */
export interface CountedTotal extends TransactionTotal {
  archived: boolean
}

const isEntry = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(n => Number.isSafeInteger(n))

/**
 * The totals that count for a budget: those of the accounts it counts, from the ledger (`live`, from
 * `accounts.service.transactionTotals`) and from what archives removed (`archived`), with transfers only when their other
 * account is outside the scope. An account that still exists is judged where it is now; one an archive removed, by the
 * sub-ledger and currency it had then (and a transfer's other account likewise).
 */
export function countedTotals(
  live: readonly TransactionTotal[],
  archived: readonly ArchivedMonth[],
  scope: Scope,
  accounts: ReadonlyMap<string, Pick<Account, 'id'>>,
  currency: string
): CountedTotal[] {
  const out: CountedTotal[] = []
  const crosses = (otherId: string, otherSubLedgerId: string | null) =>
    accounts.has(otherId) ? !scope.inside.has(otherId) : !scope.covers(otherSubLedgerId)
  for (const t of live) {
    if (!scope.counted.has(t.accountId)) continue
    if (t.transferAccountId !== null && scope.inside.has(t.transferAccountId)) continue
    out.push({ ...t, archived: false })
  }
  for (const doc of archived) {
    const counts = accounts.has(doc.accountId) ? scope.counted.has(doc.accountId) : scope.covers(doc.subLedgerId) && doc.currency === currency
    if (!counts) continue
    for (const [categoryId, entry] of Object.entries(doc.categories ?? {})) {
      if (!isEntry(entry)) continue
      out.push({ accountId: doc.accountId, month: doc.month, categoryId: categoryId === '' ? null : categoryId, transferAccountId: null, inflow: entry[0], outflow: entry[1], count: entry[2], archived: true })
    }
    for (const [otherId, entry] of Object.entries(doc.transfers ?? {})) {
      if (!isEntry(entry) || !crosses(otherId, (entry as unknown[])[3] as string | null ?? null)) continue
      out.push({ accountId: doc.accountId, month: doc.month, categoryId: null, transferAccountId: otherId, inflow: entry[0], outflow: entry[1], count: entry[2], archived: true })
    }
  }
  return out
}

// ---- The rows

export interface StatusInput {
  budget: Budget
  lines: readonly BudgetLine[]
  /** Every category in the ledger. */
  categories: readonly Category[]
  /** Every account in the ledger, for transfer lines' names. */
  accounts: ReadonlyMap<string, Pick<Account, 'id' | 'name'>>
  /** What counts (`countedTotals`). Totals of months outside `months` are ignored. */
  totals: readonly CountedTotal[]
  months: readonly string[]
  notCounted: BudgetStatus['notCounted']
  /** An expense line warns once its spending reaches this share of its budget. */
  warnAtPercent: number
  byMonth: boolean
}

// ---- Which row a total counts in

/** What a total, or one transaction, needs for the rules: when, and its category or other account, and which way. */
export type Countable = Pick<TransactionTotal, 'month' | 'categoryId' | 'transferAccountId' | 'inflow' | 'outflow'>

/**
 * Where an amount counts: the key of a line (`line:<id>`) or of a row for what no line takes (`other:income`,
 * `otherTransfers:expense`, `uncategorised:income`…), its group, and the amount as that row counts it (spending for
 * expenses, money in for income). Other rows also say which category or account the amount came from.
 */
export interface Placement {
  key: string
  group: LineGroup
  amount: number
  breakdownId?: string
}

export interface Classifier {
  /** Where a total counts. One place, or for a total with money both in and out and no line, one on each side. */
  place(t: Countable): Placement[]
  /** A line's group: a transfer's by its direction, a category's by its kind (a deleted category's: expenses). */
  groupOf(line: BudgetLine): LineGroup
}

/**
 * The rules of "Which line a transaction counts toward" (docs/budget-design.md), shared by the status and by the
 * Transactions dialog, so the transactions it lists are exactly those the row's actual is made of.
 */
export function classifier(lines: readonly BudgetLine[], categories: readonly Category[]): Classifier {
  const byId = new Map(categories.map(c => [c.id, c]))
  const groupOf = (line: BudgetLine): LineGroup => line.target.kind === 'transfer'
    ? (line.target.direction === 'in' ? 'income' : 'expense')
    : byId.get(line.target.categoryId)?.kind ?? 'expense'       // a deleted category's line: with the expenses
  const lineByCategory = new Map<string, BudgetLine>()
  const lineByAccount = new Map<string, BudgetLine>()
  for (const line of lines) {
    if (line.target.kind === 'category') lineByCategory.set(line.target.categoryId, line)
    else lineByAccount.set(line.target.accountId, line)
  }

  // The line a category's transactions count toward in a month: its own, else its nearest parent's, that plans that month
  const nearest = new Map<string, BudgetLine | null>()
  const nearestLine = (categoryId: string, month: string): BudgetLine | null => {
    const key = `${categoryId}|${month}`
    let found = nearest.get(key)
    if (found === undefined) {
      found = null
      for (let c = byId.get(categoryId), steps = 0; c && steps <= categories.length; c = c.parentId === null ? undefined : byId.get(c.parentId), steps++) {
        const line = lineByCategory.get(c.id)
        if (line && lineCovers(line, month)) { found = line; break }
      }
      nearest.set(key, found)
    }
    return found
  }

  /** Money in with the income, money out with the expenses, each by its own direction. */
  const split = (kind: 'otherTransfers' | 'uncategorised', t: Countable, breakdownId?: string): Placement[] => [
    ...(t.inflow > 0 ? [{ key: `${kind}:income`, group: 'income' as const, amount: t.inflow, ...(breakdownId !== undefined && { breakdownId }) }] : []),
    ...(t.outflow > 0 ? [{ key: `${kind}:expense`, group: 'expense' as const, amount: t.outflow, ...(breakdownId !== undefined && { breakdownId }) }] : [])
  ]

  const place = (t: Countable): Placement[] => {
    const money = { in: t.inflow - t.outflow, out: t.outflow - t.inflow }
    if (t.transferAccountId !== null) {
      const line = lineByAccount.get(t.transferAccountId)
      if (line && line.target.kind === 'transfer' && lineCovers(line, t.month)) {
        return [{ key: `line:${line.id}`, group: groupOf(line), amount: line.target.direction === 'in' ? money.in : money.out }]
      }
      return split('otherTransfers', t, t.transferAccountId)
    }
    // Neither a category nor a transfer (or a category gone)
    const category = t.categoryId === null ? undefined : byId.get(t.categoryId)
    if (category === undefined) return split('uncategorised', t)
    const line = nearestLine(category.id, t.month)
    if (line) return [{ key: `line:${line.id}`, group: groupOf(line), amount: groupOf(line) === 'income' ? money.in : money.out }]
    return [{ key: `other:${category.kind}`, group: category.kind, amount: category.kind === 'income' ? money.in : money.out, breakdownId: category.id }]
  }

  return { place, groupOf }
}

/**
 * The keys a row's actual is made of (see `Placement`): a line's own; a subtotal's, every line in its category's
 * branch; an Other, Other transfers or Uncategorised row's, its own side's.
 */
export function rowKeys(row: RowRef, lines: readonly BudgetLine[], categories: readonly Category[]): Set<string> {
  if (row.lineId !== undefined) return new Set([`line:${row.lineId}`])
  if (row.kind === 'subtotal' && row.categoryId !== undefined) {
    const branch = new Set([row.categoryId])
    for (let grew = true; grew;) {
      grew = false
      for (const c of categories) if (c.parentId !== null && branch.has(c.parentId) && !branch.has(c.id)) { branch.add(c.id); grew = true }
    }
    return new Set(lines.filter(l => l.target.kind === 'category' && branch.has(l.target.categoryId)).map(l => `line:${l.id}`))
  }
  if (row.kind === 'other' || row.kind === 'otherTransfers' || row.kind === 'uncategorised') return new Set([`${row.kind}:${row.group}`])
  return new Set()
}

/** Where actuals gather: a line, or one of the rows for what no line takes. */
interface Bucket {
  group: LineGroup
  actual: number[]
  archived: number
  count: number
  /** For Other and Other transfers: by category or account id. */
  breakdown?: Map<string, number>
}

const GROUPS: readonly LineGroup[] = ['income', 'expense']

/** The budget's rows and totals for `months`. Every counted transaction is in exactly one row that isn't a subtotal. */
export function budgetStatus(input: StatusInput): BudgetStatus {
  const { budget, lines, categories, accounts, months } = input
  const at = new Map(months.map((m, i) => [m, i]))
  const byId = new Map(categories.map(c => [c.id, c]))
  const { place, groupOf: kindOf } = classifier(lines, categories)
  const lineByCategory = new Map<string, BudgetLine>()
  for (const line of lines) if (line.target.kind === 'category') lineByCategory.set(line.target.categoryId, line)

  // Buckets: one per line, and one per row for what no line takes
  const buckets = new Map<string, Bucket>()
  const bucket = (key: string, group: LineGroup) => {
    let b = buckets.get(key)
    const withBreakdown = key.startsWith('other')
    if (!b) buckets.set(key, b = { group, actual: months.map(() => 0), archived: 0, count: 0, ...(withBreakdown && { breakdown: new Map() }) })
    return b
  }
  for (const line of lines) bucket(`line:${line.id}`, kindOf(line))

  for (const t of input.totals) {
    const i = at.get(t.month)
    if (i === undefined) continue
    for (const p of place(t)) {
      const b = bucket(p.key, p.group)
      b.actual[i] += p.amount
      // A total split between money in and out counts its transactions on each side that has any
      b.count += t.count
      if (t.archived) b.archived += p.amount
      if (p.breakdownId !== undefined && b.breakdown) b.breakdown.set(p.breakdownId, (b.breakdown.get(p.breakdownId) ?? 0) + p.amount)
    }
  }

  // ---- Rows, with their figures
  const rows: StatusRow[] = []
  const archivedOf = new Map<StatusRow, number>()
  const budgetOf = (line?: BudgetLine) => months.map(m => line ? plannedAmount(line, m) : 0)

  const row = (kind: StatusRowKind, group: LineGroup, depth: number, label: string, budgets: number[], b: Bucket, extra: Partial<StatusRow> = {}): StatusRow => {
    const monthly = months.map((_, i) => figures(budgets[i], b.actual[i]))
    const r: StatusRow = { kind, group, depth, label, ...extra, figures: figures(sum(budgets), sum(b.actual)), ...(input.byMonth && { months: monthly }) }
    archivedOf.set(r, b.archived)
    return r
  }
  const lineRow = (line: BudgetLine, kind: StatusRowKind, label: string, depth: number) => {
    const extra: Partial<StatusRow> = { lineId: line.id, ...(line.target.kind === 'category' ? { categoryId: line.target.categoryId } : { accountId: line.target.accountId }) }
    if (months.length === 1) {
      const plan = planFor(line.plans, months[0])
      extra.due = plan ? dueDates(plan, months[0]).map(d => Number(d.slice(8, 10))) : []
    }
    const own = months.filter(m => line.overrides?.[m] !== undefined)
    if (own.length > 0) extra.ownMonths = own
    return row(kind, kindOf(line), depth, label, budgetOf(line), buckets.get(`line:${line.id}`)!, extra)
  }

  const children = new Map<string | null, Category[]>()
  for (const c of categories) {
    const parent = c.parentId !== null && byId.has(c.parentId) ? c.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), c])
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  /** A category's rows, if its branch has a line: a line; or a subtotal, its children's rows, and its own line. */
  const branch = (c: Category, depth: number, seen: Set<string>): StatusRow[] => {
    if (seen.has(c.id)) return []
    seen.add(c.id)
    const own = lineByCategory.get(c.id)
    const kids = (children.get(c.id) ?? []).sort(byName).flatMap(k => branch(k, depth + 1, seen))
    if (kids.length === 0) return own ? [lineRow(own, 'line', c.name, depth)] : []
    const ownRow = own ? [lineRow(own, 'parentLine', `${c.name} (other)`, depth + 1)] : []
    const parts = [...kids.filter(r => r.depth === depth + 1), ...ownRow]
    const subtotal = sumRow('subtotal', c.kind, depth, c.name, parts, { categoryId: c.id })
    return [subtotal, ...kids, ...ownRow]
  }
  const sumRow = (kind: StatusRowKind, group: LineGroup, depth: number, label: string, parts: StatusRow[], extra: Partial<StatusRow>): StatusRow => {
    const r: StatusRow = {
      kind, group, depth, label, ...extra,
      figures: figures(sum(parts.map(p => p.figures.budget)), sum(parts.map(p => p.figures.actual))),
      ...(input.byMonth && { months: months.map((_, i) => figures(sum(parts.map(p => p.months![i].budget)), sum(parts.map(p => p.months![i].actual)))) })
    }
    archivedOf.set(r, sum(parts.map(p => archivedOf.get(p) ?? 0)))
    return r
  }

  const accountName = (id: string) => accounts.get(id)?.name
  for (const group of GROUPS) {
    const seen = new Set<string>()
    for (const root of (children.get(null) ?? []).filter(c => c.kind === group).sort(byName)) rows.push(...branch(root, 0, seen))
    for (const line of lines) {
      if (line.target.kind === 'category' && !byId.has(line.target.categoryId) && kindOf(line) === group) rows.push(lineRow(line, 'deletedCategory', '(deleted category)', 0))
    }
    const transfers = lines.filter(l => l.target.kind === 'transfer' && kindOf(l) === group)
      .map(l => ({ line: l, name: accountName((l.target as { accountId: string }).accountId) }))
      .sort((a, b) => (a.name ?? '\uffff').localeCompare(b.name ?? '\uffff'))
    for (const { line, name } of transfers) {
      rows.push(name === undefined
        ? lineRow(line, 'deletedAccount', '(deleted account)', 0)
        : lineRow(line, 'transferLine', `${group === 'income' ? 'Transfers from' : 'Transfers to'} ${name}`, 0))
    }
    const others: [StatusRowKind, string, string][] = [
      ['other', `other:${group}`, group === 'income' ? 'Other income' : 'Other expenses'],
      ['otherTransfers', `otherTransfers:${group}`, group === 'income' ? 'Other transfers in' : 'Other transfers out'],
      ['uncategorised', `uncategorised:${group}`, 'Uncategorised']
    ]
    for (const [kind, key, label] of others) {
      const b = buckets.get(key)
      if (!b || b.count === 0) continue
      const breakdown: BreakdownEntry[] | undefined = b.breakdown && [...b.breakdown]
        .map(([id, actual]) => ({ id, label: kind === 'other' ? categoryLabel(categories, id) ?? id : accountName(id) ?? '(deleted account)', actual }))
        .sort((x, y) => y.actual - x.actual || x.label.localeCompare(y.label))
      rows.push(row(kind, group, 0, label, months.map(() => 0), b, breakdown ? { breakdown } : {}))
    }
  }

  // ---- Warnings, totals, what came from archives
  for (const r of rows) {
    if (r.group !== 'expense' || !['line', 'parentLine', 'subtotal', 'transferLine', 'deletedCategory', 'deletedAccount'].includes(r.kind)) continue
    // Spending past the budget is over it, a budget of 0 included (a line stopped with 0, and spent on all the same)
    if (r.figures.actual > r.figures.budget) r.warning = 'over'
    // actual ≥ warnAt % of budget, exactly: BigInt, as the product can pass the safe integers. A share of 0 means nothing
    else if (r.figures.budget > 0 && BigInt(r.figures.actual) * 100n >= BigInt(input.warnAtPercent) * BigInt(r.figures.budget)) r.warning = 'near'
  }
  const counted = rows.filter(r => r.kind !== 'subtotal')
  const total = (group: LineGroup) => {
    const of = counted.filter(r => r.group === group)
    return figures(sum(of.map(r => r.figures.budget)), sum(of.map(r => r.figures.actual)))
  }
  const income = total('income'), expenses = total('expense')
  const netOf = (inc: Figures, exp: Figures): Figures => {
    const budget = inc.budget - exp.budget, actual = inc.actual - exp.actual
    return { budget, actual, remaining: actual - budget }
  }
  const net = netOf(income, expenses)
  // Each month's totals, for the year grid: the same rows, a month at a time
  const monthly = input.byMonth ? months.map((_, i) => {
    const of = (group: LineGroup) => {
      const parts = counted.filter(r => r.group === group)
      return figures(sum(parts.map(r => r.months![i].budget)), sum(parts.map(r => r.months![i].actual)))
    }
    const inc = of('income'), exp = of('expense')
    return { income: inc, expenses: exp, net: netOf(inc, exp) }
  }) : undefined

  const archived: Record<number, number> = {}
  rows.forEach((r, i) => { const a = archivedOf.get(r) ?? 0; if (a !== 0) archived[i] = a })

  const status: BudgetStatus = {
    budget, months: [...months], rows, totals: { income, expenses, net }, ...(monthly && { monthlyTotals: monthly }), notCounted: input.notCounted,
    ...(Object.keys(archived).length > 0 && { archived })
  }
  checkSafe(status)
  return status
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const figures = (budget: number, actual: number): Figures => ({ budget, actual, remaining: budget - actual })

/** Every figure is a safe integer, or the status isn't given at all: a wrong total is worse than none. */
function checkSafe(status: BudgetStatus) {
  const figuresOf = (f: Figures) => [f.budget, f.actual, f.remaining]
  const all = [
    ...status.rows.flatMap(r => [...figuresOf(r.figures), ...(r.months ?? []).flatMap(figuresOf)]),
    ...[status.totals, ...(status.monthlyTotals ?? [])].flatMap(t => Object.values(t).flatMap(figuresOf))
  ]
  if (!all.every(n => Number.isSafeInteger(n))) throw new BudgetError('INVALID', 'These amounts are too large to total exactly.', 'months')
}
