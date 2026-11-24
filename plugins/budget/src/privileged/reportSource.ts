// The budget as a source of reports (`budget.status`, phase R5): what `budget.service.status` answers, as the report
// manager asks for it. Every figure is the status's: one source row for each row that isn't a subtotal (a line, a
// parent's own line, Other, Other transfers, Uncategorised), placed in the status's own tree, so the report manager's
// engine adds up exactly the subtotals and totals the budget view shows. No rule of the budget's is repeated here.
// See docs/reporting-design.md, "7. Budget vs Actual" and "Adding a report from another plugin".
import type { Disposable, Event, Logger } from '@tessera/types'
import type { LedgerSession } from '@tessera/ledger-api'
import {
  BUDGET_REPORTS, STATUS_MONTHS_MAX, isBudgetError,
  type BudgetStatus, type LineGroup, type MonthRange, type RowRef, type StatusRow
} from '@tessera/budget-api'
import {
  ReportsError,
  type DrillRequest, type DrillResult, type Member, type MembersRequest, type ReportNote, type ReportSource, type ReportSourceContribution,
  type SourceQuery, type SourceResult, type SourceRow
} from '@tessera/reports-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'
import type { BudgetViewSupport } from './viewSupport'
import { coversLabel } from './viewState'

const GROUPS = [
  { id: 'income', label: 'Income', sign: 1 as const },
  // Less left of an expense budget than nothing is over budget: red. Under income, it is more than planned came in
  { id: 'expense', label: 'Expenses', sign: -1 as const, negativeIsBad: true }
]

/** What `budget.status` can answer, for the report manager. */
export const STATUS_SOURCE: ReportSourceContribution = {
  id: BUDGET_REPORTS.source,
  label: 'Budget',
  description: 'What a budget planned for each line, and what came in and went out against it.',
  service: BUDGET_REPORTS.service,
  time: 'months',
  maxPeriods: STATUS_MONTHS_MAX,
  // The budget has its own scope and currency
  scopes: 'none',
  currency: false,
  parameters: [{ key: 'budget', label: 'Budget', kind: 'member' }],
  drillDown: true,
  fields: [
    { kind: 'dimension', key: 'line', label: 'Line', type: 'member', tree: true, signed: true, values: GROUPS, plural: 'lines' },
    { kind: 'dimension', key: 'group', label: 'Income or expense', type: 'enum', signed: true, values: GROUPS },
    { kind: 'dimension', key: 'month', label: 'Month', type: 'time' },
    // A plan, and what is left of it, have no transactions behind them: only the actual can be listed
    { kind: 'measure', key: 'budget', label: 'Budget', unit: 'money', combine: 'sum', drillDown: false },
    { kind: 'measure', key: 'actual', label: 'Actual', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'remaining', label: 'Remaining', unit: 'money', combine: 'sum', drillDown: false }
  ]
}

/** Where a status row sits among the members of `line`: its key, and the member it adds (a subtotal's, a line's). */
interface Placed {
  row: StatusRow
  /** The member its figures go to: its own, or (a parent's own line) its parent's, as "Food (other)". */
  key: string
  /** What Show Transactions asks the budget for. */
  ref: RowRef
}

/**
 * The status's rows as the `line` dimension's members, in the status's order and tree: a subtotal is a member with
 * children; a parent's own line adds to its subtotal's member (the engine shows it as "Food (other)"); every other
 * row is a member of its own, beneath its group.
 */
