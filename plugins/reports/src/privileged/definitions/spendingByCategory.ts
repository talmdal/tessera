// 2. Spending by Category: where did the money go? Each category's spending and its share of the whole, as a donut.
// See docs/reporting-design.md, "2. Spending by Category" and "Report definitions".
import { FLOWS_SOURCE, REPORT_GROUPS, type ReportDefinitionContribution } from '@tessera/reports-api'

export const SPENDING_BY_CATEGORY: ReportDefinitionContribution = {
  id: 'reports.spendingByCategory',
  label: 'Spending by Category',
  description: 'Where the money went: each category’s spending, and its share of the whole.',
  group: REPORT_GROUPS.spending,
  order: 20,
  icon: 'ShowChart',
  version: 1,
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
      rows: { dimension: 'category', depth: 1, sort: 'valueDesc', empty: 'hide' },
      measures: [
        { measure: 'amount', label: 'Spending' },
        { measure: 'amount', label: 'Share', show: 'share' },
        // Only while Compare with is set: labelled with the earlier period ("2025")
        { measure: 'amount', show: 'compared' },
        { measure: 'amount', label: 'Change', show: 'change' }
      ]
    },
    presentation: {
      show: 'both',
      table: { totals: { row: true } },
      chart: { kind: 'donut', measure: 0, slices: 8 }
    }
  },
  options: [
    {
      key: 'detail', label: 'Categories', kind: 'choice', default: 'top', choices: [
        { value: 'top', label: 'Top-level categories', patch: { query: { rows: { depth: 1 } } } },
        { value: 'all', label: 'Every category, as a tree', patch: { query: { rows: { depth: 'all' } } } }
      ]
    },
    // Arrays replace, so the patch gives the whole list, and the chart's figure moves with it
    {
      key: 'refunds', label: 'Show spent and refunded apart', kind: 'boolean', default: false, patch: {
        query: {
          measures: [
            { measure: 'moneyOut', label: 'Spent' }, { measure: 'moneyIn', label: 'Refunded' },
            { measure: 'amount', label: 'Spending' }, { measure: 'amount', label: 'Share', show: 'share' },
            { measure: 'amount', show: 'compared' }, { measure: 'amount', label: 'Change', show: 'change' }
          ]
        },
        presentation: { chart: { measure: 2 } }
      }
    }
  ]
}
