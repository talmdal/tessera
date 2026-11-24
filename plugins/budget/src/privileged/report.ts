// Budget vs Actual (phase R5): the first report another plugin adds. The Budgets group in the Reports tab and menu, and
// the definition, on the budget's own source (reportSource.ts): the budget view's rows, with Budget, Actual, Remaining
// and % used, income and expenses totalled and the net, whose Remaining is how far ahead of the plan the period is.
// Offered only while the ledger has a budget. See docs/reporting-design.md, "7. Budget vs Actual".
import { BUDGET_CONTEXT_KEYS, BUDGET_REPORTS } from '@tessera/budget-api'
import type { MeasureUse, ReportDefinitionContribution, ReportGroupContribution, SpecPatch } from '@tessera/reports-api'

/** Budgets, after the reports plugin's Income and Spending (0) and Net Worth and Balances (10). */
export const BUDGETS_GROUP: ReportGroupContribution = { id: BUDGET_REPORTS.group, label: 'Budgets', order: 30 }

const MEASURES: MeasureUse[] = [
  { measure: 'budget' },
  { measure: 'actual' },
  { measure: 'remaining' },
  { measure: 'actual', show: 'percentOf', of: 'budget', label: '% used' }
]

/** Months across, one figure in each, as the budget view's Year shows them: a total across, and no chart. */
const byMonth = (measure: 'budget' | 'actual' | 'remaining'): SpecPatch => ({
  query: { columns: { dimension: 'month', grain: 'month' }, measures: [{ measure }] },
  presentation: { show: 'table', table: { totals: { column: true } }, chart: null }
})

export const BUDGET_VS_ACTUAL: ReportDefinitionContribution = {
  id: BUDGET_REPORTS.vsActual,
  label: 'Budget vs Actual',
  description: 'How did the plan go? What each line of a budget planned, what came in or went out, and what is left.',
  group: BUDGETS_GROUP.id,
  order: 10,
  icon: 'ShowChart',
  when: BUDGET_CONTEXT_KEYS.hasBudgets,
  version: 1,
  emptyText: 'This budget has nothing planned, and nothing came in or went out against it, in this period.',
  spec: {
    specVersion: 1,
    source: BUDGET_REPORTS.source,
    // The budget: the one the budget view shows, unless chosen. Its scope and currency are its own
    parameters: { period: { preset: 'thisMonth' }, compare: 'none' },
    query: {
      // The budget view's rows, in its order: income, then expenses, each with its total
      rows: { dimension: 'line', depth: 'all', sort: 'natural', subtotals: 'below' },
      measures: MEASURES
    },
    presentation: {
      show: 'both',
      // The net's Remaining is how far ahead of the plan: actual net less budget net, as the budget view shows it
      table: { nets: [{ label: 'Net', of: ['income', 'expense'], negate: ['remaining'] }] },
      // The plan beside the actual for each expense line
      chart: { kind: 'groupedBar', measure: 1, series: 'measures', measures: [0, 1], under: 'expense' }
    }
  },
  options: [
    {
      key: 'layout', label: 'Layout', kind: 'choice', default: 'period', choices: [
        { value: 'period', label: 'The period as a whole: budget, actual, remaining and % used', patch: {} },
        { value: 'budget', label: 'Month by month: the budget', patch: byMonth('budget') },
        { value: 'actual', label: 'Month by month: the actual', patch: byMonth('actual') },
        { value: 'remaining', label: 'Month by month: what remains', patch: byMonth('remaining') }
      ]
    },
    {
      // No net of expenses alone: it would be the expenses, negative
      key: 'expensesOnly', label: 'Expense lines only', kind: 'boolean', default: false,
      patch: { query: { filters: [{ dimension: 'group', in: ['expense'] }] }, presentation: { table: { nets: null } } }
    }
  ]
}
