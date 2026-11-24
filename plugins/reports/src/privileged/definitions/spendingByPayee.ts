// 3. Spending by Payee: who gets the most? The top payees by spending (25, unless the user chose another number on the
// Reports page or for this report), the rest together, and those with no payee.
// Its total is Spending by Category's for the same period and accounts. See docs/reporting-design.md, "3. Spending by
// Payee".
import { FLOWS_SOURCE, REPORT_GROUPS, type MeasureUse, type ReportDefinitionContribution } from '@tessera/reports-api'

const measures = (what: string): MeasureUse[] => [
  { measure: 'amount', label: what },
  { measure: 'count', label: 'Transactions' },
  { measure: 'amount', label: 'Share', show: 'share' },
  { measure: 'amount', show: 'compared' },
  { measure: 'amount', label: 'Change', show: 'change' }
]

export const SPENDING_BY_PAYEE: ReportDefinitionContribution = {
  id: 'reports.spendingByPayee',
  label: 'Spending by Payee',
  description: 'Who gets the most: the shops and companies your money went to, largest first.',
  group: REPORT_GROUPS.spending,
  order: 30,
  icon: 'ShowChart',
  // 2 (R4): the top rows are the user's (*Show the top*, the Reports page), not an option of its own
  version: 2,
  emptyText: 'Nothing was spent from these accounts in this period.',
  spec: {
    specVersion: 1,
    source: FLOWS_SOURCE,
    parameters: {
      period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed',
      compare: 'none', compareOptions: ['previousPeriod', 'previousYear', 'subLedgers']
    },
    query: {
      filters: [{ dimension: 'group', in: ['expense'] }],
      rows: { dimension: 'payee', sort: 'valueDesc', top: 'user' },
      measures: measures('Spending')
    },
    presentation: {
      show: 'both',
      table: { totals: { row: true } },
      chart: { kind: 'bar', measure: 0, horizontal: true, limit: 10 }
    }
  },
  options: [
    {
      // The filter and the labels change together, so spending and income are never added up
      key: 'what', label: 'Spending or income', kind: 'choice', default: 'spending', choices: [
        { value: 'spending', label: 'Spending: who you paid', patch: {} },
        { value: 'income', label: 'Income: who paid you', patch: { query: { filters: [{ dimension: 'group', in: ['income'] }], measures: measures('Income') } } }
      ]
    }
  ]
}
