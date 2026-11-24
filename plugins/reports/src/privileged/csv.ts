// Export Report…: a result's table as CSV, as the view shows it (docs/reporting-design.md, "Printing and exporting"). A
// header row, then one row per table row the view shows (a folded row's rows aren't shown, so aren't written), each
// labelled by its path ("Food : Groceries"), so the rows still say where they belong without the indentation. Amounts
// are exact decimals with their currency's digits, shares decimals of a per cent ("45.20"), counts whole numbers, and
// a figure the table shows as "—" an empty cell. UTF-8 with a byte-order mark, so spreadsheets read the accents; text
// a spreadsheet would run as a formula is written with an apostrophe in front, as the export plugin writes its CSVs.
// Pure: the figures are the engine's, and nothing is added up here.
import { CATEGORY_SEPARATOR, minorDigits } from '@tessera/accounts-api'
import { encodeText, minorToDecimal } from '@tessera/export-api'
import type { ReportResult, ResultColumn, ResultRow } from '@tessera/reports-api'
import { visibleRows } from '../shared/rows'

/** Text a spreadsheet would run as a formula: starting with =, +, -, @, a tab or a carriage return. */
const FORMULA = /^[=+\-@\t\r]/

export interface CsvOptions {
  /** The rows folded on screen: what is beneath them isn't written. */
  collapsed?: Iterable<string>
  /** The heading of the first column: what the rows are ("Category", "Payee"). Default none. */
  rowsLabel?: string
}

export interface ReportCsv {
  text: string
  /** Text cells written with an apostrophe in front, so a spreadsheet doesn't run them. */
  guarded: number
  /** Table rows written, the header not counted. */
  rows: number
}

/** A column's heading in one line: its group over its label ("Jan 2027 Budget"), as Show Transactions names it. */
export const columnHeading = (column: Pick<ResultColumn, 'group' | 'label'>) => [column.group, column.label].filter(s => s !== undefined && s !== '').join(' ')

/** One figure as exact text; '' for none. */
export function figureText(value: number | null | undefined, column: Pick<ResultColumn, 'unit'>, currency: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (column.unit === 'count') return String(value)
  // Basis points: 4,520 is 45.20 (per cent)
  if (column.unit === 'percent') return minorToDecimal(value, 2)
  return minorToDecimal(value, currency ? minorDigits(currency) : 2)
}

/** The CSV of a result's table, as shown. */
export function reportCsv(result: Pick<ReportResult, 'columns' | 'rows' | 'currency'>, options: CsvOptions = {}): ReportCsv {
  const eachCurrency = result.currency === null
  const byId = new Map(result.rows.map(r => [r.id, r]))
  let guarded = 0
  const text = (value: string) => {
    if (FORMULA.test(value)) { guarded++; return `'${value}` }
    return value
  }
  const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  /** A row's label with its parents': "Food : Groceries". */
  const path = (row: ResultRow): string => {
    const labels = [row.label]
    const seen = new Set([row.id])
    for (let p = row.parentId; p !== undefined && !seen.has(p); p = byId.get(p)?.parentId) {
      seen.add(p)
      const parent = byId.get(p)
      if (parent) labels.unshift(parent.label)
    }
    return labels.join(CATEGORY_SEPARATOR)
  }

  const header = [options.rowsLabel ?? '', ...(eachCurrency ? ['Currency'] : []), ...result.columns.map(columnHeading)]
  const lines = [header.map(h => cell(text(h))).join(',')]
  const shown = visibleRows(result.rows, new Set(options.collapsed ?? []))
  for (const { row } of shown) {
    const currency = row.currency ?? result.currency
    lines.push([
      cell(text(path(row))),
      ...(eachCurrency ? [row.currency ?? ''] : []),
      ...result.columns.map((c, i) => row.kind === 'heading' ? '' : figureText(row.values[i], c, currency))
    ].join(','))
  }
  return { text: lines.join('\r\n') + '\r\n', guarded, rows: shown.length }
}

/** The file's bytes: UTF-8 with a byte-order mark, which is how Excel knows a CSV is UTF-8. */
export const csvBytes = (csv: Pick<ReportCsv, 'text'>): Uint8Array => encodeText(csv.text, 'utf-8', { bom: true }).bytes
