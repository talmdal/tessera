// A delimited file as rows of cells: the bytes decoded, and RFC 4180 quoting honoured. Nothing here knows what
// a column means — that is the profile's job — so this stays a pure function of (bytes, delimiter, quote) and
// is the one part of the CSV reader a fixture can exercise on its own.
import { CSV_DELIMITERS, type CsvProfile } from '@tessera/exchange-api'

const BOM = '﻿'

export type CsvEncoding = CsvProfile['encoding']

/**
 * Bytes as text. A UTF-16LE byte-order mark settles it outright (Excel's "Unicode text" export); otherwise
 * UTF-8 when the bytes are valid UTF-8, and Windows-1252 when they are not, which is what a bank's older
 * export is. The encoding is returned as well as the text so a saved profile can record it.
 */
export function decodeCsv(data: Uint8Array): { text: string, encoding: CsvEncoding } {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return { text: strip(new TextDecoder('utf-16le').decode(data)), encoding: 'utf-16le' }
  }
  try {
    return { text: strip(new TextDecoder('utf-8', { fatal: true }).decode(data)), encoding: 'utf-8' }
  } catch {
    return { text: strip(new TextDecoder('windows-1252').decode(data)), encoding: 'windows-1252' }
  }
}

const strip = (text: string) => text.startsWith(BOM) ? text.slice(1) : text

/**
 * The text as rows of cells. Quotes are RFC 4180: a quoted cell may hold the delimiter and newlines, and a
 * doubled quote inside one is a literal quote. A row is kept even when it is ragged — banks write a short
 * trailing line — and the reader decides what to do about it.
 */
export function parseDelimited(text: string, delimiter: string, quote = '"'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let at = 0

  const endCell = () => { row.push(cell); cell = '' }
  const endRow = () => { endCell(); rows.push(row); row = [] }

  while (at < text.length) {
    const char = text[at]
    if (quoted) {
      if (char === quote) {
        if (text[at + 1] === quote) { cell += quote; at += 2; continue }
        quoted = false; at += 1; continue
      }
      cell += char; at += 1; continue
    }
    if (char === quote && cell.trim() === '') { quoted = true; cell = ''; at += 1; continue }
    if (text.startsWith(delimiter, at)) { endCell(); at += delimiter.length; continue }
    if (char === '\r' || char === '\n') {
      endRow()
      at += char === '\r' && text[at + 1] === '\n' ? 2 : 1
      continue
    }
    cell += char; at += 1
  }
  // A file ending in a newline must not produce a trailing empty row; one ending mid-row must keep it.
  if (cell !== '' || row.length > 0) endRow()
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''))
}

/**
 * The delimiter the file uses, guessed by which candidate gives the most consistent cell count across the
 * first several rows. Consistency beats raw frequency: a file of prose memos holds more spaces and commas
 * than a semicolon-delimited file holds semicolons, but only the real delimiter squares the rows up.
 */
export function inferDelimiter(text: string, quote = '"'): string {
  const head = text.split(/\r\n|\n|\r/).slice(0, 20).join('\n')
  let best = ','
  let bestScore = -1
  for (const candidate of CSV_DELIMITERS) {
    const rows = parseDelimited(head, candidate, quote).filter(r => r.length > 0)
    if (rows.length === 0) continue
    const counts = rows.map(r => r.length)
    const columns = mode(counts)
    if (columns < 2) continue
    // How many rows agree on the column count, then how many columns — more columns means a finer split.
    const agreeing = counts.filter(n => n === columns).length / counts.length
    const score = agreeing * 100 + columns
    if (score > bestScore) { bestScore = score; best = candidate }
  }
  return best
}

/** The most common value, ties going to the larger — a header row is as trustworthy as a data row. */
function mode(values: number[]): number {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best = 0
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) { best = value; bestCount = count }
  }
  return best
}

/**
 * Where the real table starts: the first row whose cell count matches the file's prevailing one. A bank that
 * writes `Maple Trust Bank - Savings - 2026-10-01 to 2026-10-31` above its header produces a one-cell row
 * first, and that row is what `skip` counts.
 */
export function inferSkip(rows: string[][]): number {
  if (rows.length === 0) return 0
  const columns = mode(rows.map(r => r.length))
  const at = rows.findIndex(r => r.length === columns)
  return at <= 0 ? 0 : at
}

/** A cell by column, by header name (case- and space-insensitively) or by index. Undefined when unmapped. */
export function cellAt(row: string[], header: string[], column: string | number | undefined): string | undefined {
  if (column === undefined) return undefined
  const at = typeof column === 'number' ? column : header.findIndex(h => normaliseHeader(h) === normaliseHeader(column))
  if (at < 0 || at >= row.length) return undefined
  const value = row[at].trim()
  return value === '' ? undefined : value
}

/** A header name reduced to what two exports of the same shape have in common: lower case, no punctuation. */
export const normaliseHeader = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '')