export function placeRows(status: BudgetStatus): { members: Member[], placed: Placed[] } {
  const members: Member[] = []
  const placed: Placed[] = []
  let stack: { depth: number, id: string }[] = []
  let group: LineGroup | undefined
  status.rows.forEach((row, order) => {
    if (row.group !== group) { group = row.group; stack = [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth) stack.pop()
    const parentId = stack[stack.length - 1]?.id ?? row.group
    switch (row.kind) {
      case 'subtotal': {
        const id = `c:${row.categoryId}`
        members.push({ id, label: row.label, parentId, order })
        stack.push({ depth: row.depth, id })
        return
      }
      case 'parentLine':
        placed.push({ row, key: parentId, ref: { kind: 'parentLine', group: row.group, lineId: row.lineId! } })
        return
      case 'other': case 'otherTransfers': case 'uncategorised': {
        const id = `${row.kind}:${row.group}`
        members.push({ id, label: row.label, parentId: row.group, order, ...(row.kind === 'uncategorised' && { none: true }) })
        placed.push({ row, key: id, ref: { kind: row.kind, group: row.group } })
        return
      }
      default: {
        const id = `l:${row.lineId}`
        members.push({ id, label: row.label, parentId, order })
        placed.push({ row, key: id, ref: { kind: row.kind, group: row.group, ...(row.lineId && { lineId: row.lineId }) } })
      }
    }
  })
  return { members, placed }
}

/** A status as the rows a query asked for: by `line`, `group` and `month`, in the order of `measures`. */
export function statusRows(status: BudgetStatus, placed: readonly Placed[], request: Pick<SourceQuery, 'dimensions' | 'measures'>): SourceRow[] {
  const byMonth = request.dimensions.includes('month')
  const currency = status.budget.currency
  const rows: SourceRow[] = []
  for (const p of placed) {
    const periods = byMonth ? status.months.map((month, i) => ({ month, figures: p.row.months![i] })) : [{ month: null, figures: p.row.figures }]
    // A line with neither a budget nor an actual in the period isn't shown, as the budget view leaves it out
    if (periods.every(x => x.figures.budget === 0 && x.figures.actual === 0)) continue
    for (const { month, figures } of periods) {
      const keys = request.dimensions.map(d => d === 'line' ? p.key : d === 'group' ? p.row.group : month)
      const values = request.measures.map(m => m === 'budget' ? figures.budget : m === 'actual' ? figures.actual : m === 'remaining' ? figures.remaining : 0)
      rows.push({ keys, values, currency })
    }
  }
  return rows
}

export interface ReportSourceDeps {
  service: BudgetServiceImpl
  support: BudgetViewSupport
  session: LedgerSession
  log: Pick<Logger, 'warn' | 'error'>
  /** The budget the budget view shows: the report's budget unless one is chosen. */
  shown: () => string | null
}

export class BudgetReportSource implements ReportSource {
  readonly onDidChange: Event<void>

  constructor(private readonly deps: ReportSourceDeps) {
    // Any change to a budget, its lines or its actuals: reports on budgets may have changed
    this.onDidChange = (listener: () => void): Disposable => deps.service.onDidChange(() => listener())
  }

  /** The budget a request names, or the one the budget view shows, or the first. */
  private async budgetOf(parameters: Record<string, string>) {
    const asked = parameters.budget
    const budgets = await this.deps.service.list()
    const id = typeof asked === 'string' && asked !== '' ? asked : this.deps.shown() ?? budgets[0]?.id
    const budget = budgets.find(b => b.id === id)
    if (!budget) {
      throw new ReportsError('NOT_FOUND', id === undefined ? 'This ledger has no budget.' : 'That budget no longer exists.', 'parameters.source.budget')
    }
    return budget
  }

  private months(period: SourceQuery['period']): MonthRange {
    if (!('from' in period)) throw new ReportsError('INVALID', 'A budget is reported over months.', 'period')
    return { from: period.from.slice(0, 7), to: period.to.slice(0, 7) }
  }

  /** A call into the budget, its errors as the report's. */
  private async status(budgetId: string, months: MonthRange, byMonth: boolean): Promise<BudgetStatus> {
    try {
      return await this.deps.service.status(budgetId, months, { byMonth })
    } catch (err) {
      if (isBudgetError(err)) throw new ReportsError(err.code === 'NO_LEDGER' ? 'NO_LEDGER' : err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID', err.message)
      throw err
    }
  }

  async query(request: SourceQuery): Promise<SourceResult> {
    const budget = await this.budgetOf(request.parameters)
    const status = await this.status(budget.id, this.months(request.period), request.dimensions.includes('month'))
    const { members, placed } = placeRows(status)
    const rows = statusRows(status, placed, request)
    const notes: ReportNote[] = []
    if (status.notCounted.length > 0) {
      notes.push({ tone: 'info', text: `Not counted: ${status.notCounted.map(a => `${a.name}, in ${a.currency}`).join('; ')}.` })
    }
    const tree = await this.deps.session.tree().catch(() => undefined)
    const covers = tree ? coversLabel(budget, tree.subLedgers) : undefined
    return {
      rows, members: request.dimensions.includes('line') ? { line: members } : {}, notes,
      subject: [budget.name, covers].filter(Boolean).join(' · '), currency: budget.currency
    }
  }

  async members(request: MembersRequest): Promise<Member[]> {
    if (request.parameter !== 'budget') return []
    const budgets = await this.deps.service.list()
    const chosen = this.deps.shown() ?? budgets[0]?.id
    return budgets.map(b => ({ id: b.id, label: b.name, ...(b.id === chosen && { isDefault: true }) }))
  }

  /**
   * The transactions behind an actual, as the budget's Transactions dialog lists them (`rowsTransactions`): for a line or
   * an Other row, its own; for a subtotal, its branch's; for a group's total, every row of the group; for the net, both
   * groups, expenses taking away.
   */
  async transactions(request: DrillRequest): Promise<DrillResult> {
    if (request.measure !== 'actual') throw new ReportsError('INVALID', 'Only the actual amounts have transactions behind them.', 'measure')
    const budget = await this.budgetOf(request.parameters)
    const months = this.months(request.period)
    const status = await this.status(budget.id, months, false)
    const { placed } = placeRows(status)
    const wanted = request.key.keys.line
    const own = request.key.own?.includes('line') === true
    const signed = request.key.signed === 'line'
    const signOf = (group: LineGroup): 1 | -1 => signed && group === 'expense' ? -1 : 1
    const parts: { row: RowRef, sign: 1 | -1 }[] = []
    for (const key of wanted ?? ['income', 'expense']) {
      if (key === 'income' || key === 'expense') {
        for (const p of placed.filter(x => x.row.group === key)) parts.push({ row: p.ref, sign: signOf(key) })
      } else if (key !== null && key.startsWith('c:')) {
        const subtotal = status.rows.find(r => r.kind === 'subtotal' && `c:${r.categoryId}` === key)
        if (!subtotal) continue
        // Its own line alone ("Food (other)"), or its whole branch
        const ref: RowRef = own
          ? placed.find(x => x.row.kind === 'parentLine' && x.key === key)?.ref ?? { kind: 'subtotal', group: subtotal.group, categoryId: subtotal.categoryId }
          : { kind: 'subtotal', group: subtotal.group, categoryId: subtotal.categoryId }
        parts.push({ row: ref, sign: signOf(subtotal.group) })
      } else {
        const p = placed.find(x => x.key === key)
        if (p) parts.push({ row: p.ref, sign: signOf(p.row.group) })
      }
    }
    if (parts.length === 0) return { transactions: [], total: 0 }
    const found = await this.deps.support.rowsTransactions(budget.id, parts, months)
    return {
      transactions: found.rows.slice(0, Math.max(0, request.limit)).map(r => ({
        id: r.transactionId, accountId: r.accountId, accountName: r.accountName, date: r.date, amount: r.amount, currency: budget.currency,
        ...(r.payee !== undefined && { payee: r.payee }), ...(r.label !== undefined && { label: r.label })
      })),
      total: found.rows.length,
      ...(found.archived && { archived: { amount: found.archived.amount, before: found.archived.before ?? `${months.from}-01` } })
    }
  }
}
