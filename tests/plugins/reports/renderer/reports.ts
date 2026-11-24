// Reports to draw, made as the plugin makes them: the shipped definitions' specs shaped by the engine over a few rows
// of the flows source (Income vs Expenses for January to March 2026; Spending by Category for the year), what opening
// one answers, and the catalog. Plain code, no test library: the jsdom tests' fixtures and the browser tests' pages
// both use it.
import {
  columnLabel, shape, timeColumns,
  type OpenedView, type ReportResult, type ReportSpec, type ReportsCatalog, type SourceResult, type SourceRow
} from '@tessera/reports-api'
import { DEFINITIONS } from '../../../../plugins/reports/src/privileged/definitions'
import { FLOWS_CONTRIBUTION } from '../../../../plugins/reports/src/privileged/flows'
import { BUDGET_VS_ACTUAL } from '../../../../plugins/budget/src/privileged/report'
import { STATUS_SOURCE } from '../../../../plugins/budget/src/privileged/reportSource'

const CALENDAR = { month: 1, day: 1 }

const definition = (id: string) => DEFINITIONS.find(d => d.id === `reports.${id}`)!

/** A report as a run makes it: the spec's dimensions asked, the engine's shape, the run's title, subtitle and notes. */
export function resultOf(spec: ReportSpec, title: string, rows: SourceRow[], members: SourceResult['members'], period: { from: string, to: string }, extra: Partial<ReportResult> = {}): ReportResult {
  const q = spec.query
  const dimensions = [...new Set([q.rows?.dimension, q.columns?.dimension, ...(q.filters ?? []).map(f => f.dimension)].filter((d): d is string => d !== undefined))]
  const columns = q.columns ? timeColumns(period, q.columns.grain ?? 'month', CALENDAR).map(c => ({ key: c.key, label: columnLabel(c, CALENDAR), keys: c.keys })) : undefined
  const shaped = shape({ spec, source: FLOWS_CONTRIBUTION, result: { rows, members, notes: [] }, dimensions, measures: [...new Set(q.measures.map(m => m.measure))], ...(columns && { columns }) })
  return {
    title, subtitle: `${period.from.slice(0, 4)} · Whole ledger · CAD`, currency: 'CAD', period, columns: shaped.columns, rows: shaped.rows,
    ...(shaped.chart && { chart: shaped.chart }), notes: shaped.notes, at: '2027-01-15T17:00:00.000Z', ...extra
  }
}

const flow = (id: string, label: string, parentId: string) => ({ id, label, parentId })
/** Income vs Expenses, January to March 2026: salary, rent, groceries; March spent more than came in. */
export const INCOME_ROWS: SourceRow[] = [
  { keys: ['salary', '2026-01'], values: [420000] }, { keys: ['salary', '2026-02'], values: [420000] }, { keys: ['salary', '2026-03'], values: [420000] },
  { keys: ['rent', '2026-01'], values: [150000] }, { keys: ['rent', '2026-02'], values: [150000] }, { keys: ['rent', '2026-03'], values: [450000] },
  { keys: ['groceries', '2026-01'], values: [59830] }, { keys: ['groceries', '2026-02'], values: [61145] }, { keys: ['groceries', '2026-03'], values: [65010] }
]
export const INCOME_MEMBERS = { flow: [flow('salary', 'Salary', 'income'), flow('rent', 'Housing', 'expense'), flow('groceries', 'Food', 'expense')] }
export const Q1 = { from: '2026-01-01', to: '2026-03-31' }
export const incomeResult = (extra: Partial<ReportResult> = {}, rows = INCOME_ROWS) =>
  resultOf(definition('incomeVsExpenses').spec, 'Income vs Expenses', rows, INCOME_MEMBERS, Q1, extra)

const cat = (id: string, label: string, parentId: string | null = null) => ({ id, label, parentId })
/** Spending by Category for 2026: the design's figures, a donut and shares. */
export const spendingResult = (extra: Partial<ReportResult> = {}) => resultOf(definition('spendingByCategory').spec, 'Spending by Category', [
  { keys: ['housing', 'expense'], values: [1842000] }, { keys: ['food', 'expense'], values: [987520] }, { keys: ['transport', 'expense'], values: [431050] },
  { keys: ['utilities', 'expense'], values: [320480] }, { keys: [null, 'expense'], values: [17560] }
], { category: [cat('housing', 'Housing'), cat('food', 'Food'), cat('transport', 'Transportation'), cat('utilities', 'Utilities')] }, { from: '2026-01-01', to: '2026-12-31' }, extra)

