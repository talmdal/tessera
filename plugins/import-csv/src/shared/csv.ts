// Rows from a CSV file's text, as banks write them: RFC 4180 and what real exports do beyond it. Quoted cells with
// doubled quotes and line breaks inside, '\r\n', '\n' or '\r' line ends, a trailing empty line, rows of different
// widths, spaces around quoted cells, and Excel's marks for keeping leading zeros (="00123", '00123). The delimiter is
// detected. Each cell keeps where it is in the text, so the anonymiser can rewrite a cell and leave every other byte.
// Pure: used by the privileged half, the dialog's live preview and the anonymiser alike.
// See docs/import-formats-design.md, "Reading rows".

export type Delimiter = ',' | ';' | '\t' | '|'

/** The delimiters tried, in the order that breaks a tie (a semicolon file with comma decimals splits on commas too). */
export const DELIMITERS: readonly Delimiter[] = ['\t', ';', ',', '|']

export interface CsvCell {
  /** The value: unquoted, Excel's marks taken off, and trimmed. */
  text: string
  /** Where the cell is written in the text, quotes included: [start, end). */
  start: number
  end: number
  /** The cell was written in quotes. */
  quoted: boolean
}

export interface CsvRow {
  cells: CsvCell[]
  /** The text line the row starts on, from 1. */
  line: number
}

/** A row's values. */
export const valuesOf = (row: CsvRow): string[] => row.cells.map(cell => cell.text)

/** True for a row with nothing in it: an empty line, or only delimiters. */
export const isBlank = (values: readonly string[]): boolean => values.every(value => value === '')

/**
 * A cell's value without Excel's marks: `="00123"` (a formula, to keep the zeros) and a leading apostrophe before a
 * number ('00123, '-12.50), or apostrophes around one ('5191XXXXXXXX4567'), are what Excel and banks write to stop a cell being read as a number.
 */
export function unmarked(value: string): string {
  const formula = /^="(.*)"$/s.exec(value)
  if (formula) return formula[1]
  const wrapped = /^'([^']*\d[^']*)'$/.exec(value)                        // '5191XXXXXXXX4567', as some banks write
  if (wrapped) return wrapped[1]
  if (/^'[-+=\d(.$]/.test(value)) return value.slice(1)
  return value
}

/** Every row of `text`, split on `delimiter`. */
export function parseCsv(text: string, delimiter: Delimiter): CsvRow[] {
  const rows: CsvRow[] = []
  let cells: CsvCell[] = []
  let line = 1
  let rowLine = 1
  let i = 0
  const n = text.length

  const endRow = () => {
    rows.push({ cells, line: rowLine })
    cells = []
  }

  while (i <= n) {
    // A cell starts here. Spaces before an opening quote are stray
    const start = i
    let j = i
    while (j < n && (text[j] === ' ' || text[j] === '\t') && text[j] !== delimiter) j++
    let value: string
    let quoted = false
    if (j < n && (text[j] === '"' || (text[j] === '=' && text[j + 1] === '"'))) {
      // Quoted: up to the closing quote, doubled quotes being one quote; line breaks inside are the cell's
      quoted = true
      const formula = text[j] === '='
      j += formula ? 2 : 1
      let inner = ''
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { inner += '"'; j += 2; continue }
          j++
          break
        }
        if (text[j] === '\r' || text[j] === '\n') {
          if (text[j] === '\r' && text[j + 1] === '\n') { inner += '\r'; j++ }
          line++
        }
        inner += text[j]
        j++
      }
      // Anything between the closing quote and the delimiter is kept, but spaces alone are stray
      let after = ''
      while (j < n && text[j] !== delimiter && text[j] !== '\r' && text[j] !== '\n') after += text[j++]
      value = after.trim() === '' ? inner : inner + after
      if (formula) value = value.trim()
      i = j
    } else {
      while (j < n && text[j] !== delimiter && text[j] !== '\r' && text[j] !== '\n') j++
      value = unmarked(text.slice(start, j).trim())
      i = j
    }
    cells.push({ text: quoted ? unmarked(value.trim()) : value, start, end: i, quoted })

    if (i >= n) {
      // The end of the text: a last line without a line end is a row; after a final line end there is none
      if (!(cells.length === 1 && cells[0].text === '' && start === n && !quoted)) endRow()
      break
    }
    if (text[i] === delimiter) { i++; continue }
    // A line end
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2
    else i++
    endRow()
    line++
    rowLine = line
  }
  return rows
}

/** The number of cells on each physical line, counting only delimiters outside quotes. */
function widths(lines: readonly string[], delimiter: Delimiter): number[] {
  return lines.map(text => {
    let count = 1
    let inQuotes = false
    for (const ch of text) {
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === delimiter && !inQuotes) count++
    }
    return count
  })
}

/**
 * The delimiter of a CSV file: from its first 50 non-empty lines, the one that splits the most lines into the same
 * number of cells (2 or more). A tie goes to tab, then ';', then ',', then '|'. ',' when nothing splits.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text.split(/\r\n|\r|\n/).filter(line => line.trim() !== '').slice(0, 50)
  let best: { delimiter: Delimiter, lines: number } = { delimiter: ',', lines: 0 }
  for (const delimiter of DELIMITERS) {
    const counts = new Map<number, number>()
    for (const width of widths(lines, delimiter)) if (width >= 2) counts.set(width, (counts.get(width) ?? 0) + 1)
    const most = Math.max(0, ...counts.values())
    if (most > best.lines) best = { delimiter, lines: most }
  }
  return best.delimiter
}

/** A file's rows, and the delimiter they were split on (detected unless given). */
export function readCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): { delimiter: Delimiter, rows: CsvRow[] } {
  return { delimiter, rows: parseCsv(text, delimiter) }
}
