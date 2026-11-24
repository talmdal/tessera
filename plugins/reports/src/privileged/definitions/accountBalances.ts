// 5. Account Balances: what was in every account on a date? The sub-ledger tree down to each account, with totals per
// sub-ledger and for the ledger, as the navigator lays them out. See docs/reporting-design.md, "5. Account Balances".
import { BALANCES_SOURCE, REPORT_GROUPS, type ReportDefinitionContribution } from '@tessera/reports-api'

export const ACCOUNT_BALANCES: ReportDefinitionContribution = {
  id: 'reports.accountBalances',
  label: 'Account Balances',
  description: 'What was in every account on a date, with totals for each sub-ledger and the ledger.',
  group: REPORT_GROUPS.balances,
  order: 20,
  icon: 'ShowChart',
  version: 1,
  emptyText: 'None of these accounts was open on this date.',
  spec: {
    specVersion: 1,
    source: BALANCES_SOURCE,
    parameters: { asOf: { at: 'today' }, scope: { kind: 'ledger' }, currency: 'mostUsed', compare: 'none', compareOptions: ['asOf'] },
    query: {
      filters: [{ dimension: 'state', in: ['open'] }],
      rows: { dimension: 'byPlace', depth: 'all', sort: 'natural' },
      measures: [
        { measure: 'balance', label: 'Balance' },
        { measure: 'balance', show: 'compared' },
        { measure: 'balance', label: 'Change', show: 'change' }
      ]
    },
    presentation: { show: 'table', table: { totals: { row: true } } }
  },
  options: [
    {
      key: 'groupBy', label: 'Group by', kind: 'choice', default: 'subLedgers', choices: [
        { value: 'subLedgers', label: 'Sub-ledgers', patch: {} },
        { value: 'types', label: 'Account types', patch: { query: { rows: { dimension: 'byType' } } } },
        { value: 'none', label: 'Nothing: accounts only', patch: { query: { rows: { dimension: 'account', depth: null } } } }
      ]
    },
    { key: 'includeClosed', label: 'Include closed accounts', kind: 'boolean', default: false, patch: { query: { filters: null } } },
    {
      key: 'chart', label: 'Show a chart', kind: 'boolean', default: false,
      patch: { presentation: { show: 'both', chart: { kind: 'bar', measure: 0, horizontal: true } } }
    }
  ]
}