/** What `reports:open` answers for a definition: as the plugin would, on a ledger with Personal and Business. */
export function openedOf(id: string, over: Partial<OpenedView> = {}): OpenedView {
  const d = definition(id)
  return {
    ref: { definitionId: d.id }, title: d.label, description: d.description,
    source: { id: 'reports.flows', label: 'Transactions', time: 'range', scopes: ['ledger', 'subLedger', 'types', 'accounts'], currency: true, parameters: [], drillDown: true },
    options: {}, parameters: { period: d.spec.parameters.period!, scope: d.spec.parameters.scope!, currency: 'mostUsed', compare: 'none' },
    compareOptions: d.spec.parameters.compareOptions ?? [], choose: (d.spec.parameters.choose ?? []).map(dimension => ({ dimension, label: 'Category' })),
    grain: 'month', show: d.spec.presentation.show, hasChart: d.spec.presentation.chart !== undefined, collapsed: [], ...(d.emptyText && { emptyText: d.emptyText }), notes: [],
    choices: {
      ledgerName: 'Home',
      subLedgers: [{ id: 'personal', name: 'Personal', parentId: null, order: 0 }, { id: 'business', name: 'Business', parentId: null, order: 1 }],
      accounts: [
        { id: 'pchq', name: 'Personal Chequing', type: 'chequing', subLedgerId: 'personal', currency: 'CAD', closed: false },
        { id: 'bchq', name: 'Business Chequing', type: 'chequing', subLedgerId: 'business', currency: 'CAD', closed: false }
      ],
      currencies: ['CAD', 'USD']
    },
    today: '2027-01-15', yearStart: { month: 1, day: 1 }, readOnly: false, ...over
  }
}

export function catalogOf(over: Partial<ReportsCatalog> = {}): ReportsCatalog {
  return {
    groups: [{ id: 'reports.group.spending', label: 'Income and Spending' }, { id: 'reports.group.balances', label: 'Net Worth and Balances' }],
    definitions: DEFINITIONS.map(d => ({ id: d.id, label: d.label, description: d.description, group: d.group, enabled: true })),
    saved: [], readOnly: false, archive: false, ledgerName: 'Home',
    shown: { ref: { definitionId: 'reports.incomeVsExpenses' }, request: 1 }, changed: false, ...over
  }
}


// ---- Budget vs Actual (R5): the budget plugin's definition, shaped over its source's rows for the budget view's March

/** The budget view's March 2027 of Household, as the budget's source gives it: one row per line, in its tree. */
export function budgetResult(extra: Partial<ReportResult> = {}): ReportResult {
  const member = (id: string, label: string, parentId: string, order: number, none = false) => ({ id, label, parentId, order, ...(none && { none: true }) })
  const members = [
    member('l:interest', 'Interest', 'income', 0), member('l:salary', 'Salary', 'income', 1), member('l:business', 'Transfers from Business Chequing', 'income', 2),
    member('other:income', 'Other income', 'income', 3),
    member('c:food', 'Food', 'expense', 4), member('l:groceries', 'Groceries', 'c:food', 5),
    member('c:housing', 'Housing', 'expense', 7), member('l:insurance', 'Home insurance', 'c:housing', 8), member('l:rent', 'Rent', 'c:housing', 9),
    member('c:transport', 'Transportation', 'expense', 10), member('l:transit', 'Public transit', 'c:transport', 11),
    member('other:expense', 'Other expenses', 'expense', 12), member('uncategorised:expense', 'Uncategorised', 'expense', 13, true)
  ]
  const row = (key: string, budget: number, actual: number): SourceRow => ({ keys: [key], values: [budget, actual, budget - actual], currency: 'CAD' })
  const rows = [
    row('l:interest', 1500, 1240), row('l:salary', 420000, 420000), row('l:business', 300000, 300000), row('other:income', 0, 15000),
    row('l:groceries', 65000, 59830), row('c:food', 15000, 26385), row('l:insurance', 120000, 118700), row('l:rent', 150000, 150000),
    row('l:transit', 17500, 14000), row('other:expense', 0, 8620), row('uncategorised:expense', 0, 4100)
  ]
  const shaped = shape({ spec: BUDGET_VS_ACTUAL.spec, source: STATUS_SOURCE, result: { rows, members: { line: members }, notes: [] }, dimensions: ['line'], measures: ['budget', 'actual', 'remaining'] })
  return {
    title: 'Budget vs Actual', subtitle: 'March 2027 · Household · Personal · CAD', currency: 'CAD', period: { from: '2027-03-01', to: '2027-03-31' },
    columns: shaped.columns, rows: shaped.rows, ...(shaped.chart && { chart: shaped.chart }), notes: [{ tone: 'info', text: 'Not counted: US Visa, in USD.' }],
    at: '2027-03-15T17:00:00.000Z', ...extra
  }
}

/** What opening Budget vs Actual answers: a source with its own scope and currency, and a Budget to choose. */
export function budgetOpened(): OpenedView {
  return {
    ...openedOf('incomeVsExpenses'),
    ref: { definitionId: BUDGET_VS_ACTUAL.id }, title: BUDGET_VS_ACTUAL.label, description: BUDGET_VS_ACTUAL.description,
    source: { id: STATUS_SOURCE.id, label: STATUS_SOURCE.label, time: 'months', scopes: 'none', currency: false, parameters: [...STATUS_SOURCE.parameters!], drillDown: true },
    options: { layout: 'period', expensesOnly: false }, parameters: { period: { preset: 'thisMonth' }, compare: 'none' }, compareOptions: [], choose: [],
    show: 'both', hasChart: true, collapsed: [], emptyText: BUDGET_VS_ACTUAL.emptyText!, today: '2027-03-15'
  }
}
