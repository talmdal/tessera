// The table of a result, as the view draws it: the rows a collapsed tree leaves showing, which rows can fold, which
// figures are bad (coloured as the theme says), and which figures have transactions behind them to list. Pure: the
// result is the engine's, and nothing is added up here.
import type { ResultColumn, ResultRow } from '@tessera/reports-api'

/** The table shows this many rows at first, and this many more after each painted frame (R0: 5,000 at once froze the window for 0.7 s). */
export const ROWS_PER_CHUNK = 500

export { parentsOf, visibleRows, type TableRow } from '../shared/rows'

/** A figure the report says is bad: negative, of money, in a row where that is bad (what is owed; less in than out). */
export const isBad = (row: ResultRow, column: Pick<ResultColumn, 'unit'>, value: number | null) =>
  value !== null && value < 0 && row.negativeIsBad === true && column.unit === 'money'

/** Whether Show Transactions can list what makes up a figure. */
export const canDrill = (row: ResultRow, column: ResultColumn, value: number | null) =>
  value !== null && row.drill !== undefined && column.drill !== undefined

/** The columns' headings in two lines, when some columns share a group above their labels (several figures a month). */
export function headingGroups(columns: readonly ResultColumn[]): { label: string, span: number }[] | undefined {
  if (!columns.some(c => c.group !== undefined)) return undefined
  const out: { label: string, span: number }[] = []
  for (const c of columns) {
    const label = c.group ?? ''
    const last = out[out.length - 1]
    if (last && last.label === label && label !== '') last.span++
    else out.push({ label, span: 1 })
  }
  return out
}

/** Each column's width, in em, so larger text widens it: room for the longest figure or heading it has. */
export function columnWidthEm(column: ResultColumn, texts: readonly string[]): number {
  const longest = Math.max(column.label.length, ...texts.map(t => t.length))
  return Math.min(14, Math.max(5, Math.ceil(longest * 0.62) + 1))
}
