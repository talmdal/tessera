// 1. Income vs Expenses: did we earn more than we spent, month by month? Income and expenses, each by its top-level
// categories, months across, with Net income; over a sub-ledger, transfers across it after Net income, then Net after
// transfers. See docs/reporting-design.md, "1. Income vs Expenses".
import { FLOWS_SOURCE, REPORT_GROUPS, type ReportDefinitionContribution } from '@tessera/reports-api'

export const INCOME_VS_EXPENSES: ReportDefinitionContribution = {
  id: 'reports.incomeVsExpenses',
  label: 'Income vs Expenses',
  description: 'Did you earn more than you spent? Income and expenses by category, month by month, and what was left.',
  group: REPORT_GROUPS.spending,
  order: 10,
  icon: 'ShowChart',
  version: 1,
  emptyText: 'Nothing came in or went out of these accounts in this period.',
  spec: {
    specVersion: 1,
    source: FLOWS_SOURCE,
    parameters: {
      period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed',
      compare: 'none', compareOptions: ['subLedgers']
    },
    query: {
      // Income, expenses and transfers keep their order; what is in each, largest first
      rows: { dimension: 'flow', depth: 2, sort: 'valueDesc', subtotals: 'below' },
      columns: { dimension: 'month', grain: 'month' },
      measures: [{ measure: 'amount' }]
    },
    presentation: {
      show: 'both',
      table: {
        totals: { column: true },
        nets: [
          { label: 'Net income', of: ['income', 'expense'], after: 'expense' },
          // Left out when it would repeat Net income: over the whole ledger, no transfer crosses it
          { label: 'Net after transfers' }
        ]
      },
      chart: { kind: 'groupedBar', measure: 0, line: { row: 'net' } }
    }
  },
  options: [
    {
      key: 'detail', label: 'Detail', kind: 'choice', default: 'top', choices: [
        { value: 'groups', label: 'Totals only', patch: { query: { rows: { depth: 1 } } } },
        { value: 'top', label: 'Top-level categories', patch: {} },
        { value: 'all', label: 'Every category', patch: { query: { rows: { depth: 'all' } } } }
      ]
    },
    {
      key: 'columns', label: 'Columns', kind: 'choice', default: 'month', choices: [
        { value: 'month', label: 'Months', patch: {} },
        { value: 'quarter', label: 'Quarters', patch: { query: { columns: { grain: 'quarter' } } } },
        { value: 'year', label: 'Years', patch: { query: { columns: { grain: 'year' } } } }
      ]
    },
    {
      key: 'chart', label: 'Chart', kind: 'choice', default: 'bars', choices: [
        { value: 'bars', label: 'Income and expenses as bars, with the net', patch: {} },
        { value: 'none', label: 'No chart', patch: { presentation: { chart: null, show: 'table' } } }
      ]
    },
    {
      key: 'withoutTransfers', label: 'Leave out transfers across the accounts chosen', kind: 'boolean', default: false,
      patch: { query: { filters: [{ dimension: 'group', in: ['income', 'expense'] }] } }
    }
  ]
}
