// 4. Net Worth: are we better off? Assets and liabilities at every month end, and net worth, their plain sum (what is
// owed is negative). See docs/reporting-design.md, "4. Net Worth".
import { BALANCES_SOURCE, REPORT_GROUPS, type ReportDefinitionContribution } from '@tessera/reports-api'

export const NET_WORTH: ReportDefinitionContribution = {
  id: 'reports.netWorth',
  label: 'Net Worth',
  description: 'Are you better off? What you own, what you owe, and the difference, month by month.',
  group: REPORT_GROUPS.balances,
  order: 10,
  icon: 'ShowChart',
  version: 1,
  emptyText: 'These accounts held nothing on these dates.',
  spec: {
    specVersion: 1,
    source: BALANCES_SOURCE,
    parameters: { asOf: { ends: { preset: 'last12Months' } }, scope: { kind: 'ledger' }, currency: 'mostUsed', compare: 'none' },
    query: {
      // Closed accounts holding nothing add nothing, and aren't listed
      filters: [{ dimension: 'state', in: ['open'] }],
      rows: { dimension: 'byType', depth: 1, sort: 'natural' },
      columns: { dimension: 'date', grain: 'month' },
      measures: [{ measure: 'balance' }]
    },
    presentation: {
      show: 'both',
      table: { totals: { row: true, label: 'Net worth' } },
      chart: { kind: 'bar', measure: 0, line: { row: 'total' } }
    }
  },
  options: [
    {
      key: 'points', label: 'Points', kind: 'choice', default: 'month', choices: [
        { value: 'month', label: 'Month ends', patch: {} },
        { value: 'quarter', label: 'Quarter ends', patch: { query: { columns: { grain: 'quarter' } } } },
        { value: 'year', label: 'Year ends', patch: { query: { columns: { grain: 'year' } } } }
      ]
    },
    {
      key: 'detail', label: 'Detail', kind: 'choice', default: 'classes', choices: [
        { value: 'classes', label: 'Assets and liabilities', patch: {} },
        { value: 'types', label: 'Account types', patch: { query: { rows: { depth: 2 } } } },
        { value: 'accounts', label: 'Accounts', patch: { query: { rows: { depth: 3 } } } },
        { value: 'subLedgers', label: 'Sub-ledgers', patch: { query: { rows: { dimension: 'byPlace', depth: 1 } } } }
      ]
    },
    {
      key: 'chart', label: 'Chart', kind: 'choice', default: 'bars', choices: [
        { value: 'bars', label: 'Bars, with net worth as a line', patch: {} },
        { value: 'line', label: 'Lines', patch: { presentation: { chart: { kind: 'line' } } } }
      ]
    }
  ]
}
