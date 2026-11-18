// Guessing what a delimited file's columns mean, and recognising a file shape seen before.
//
// The guess is never trusted on its own: it is what the mapping dialog opens *showing*, so that the common
// bank export needs a glance and a click rather than ten drop-downs. The fingerprint is what makes the second
// import of the same shape silent — it identifies the file's layout, not its contents, so next month's
// statement from the same bank matches last month's saved profile.
import {
  CSV_FIELDS, type CsvColumns, type CsvDateFormat, type CsvField, type CsvProfile
} from '@tessera/exchange-api'
import { inferDelimiter, inferSkip, normaliseHeader, parseDelimited, type CsvEncoding } from './delimited'
import { parseCsvAmount, parseCsvDate } from './values'

/**
 * Header words that name a field, most specific first. Ordered because `Transaction Date` must reach `date`
 * and `Date Posted` must not become `postedDate` before `date` has a column at all; and because `Description`
 * is a payee in most exports but a memo in some, so payee claims it and memo takes what is left.
 */
const HEADER_WORDS: [CsvField, RegExp][] = [
  ['externalId', /^(transactionid|transactionreference|fitid|referenceid|uniqueid|id)$/],
  ['date', /^(transactiondate|date|datum|postingdate|posteddate|valuedate|dateposted|bookingdate)$/],
  ['debit', /^(debit|withdrawal|withdrawals|moneyout|paidout|outflow|charges|amountdebit|debitamount)$/],
  ['credit', /^(credit|deposit|deposits|moneyin|paidin|inflow|amountcredit|creditamount)$/],
  ['amount', /^(amount|value|betrag|transactionamount|amountcad|amountusd|net)$/],
  ['balance', /^(balance|runningbalance|closingbalance|balanceafter|totalbalance)$/],
  ['number', /^(number|cheque|chequenumber|checknumber|reference|ref|refno|serial|chequeno)$/],
  ['payee', /^(payee|description|merchant|name|narrative|details|particulars|transactiondescription|descriptionpayee)$/],
  ['memo', /^(memo|note|notes|comment|comments|description2|extradetails|additionalinfo)$/],
  ['category', /^(category|categories|type|classification|tag)$/]
]

/** The columns a header row suggests. A name only claims a field that nothing has claimed already. */
export function columnsFromHeader(header: string[]): Partial<CsvColumns> {
  const columns: Partial<CsvColumns> = {}
  const normalised = header.map(normaliseHeader)
  for (const [field, pattern] of HEADER_WORDS) {
    if (columns[field] !== undefined) continue
    const at = normalised.findIndex((name, index) =>
      pattern.test(name) && !Object.values(columns).includes(header[index]))
    if (at >= 0) columns[field] = header[at]
  }
  return columns
}

/**
 * Which date order the file's own dates settle, from the data rather than the header: a first part above
 * twelve can only be a day, a second part above twelve can only be a day the other way round. Undefined when
 * nothing in the column settles it — then the guess stays at the dialog's default and the user confirms it
 * against the live preview, which is exactly the case the preview exists for.
 */
export function inferDateFormat(values: readonly string[]): CsvDateFormat | undefined {
  for (const raw of values) {
    const text = raw.trim().split(/[ T]/)[0]
    if (/^\d{4}[-/.]/.test(text)) return 'ISO'
    if (/^\d{1,2}[-/. ][A-Za-z]{3}/.test(text)) return 'DMY'
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text)
    if (parts === null) continue
    if (Number(parts[1]) > 12) return 'DMY'
    if (Number(parts[2]) > 12) return 'MDY'
  }
  return undefined
}

/**
 * Whether a single amount column writes debits as positive. Most exports sign them negative; a few write every
 * figure unsigned and lean on a separate column, and a file whose amounts are *all* positive while a balance
 * column falls is the one that needs this. Undefined when the file does not say, which leaves the default.
 */
export function inferDebitsArePositive(amounts: readonly string[], decimal: '.' | ','): boolean | undefined {
  const values = amounts
    .map(raw => parseCsvAmount(raw, decimal))
    .filter((r): r is { ok: true, minor: number } => r.ok)
    .map(r => r.minor)
  if (values.length < 3) return undefined
  return values.every(value => value >= 0) ? undefined : false
}

export interface CsvGuess {
  profile: CsvProfile
  /** The first rows as cells, for the dialog's grid: the header row first when there is one. */
  sample: string[][]
  /** The header as read, empty when the file has none. */
  header: string[]
  fingerprint: string
}

/** How many rows the mapping dialog shows, and the guess looks at. */
export const SAMPLE_ROWS = 10

/**
 * Everything that can be concluded from the bytes alone. The returned profile is a complete, usable one — the
 * dialog edits it rather than building one from nothing — and the fingerprint identifies this file shape.
 */
export function guessProfile(text: string, encoding: CsvEncoding, name = 'Imported CSV'): CsvGuess {
  const quote = '"'
  const delimiter = inferDelimiter(text, quote)
  const all = parseDelimited(text, delimiter, quote)
  const skip = inferSkip(all)
  const body = all.slice(skip)

  const first = body[0] ?? []
  const header = looksLikeHeader(first, body[1]) ? first : []
  const rows = header.length > 0 ? body.slice(1) : body

  const columns = header.length > 0
    ? columnsFromHeader(header)
    : columnsByPosition(rows)

  const dateValues = rows.map(row => valueAt(row, header, columns.date)).filter((v): v is string => v !== undefined)
  const dateFormat = inferDateFormat(dateValues) ?? 'ISO'
  const decimal = inferDecimal(rows, header, columns)

  const amountValues = columns.amount === undefined
    ? []
    : rows.map(row => valueAt(row, header, columns.amount)).filter((v): v is string => v !== undefined)
  const debitsArePositive = inferDebitsArePositive(amountValues, decimal)

  const profile: CsvProfile = {
    name,
    delimiter,
    quote,
    skip,
    header: header.length > 0,
    encoding,
    columns: { date: columns.date ?? (header[0] ?? 0), ...columns } as CsvColumns,
    dateFormat,
    decimal,
    ...(debitsArePositive !== undefined && { debitsArePositive }),
    ...(trailingTotalOf(rows) !== undefined && { skipRows: trailingTotalOf(rows)! })
  }

  return {
    profile,
    sample: body.slice(0, SAMPLE_ROWS + (header.length > 0 ? 1 : 0)),
    header,
    fingerprint: fingerprintOf(header, delimiter, first.length)
  }
}

