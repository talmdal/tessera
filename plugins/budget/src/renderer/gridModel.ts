// The rows the budget grid draws, worked out from a status: section headings, the status's rows (less those collapsed,
// or with nothing this period), what an Other row gathers when it is expanded, and the totals. Pure, so it is tested
// without drawing anything.
import type { BreakdownEntry, BudgetStatus, Figures, LineGroup, LineTarget, RowRef, StatusRow } from '@tessera/budget-api'

export type GridRowKind = 'heading' | 'row' | 'breakdown' | 'total' | 'net'

export interface GridRow {
  /** Stable across reloads: 'line:<id>', 'subtotal:<category>', 'other:expense', 'other:expense>food'… */
  key: string
  kind: GridRowKind
  group: LineGroup
  depth: number
  label: string
  /** The status row (rows and their breakdown entries). */
  row?: StatusRow
  /** Its index in `status.rows`, for what came from archives. */
  index?: number
  figures?: Figures
  /** Each month's figures, for the year grid (a status asked for `byMonth`). */
  months?: Figures[]
  /** Rows that open and close: subtotals, and Other rows with something to show. */
  expandable: boolean
  open: boolean
  /** Up and down move through these: rows and breakdown entries, not headings and totals. */
  selectable: boolean
  /** What a new line would be for, from this row: a category with no line of its own, or an entry under Other. */
  target?: LineTarget
  /** The row's figures are a budget (a line, a subtotal, a total): else Budget shows a dash. */
  budgeted: boolean
}

/** A status row's key, the same whatever month is shown. */
export function rowKey(row: StatusRow): string {
  if (row.lineId !== undefined) return `line:${row.lineId}`
  if (row.kind === 'subtotal') return `subtotal:${row.categoryId}`
  return `${row.kind}:${row.group}`
}

/** What finds the row again in the plugin, for its transactions. */
export function rowRef(row: StatusRow): RowRef {
  return {
    kind: row.kind, group: row.group,
    ...(row.lineId !== undefined && { lineId: row.lineId }),
    ...(row.categoryId !== undefined && { categoryId: row.categoryId }),
    ...(row.accountId !== undefined && { accountId: row.accountId })
  }
}

const nothing = (f: Figures) => f.budget === 0 && f.actual === 0
const BUDGETED = new Set(['line', 'subtotal', 'parentLine', 'transferLine', 'deletedCategory', 'deletedAccount'])

/** What a new line for an entry under Other would be for. */
function entryTarget(row: StatusRow, entry: BreakdownEntry): LineTarget {
  return row.kind === 'otherTransfers'
    ? { kind: 'transfer', accountId: entry.id, direction: row.group === 'income' ? 'in' : 'out' }
    : { kind: 'category', categoryId: entry.id }
}

export interface GridOptions {
  /** Subtotals closed, and Other rows open, by key. */
  collapsed: ReadonlySet<string>
  expanded: ReadonlySet<string>
  /** Show rows with neither budget nor actual in the period. */
  showEmpty: boolean
  /** Other rows open on what they gather (the month view); the year grid has no months for it. Default true. */
  breakdowns?: boolean
}

/** The grid's rows, in order. */
export function gridRows(status: BudgetStatus, options: GridOptions): GridRow[] {
  const out: GridRow[] = []
  const rows = status.rows
  // Which rows have nothing this period, counting a subtotal as empty only when everything under it is
  const empty = rows.map(r => nothing(r.figures))
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'subtotal' || !empty[i]) continue
    for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) if (!empty[j]) { empty[i] = false; break }
  }

  for (const group of ['income', 'expense'] as const) {
    out.push({ key: `heading:${group}`, kind: 'heading', group, depth: 0, label: group === 'income' ? 'Income' : 'Expenses', expandable: false, open: true, selectable: false, budgeted: false })
    let closedBelow: number | undefined
    rows.forEach((row, index) => {
      if (row.group !== group) return
      if (closedBelow !== undefined) {
        if (row.depth > closedBelow) return
        closedBelow = undefined
      }
      if (empty[index] && !options.showEmpty) return
      const key = rowKey(row)
      const hasBreakdown = options.breakdowns !== false && (row.breakdown?.length ?? 0) > 0
      const expandable = row.kind === 'subtotal' || hasBreakdown
      const open = row.kind === 'subtotal' ? !options.collapsed.has(key) : options.expanded.has(key)
      out.push({
        key, kind: 'row', group, depth: row.depth, label: row.label, row, index, figures: row.figures, ...(row.months && { months: row.months }), expandable, open,
        selectable: true, budgeted: BUDGETED.has(row.kind),
        ...(row.kind === 'subtotal' && row.categoryId !== undefined && { target: { kind: 'category', categoryId: row.categoryId } })
      })
      if (row.kind === 'subtotal' && !open) closedBelow = row.depth
      if (hasBreakdown && open) {
        for (const entry of row.breakdown!) {
          out.push({
            key: `${key}>${entry.id}`, kind: 'breakdown', group, depth: row.depth + 1, label: entry.label, row,
            figures: { budget: 0, actual: entry.actual, remaining: -entry.actual },
            expandable: false, open: false, selectable: true, target: entryTarget(row, entry), budgeted: false
          })
        }
      }
    })
    const side = group === 'income' ? 'income' : 'expenses'
    out.push({
      key: `total:${group}`, kind: 'total', group, depth: 0, label: group === 'income' ? 'Total income' : 'Total expenses', figures: status.totals[side],
      ...(status.monthlyTotals && { months: status.monthlyTotals.map(t => t[side]) }), expandable: false, open: false, selectable: false, budgeted: true
    })
  }
  out.push({
    key: 'net', kind: 'net', group: 'income', depth: 0, label: 'Net', figures: status.totals.net,
    ...(status.monthlyTotals && { months: status.monthlyTotals.map(t => t.net) }), expandable: false, open: false, selectable: false, budgeted: true
  })
  return out
}

/**
 * Whether Remaining is drawn in red: an expense row, or the expenses' total, over its budget; or the net behind the plan.
 * Never income, where a negative Remaining means more came in than planned.
 */
export function remainingIsBad(row: Pick<GridRow, 'kind' | 'group' | 'figures'>): boolean {
  if (!row.figures || row.figures.remaining >= 0) return false
  return row.kind === 'net' || row.group === 'expense'
}
