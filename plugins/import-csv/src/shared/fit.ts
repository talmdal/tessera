// Whether a remembered layout still reads a file: every row a line or left out quietly (a balance forward or a
// totals row), at most 2% left out with a warning, and every column it needs present. When it doesn't, why not, in
// words, and whether only its date order is wrong (a bank that changed its dates from month first to day first).
// See docs/import-formats-design.md, "What the dialog starts from".
import { guessDateOrder, type DateOrder } from '@tessera/import-api'
import { isDateCell } from './cells'
import { isBlank } from './csv'
import { problemsOf, type CsvLayout } from './layout'
import { readLines } from './lines'

/** The share of rows that may be left out with a warning before a layout no longer fits. */
export const MISFIT_SHARE = 0.02

export interface Fit {
  fits: boolean
  /** Why not, when it doesn't. */
  reason?: string
  /** The date order that reads the file, when only the order was wrong. */
  dateOrder?: DateOrder
}

/** The width of a file's rows of data: the most common. */
export function dataWidth(rows: readonly (readonly string[])[], from: number): number {
  const counts = new Map<number, number>()
  for (const row of rows.slice(from)) if (!isBlank(row)) counts.set(row.length, (counts.get(row.length) ?? 0) + 1)
  let best = 0
  for (const [width, n] of counts) if (best === 0 || n > counts.get(best)! || (n === counts.get(best)! && width > best)) best = width
  return best
}

function plainFit(rows: readonly (readonly string[])[], layout: CsvLayout, pivot: number): Fit {
  const first = layout.skip + (layout.header ? 1 : 0)
  const width = dataWidth(rows, first)
  const problems = problemsOf(layout, width)
  if (problems.length > 0) return { fits: false, reason: problems[0] }
  const { statements, leftOut } = readLines(rows, layout, pivot)
  const lines = statements.reduce((n, s) => n + s.lines.length, 0)
  const warned = leftOut.filter(l => !l.quiet && !l.pending)
  if (lines === 0) return { fits: false, reason: 'None of its rows can be read with them.' }
  if (warned.length > MISFIT_SHARE * (lines + warned.length)) {
    const row = warned[0].row + 1
    return { fits: false, reason: `${warned.length} ${warned.length === 1 ? 'row' : 'rows'} can't be read with them (row ${row}: ${warned[0].reason.replace(/\.$/, '')}).` }
  }
  return { fits: true }
}

/** How well `layout` reads `rows`. */
export function fitOf(rows: readonly (readonly string[])[], layout: CsvLayout, pivot: number): Fit {
  const fit = plainFit(rows, layout, pivot)
  if (fit.fits || layout.columns.date === undefined) return fit
  // Perhaps only the date order changed
  const first = layout.skip + (layout.header ? 1 : 0)
  const column = layout.columns.date
  const dates = rows.slice(first).map(r => (r[column] ?? '').trim()).filter(v => v !== '' && isDateCell(v, pivot))
  const orders = guessDateOrder(dates, { pivot, monthNames: true })
  if (orders.length === 0 || orders.includes(layout.dateOrder)) return fit
  const corrected = { ...layout, dateOrder: orders[0] }
  return plainFit(rows, corrected, pivot).fits ? { fits: false, reason: fit.reason, dateOrder: orders[0] } : fit
}