/** A cell by header name or index, used before a full profile exists. */
function valueAt(row: string[], header: string[], column: string | number | undefined): string | undefined {
  if (column === undefined) return undefined
  const at = typeof column === 'number' ? column : header.indexOf(column)
  const value = at >= 0 && at < row.length ? row[at].trim() : ''
  return value === '' ? undefined : value
}

/**
 * Whether the first row names the columns rather than being data. A header's cells are words, none of which
 * parses as a date or an amount, while the row beneath it has at least one of each. Comparing the two is what
 * distinguishes a header from a first transaction whose payee happens to read like a title.
 */
export function looksLikeHeader(first: string[] | undefined, second: string[] | undefined): boolean {
  if (first === undefined || first.length < 2) return false
  const datelike = (cells: string[]) => cells.some(c => parseCsvDate(c, 'ISO') !== undefined || parseCsvDate(c, 'DMY') !== undefined)
  const numberlike = (cells: string[]) => cells.filter(c => parseCsvAmount(c).ok).length
  if (datelike(first)) return false
  if (numberlike(first) > 0) return false
  if (first.some(c => c.trim() === '')) return first.some(c => /[A-Za-z]{3}/.test(c))
  // Nothing in the first row is a date or a number, and it is all words: a header, whatever follows.
  if (second === undefined) return first.every(c => /[A-Za-z]/.test(c))
  return true
}

/**
 * A headerless file's columns, by what each column's cells parse as: the first all-dates column is the date,
 * the last all-numbers column is the balance when there is more than one, and the first is the amount. A rough
 * guess by design — a headerless file is the case the dialog is least able to prefill, and most needs a human.
 */
export function columnsByPosition(rows: string[][]): Partial<CsvColumns> {
  const width = Math.max(0, ...rows.map(r => r.length))
  const sample = rows.slice(0, SAMPLE_ROWS)
  const columns: Partial<CsvColumns> = {}
  const numeric: number[] = []

  for (let at = 0; at < width; at += 1) {
    const cells = sample.map(row => (row[at] ?? '').trim()).filter(c => c !== '')
    if (cells.length === 0) continue
    if (columns.date === undefined && cells.every(c => parseCsvDate(c, 'ISO') !== undefined || parseCsvDate(c, 'DMY') !== undefined)) {
      columns.date = at
      continue
    }
    if (cells.every(c => parseCsvAmount(c).ok)) { numeric.push(at); continue }
    if (columns.payee === undefined) columns.payee = at
    else if (columns.memo === undefined) columns.memo = at
  }
  if (numeric.length > 0) columns.amount = numeric[0]
  if (numeric.length > 1) columns.balance = numeric[numeric.length - 1]
  return columns
}

/**
 * Which separator is the decimal point, from the money columns: a comma followed by exactly two digits at the
 * end of a figure is a European decimal comma. Defaults to the point, which is what an English-locale export
 * writes.
 */
function inferDecimal(rows: string[][], header: string[], columns: Partial<CsvColumns>): '.' | ',' {
  const money = [columns.amount, columns.debit, columns.credit, columns.balance]
  const values = rows.flatMap(row => money.map(c => valueAt(row, header, c))).filter((v): v is string => v !== undefined)
  const commaDecimal = values.filter(v => /,\d{2}$/.test(v) && !/\.\d/.test(v)).length
  const pointDecimal = values.filter(v => /\.\d{1,2}$/.test(v)).length
  return commaDecimal > pointDecimal ? ',' : '.'
}

/**
 * The first cell of a trailing summary line — `Closing balance`, `Total` — when the file ends in one. Returned
 * as the `skipRows` text so that the row is dropped rather than read as a transaction with no date.
 */
export function trailingTotalOf(rows: string[][]): string | undefined {
  const last = rows[rows.length - 1]
  if (last === undefined || last.length === 0) return undefined
  const first = last[0].trim()
  if (first === '') return undefined
  if (parseCsvDate(first, 'ISO') !== undefined || parseCsvDate(first, 'DMY') !== undefined) return undefined
  return /^(closing|opening|total|balance|summary|ending|grand)/i.test(first) ? first : undefined
}

/**
 * What identifies this file shape. The normalised header names when there is a header — next month's file from
 * the same bank has the same ones — and the delimiter and column count when there is not.
 */
export function fingerprintOf(header: string[], delimiter: string, columns: number): string {
  const body = header.length > 0
    ? header.map(normaliseHeader).join('\u0001')
    : `\u0002${delimiter}\u0001${columns}`
  return hash(body)
}

/** FNV-1a, as eight hex digits. Not a cryptographic hash: this identifies a layout, it does not protect one. */
function hash(text: string): string {
  let value = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(16).padStart(8, '0')
}

/** Every field a column could be mapped to, for the dialog's drop-downs. */
export const MAPPABLE_FIELDS: readonly CsvField[] = CSV_FIELDS
