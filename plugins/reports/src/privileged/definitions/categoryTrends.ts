// 8. Category Trends: is a habit creeping up? The top six categories' spending month by month, with a total and an
// average a month, as lines. The categories can be picked in the heading. See docs/reporting-design.md, "8. Category
// Trends".
import { FLOWS_SOURCE, REPORT_GROUPS, type MeasureUse, type ReportDefinitionContribution } from '@tessera/reports-api'

const measures = (average: string): MeasureUse[] => [
  { measure: 'amount' },
  // Only while Compare with is set: last year's figure beside each month's
  { measure: 'amount', show: 'compared' },
  { measure: 'amount', label: average, show: 'average' }
]

export const CATEGORY_TRENDS: ReportDefinitionContribution = {
  id: 'reports.categoryTrends',
  label: 'Category Trends',
  description: 'Is a habit creeping up? Your largest categories month by month, with the average.',
  group: REPORT_GROUPS.spending,
  order: 40,
  icon: 'ShowChart',
  version: 1,
  emptyText: 'Nothing was spent from these accounts in this period.',
  spec: {
    specVersion: 1,
    source: FLOWS_SOURCE,
    parameters: {
      period: { preset: 'last12Months' }, scope: { kind: 'ledger' }, currency: 'mostUsed',
      compare: 'none', compareOptions: ['previousYear', 'previousPeriod'], choose: ['category']
    },
    query: {
      filters: [{ dimension: 'group', in: ['expense'] }],
      rows: { dimension: 'category', depth: 1, sort: 'valueDesc', top: 6 },
      columns: { dimension: 'month', grain: 'month' },
      measures: measures('Average a month')
    },
    presentation: {
      show: 'both',
      table: { totals: { column: true } },
      chart: { kind: 'line', measure: 0 }
    }
  },
  options: [
    {
      key: 'detail', label: 'Detail', kind: 'choice', default: 'top', choices: [
        { value: 'top', label: 'Top-level categories', patch: {} },
        { value: 'all', label: 'Every category', patch: { query: { rows: { depth: 'all' } } } }
      ]
    },
    {
      key: 'what', label: 'Show', kind: 'choice', default: 'spending', choices: [
        { value: 'spending', label: 'Spending', patch: {} },
        { value: 'income', label: 'Income', patch: { query: { filters: [{ dimension: 'group', in: ['income'] }] } } }
      ]
    },
    {
      key: 'columns', label: 'Columns', kind: 'choice', default: 'month', choices: [
        { value: 'month', label: 'Months', patch: {} },
        { value: 'quarter', label: 'Quarters', patch: { query: { columns: { grain: 'quarter' }, measures: measures('Average a quarter') } } }
      ]
    },
    {
      key: 'chart', label: 'Chart', kind: 'choice', default: 'lines', choices: [
        { value: 'lines', label: 'Lines', patch: {} },
        { value: 'areas', label: 'Stacked areas', patch: { presentation: { chart: { kind: 'area' } } } }
      ]
    }
  ]
}
