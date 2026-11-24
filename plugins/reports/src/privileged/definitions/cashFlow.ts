// 6. Cash Flow: how much came into and went out of the everyday accounts (chequing, savings, credit cards and lines of
// credit), and what is left, with the balances at each month's edges: opening + in − out + accounts opened = closing.
// See docs/reporting-design.md, "6. Cash Flow".
import { EVERYDAY_ACCOUNT_TYPES, FLOWS_SOURCE, REPORT_GROUPS, type ReportDefinitionContribution } from '@tessera/reports-api'

export const CASH_FLOW: ReportDefinitionContribution = {
  id: 'reports.cashFlow',
  label: 'Cash Flow',
  description: 'What came into and went out of your everyday accounts, and what is left, month by month.',
  group: REPORT_GROUPS.spending,
  order: 50,
  icon: 'ShowChart',
  version: 1,
  emptyText: 'Nothing came into or went out of these accounts in this period.',
  spec: {
    specVersion: 1,
    source: FLOWS_SOURCE,
    parameters: {
      period: { preset: 'thisYear' }, scope: { kind: 'types', types: [...EVERYDAY_ACCOUNT_TYPES] }, currency: 'mostUsed',
      compare: 'none', compareOptions: ['subLedgers']
    },
    query: {
      rows: { dimension: 'flow', depth: 2, sort: 'valueDesc' },
      columns: { dimension: 'month', grain: 'month' },
      measures: [{ measure: 'amount' }]
    },
    presentation: {
      show: 'both',
      // One net, after transfers: Cash Flow is about money, whatever it was for
      table: { totals: { column: true }, nets: [{ label: 'Net' }], balanceRows: true },
      chart: { kind: 'groupedBar', measure: 0, line: { row: 'net' } }
    }
  },
  options: [
    {
      key: 'detail', label: 'Detail', kind: 'choice', default: 'top', choices: [
        { value: 'groups', label: 'Money in and out only', patch: { query: { rows: { depth: 1 } } } },
        { value: 'top', label: 'Top-level categories and accounts', patch: {} }
      ]
    },
    {
      key: 'columns', label: 'Columns', kind: 'choice', default: 'month', choices: [
        { value: 'month', label: 'Months', patch: {} },
        { value: 'quarter', label: 'Quarters', patch: { query: { columns: { grain: 'quarter' } } } }
      ]
    }
  ]
}
