// What a run produces: a table (columns and rows), a chart's series and notes, every figure an integer, ready to draw.
// The view formats and draws; it never adds. Results are structured-cloneable, so they cross IPC whole.
import type { ReportNote, SourcePeriod } from './source'
import type { ChartSpec } from './spec'

export interface ResultColumn {
  key: string
  label: string
  /** Above the label, for columns that share it: the month or sub-ledger of each of several figures. */
  group?: string
  /** 'percent' values are basis points. */
  unit: 'money' | 'count' | 'percent'
  /** A total across the columns, or an average of them. */
  total?: boolean
  /** What its figures cover, for Show Transactions; absent when they can't be listed (an average, a change). (1.1.) */
  drill?: ColumnDrill
}

/**
 * What a column's figures cover, in the source's terms, from a source that can list transactions (`drillDown`). With a
 * row's `RowDrill`, what one figure stands for; the report manager makes the `DrillRequest` from both and the run.
 */
export interface ColumnDrill {
  /** The measure the figures are of. */
  measure: string
  /** The months ('YYYY-MM') of the period it covers: a time column's, or up to it for a running total. Absent: all. */
  months?: string[]
  /** Its figures are of the period compared with, not the report's. */
  compared?: boolean
  /** Sub-ledgers side by side: the column's scope, by position. */
  scope?: number
  /** A column of members (not time): the column dimension's key. */
  member?: string | null
}

/** What a row's figures gather, in the row dimension's keys. (1.1.) */
export interface RowDrill {
  /** The keys it gathers (a tree's take in their descendants); absent for every row (a total). */
  keys?: (string | null)[]
  /** Only the key itself, not its descendants: what a parent holds of its own ("Food (other)"). */
  own?: boolean
  /** A net: Σ sign × value over its keys (*Net income*), so each transaction is listed with its key's sign. */
  signed?: boolean
}

export type ResultRowKind =
  /** A member of the row dimension. */
  | 'member'
  /** A parent, holding its children's subtotal (sub-totals 'above'), or a "Total …" row after them ('below'). */
  | 'subtotal'
  /** What a parent holds of its own, beside its children: "Food (other)". */
  | 'own'
  /** The rows past the top, gathered: "Other payees (143)". */
  | 'other'
  /** No member: *Uncategorised*, *No payee*. */
  | 'none'
  /** A label above a parent's children (sub-totals 'below'): no figures. */
  | 'heading'
  | 'total'
  /** Σ sign × value over some of a signed dimension's members: *Net income*. */
  | 'net'
  /** *Opening balance*, *Accounts opened*, *Closing balance*. */
  | 'balance'

export interface ResultRow {
  id: string
  label: string
  /** 1 at the top. */
  depth: number
  /** The row it folds under, for a tree. */
  parentId?: string
  kind: ResultRowKind
  /** One per column. Integers: minor units, counts, or basis points. null shows as "—". */
  values: (number | null)[]
  /** Its currency, when the report is in each account's own. */
  currency?: string
  /** A figure here is bad when negative (what is owed; less out than in), for colouring. */
  negativeIsBad?: boolean
  /** What its figures gather, for Show Transactions; absent when they can't be listed (a heading, a balance). (1.1.) */
  drill?: RowDrill
}

export interface ResultChart {
  kind: ChartSpec['kind']
  horizontal?: boolean
  /** The x axis (columns or rows), or the slices. */
  categories: string[]
  series: { key: string, label: string, values: (number | null)[], as?: 'bar' | 'line', stack?: string }[]
  unit: 'money' | 'count'
}

export interface ReportResult {
  title: string
  /** 'January – March 2026 · Whole ledger · CAD'. */
  subtitle: string
  /** null with 'all' currencies: each row's own. */
  currency: string | null
  period: SourcePeriod
  /** The earlier period compared with, when *Compare with* is one. */
  compared?: SourcePeriod
  columns: ResultColumn[]
  rows: ResultRow[]
  chart?: ResultChart
  notes: ReportNote[]
  /** When the figures were worked out (ISO 8601). */
  at: string
}
