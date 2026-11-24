// Report definitions and specs: what a plugin contributes to `reports.definitions`, as plain data. A spec names its
// source, what to group by and add up, how to lay it out, and the defaults of what the report's heading offers; options
// are named patches on it. No code, and no ids of anything in a ledger. See docs/reporting-design.md, "Report
// definitions".
import type { Filter, ScopeValue } from './source'

/** What a plugin contributes to `reports.groups`: a heading in the Reports tab, a submenu of the Reports menu. */
export interface ReportGroupContribution {
  /** Starts with the contributing plugin's id. */
  id: string
  label: string
  order?: number
}

/** What a plugin contributes to `reports.definitions`. */
export interface ReportDefinitionContribution {
  /** Starts with the contributing plugin's id. */
  id: string
  label: string
  description: string
  /** A `reports.groups` contribution. */
  group: string
  order?: number
  /** A standard icon name. */
  icon?: string
  /** A context-key expression: offered only while it is true (`budget.hasBudgets`). */
  when?: string
  /** Raised when a saved report of this definition would read differently. */
  version: number
  spec: ReportSpec
  /** What *Customise Report…* offers. */
  options?: ReportOption[]
  /** What the view says when there is nothing to show. */
  emptyText?: string
}

export interface ReportSpec {
  specVersion: number
  /** A `reports.sources` contribution. */
  source: string
  parameters: ParameterDefaults
  query: ReportQuery
  presentation: Presentation
}

export type PeriodPreset =
  | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'thisYear' | 'lastYear' | 'yearToDate'
  | 'last3Months' | 'last12Months' | 'allDates'

/** The dates a report covers. Presets stay relative when saved; a custom period is its dates. */
export type PeriodValue = { preset: PeriodPreset } | { from: string, to: string }

/** One date; or the end of each month, quarter or year (the time axis's grain) in a period: Net Worth's points. */
export type AsOfValue =
  | { at: 'today' | 'endOfLastMonth' | 'endOfLastYear' }
  | { date: string }
  | { ends: PeriodValue }

/** What *Compare with* is set to. */
export type CompareValue = 'none' | 'previousPeriod' | 'previousYear' | 'subLedgers' | { asOf: AsOfValue }

/** What *Compare with* may offer: 'asOf' is a date of the user's choosing (balances). */
export type CompareOption = 'previousPeriod' | 'previousYear' | 'subLedgers' | 'asOf'

/** The defaults of what the report's heading offers. Relative or ledger-free values only: no ids in a definition. */
export interface ParameterDefaults {
  /** For range sources. */
  period?: PeriodValue
  /** For asOf sources. */
  asOf?: AsOfValue
  scope?: ScopeValue
  /** 'mostUsed': the currency most accounts in scope use; 'all': each account's own (balances only). */
  currency?: 'mostUsed' | 'all' | string
  compare?: CompareValue
  /** What *Compare with* offers; default nothing. */
  compareOptions?: CompareOption[]
  /** The source's own parameters; left out, the default its `members` marks. */
  source?: Record<string, string>
  /** Dimensions whose members the user may pick in the heading (Category Trends: *Categories*). */
  choose?: string[]
}

export interface ReportQuery {
  filters?: Filter[]
  rows?: Axis
  columns?: Axis
  measures: MeasureUse[]
}

/** A dimension laid out down the rows or across the columns. */
export interface Axis {
  dimension: string
  /** For a tree: how deep its rows go (1 is the top), or 'all'. */
  depth?: number | 'all'
  /** For time: months, quarters or years (by the ledger's year start). */
  grain?: 'month' | 'quarter' | 'year'
  /**
   * 'natural': the members' own order; by label; or by value (the first figure's total). A signed tree's top members
   * (its `values`: income, expenses, transfers) always keep their own order; what is beneath them is sorted.
   */
  sort?: 'natural' | 'label' | 'valueDesc' | 'valueAsc'
  /**
   * Keep this many rows (at the top of a tree) by the sort, and gather the rest as *Other*. 'user': as many as the user
   * chose, for this report (*Show the top*) or on the Reports page (*Rows before "Other"*, 25 by default). (R4.)
   */
  top?: number | 'user'
  /** Members with nothing: hidden (the default), or shown with "—". */
  empty?: 'hide' | 'show'
  /**
   * For a tree whose parents are shown: 'above', a parent's row holds its subtotal with its children beneath (the
   * default); 'below', each top member has a heading above its children and a "Total …" row after them, as the budget
   * view draws its groups (deeper parents still hold their subtotals above).
   */
  subtotals?: 'above' | 'below'
}

/** A figure shown: a measure of the source, and how. */
export interface MeasureUse {
  measure: string
  label?: string
  /**
   * 'value'; 'share' of its column's total; 'compared', the earlier period's value; 'change' from it; 'changePercent'
   * of it; 'average' over the columns (one column, after the totals); 'cumulative', a running total across columns.
   * 'compared', 'change' and 'changePercent' appear only while *Compare with* is an earlier period or date.
   * 'percentOf' (R5): the measure as a share of another, `of`, in each cell (a budget's *% used*: actual of budget).
   */
  show?: 'value' | 'share' | 'compared' | 'change' | 'changePercent' | 'average' | 'cumulative' | 'percentOf'
  /** For 'percentOf': the measure it is a share of. */
  of?: string
}

/** A net row over a signed dimension's top members: Σ sign × value over `of` (default all), drawn after `after`. */
export interface NetSpec {
  label: string
  of?: string[]
  after?: string
  /**
   * Measures the net reads the other way (R5): a budget's *Remaining* is budget less actual on each row, but on the net
   * it is how far ahead of the plan the period is, actual net less budget net.
   */
  negate?: string[]
}

export interface TableSpec {
  /** A total row (labelled *Total*, or as given: *Net worth*), and a total column across the columns. */
  totals?: { row?: boolean, column?: boolean, label?: string }
  nets?: NetSpec[]
  /** *Opening balance* first, *Closing balance* last, *Accounts opened* when there were any: from the source's measures. */
  balanceRows?: boolean
}

export type ChartSpec =
  | {
      kind: 'bar' | 'stackedBar' | 'groupedBar' | 'line' | 'area'
      /** The figure drawn: an index into `query.measures`. */
      measure: number
      /** Series from the rows (the default) or the measures. */
      series?: 'rows' | 'measures'
      horizontal?: boolean
      /** The most series (or, with no columns, bars) drawn. */
      limit?: number
      /** A line over the bars: the first net row, or the total row. */
      line?: { row: 'net' | 'total' }
      /** With `series: 'measures'` (R5): the figures drawn side by side, indexes into `query.measures` (Budget, Actual). */
      measures?: number[]
      /** With no columns (R5): the rows under this top member of a signed tree are the bars (the expense lines). */
      under?: string
    }
  | { kind: 'donut', measure: number, slices?: number }

export interface Presentation {
  /** What the view opens on. */
  show: 'chart' | 'table' | 'both'
  table: TableSpec
  chart?: ChartSpec
}

/** A JSON merge patch (RFC 7396) over `query` and `presentation`: objects merge, arrays and values replace, null removes. */
export interface SpecPatch {
  query?: object
  presentation?: object
}

/** A choice *Customise Report…* offers: a named patch on the spec. */
export interface ReportOption {
  key: string
  label: string
  description?: string
  kind: 'choice' | 'boolean'
  default: string | boolean
  choices?: { value: string, label: string, patch: SpecPatch }[]
  /** For a boolean: applied when true. */
  patch?: SpecPatch
}

/** Option values by key. */
export type OptionValues = Record<string, string | boolean>
