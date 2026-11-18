// The CSV profile: what a delimited file's columns mean, and how its dates and amounts are written. CSV is not
// one format but a family, so the reader has to be told — once per file shape — and then the book remembers.
// Here rather than in the `exchange-csv` plugin because three parties must agree on it: the reader that
// consumes it, the mapping dialog that produces it, and the `exchange` plugin that saves and matches it.
// See docs/import-export-design.md#csv.

/** The fields a column can be mapped to. `ignore` is the absence of a mapping, which the dialog needs a word for. */
export const CSV_FIELDS = [
  'date', 'amount', 'debit', 'credit', 'payee', 'memo', 'number', 'category', 'balance', 'externalId'
] as const

export type CsvField = typeof CSV_FIELDS[number]

/** A column, named when the file has a header and numbered when it does not. */
export type CsvColumn = string | number

/** How a file's date column is written. A named order, or a pattern like `dd-MMM-yyyy`. */
export type CsvDateFormat = 'DMY' | 'MDY' | 'YMD' | 'ISO' | (string & {})

export interface CsvColumns {
  date: CsvColumn
  /** Either one signed amount column… */
  amount?: CsvColumn
  /** …or two unsigned ones, as most bank exports have. */
  debit?: CsvColumn
  credit?: CsvColumn
  payee?: CsvColumn
  memo?: CsvColumn
  number?: CsvColumn
  category?: CsvColumn
  balance?: CsvColumn
  /** Where the bank supplies one, this promotes the whole file to exact duplicate matching. */
  externalId?: CsvColumn
}

export interface CsvProfile {
  /** `<institution> chequing`, shown in the profile list. */
  name: string
  /** ',' ';' '\t' '|'. Inferred from the header line; overridable. */
  delimiter: string
  /** '"' by default; doubled inside a quoted field, RFC 4180. */
  quote: string
  /** Rows to skip before the header; banks like a title line. */
  skip: number
  /** The first non-skipped row names the columns. */
  header: boolean
  encoding: 'utf-8' | 'windows-1252' | 'utf-16le'
  columns: CsvColumns
  dateFormat: CsvDateFormat
  /** The decimal separator. '.' strips ',' and spaces; ',' strips '.' and spaces. */
  decimal: '.' | ','
  /** With a single amount column: is a debit negative (the default) or positive? */
  debitsArePositive?: boolean
  /** Rows whose first cell matches this, case-insensitively, are skipped: a trailing 'Total' line. */
  skipRows?: string
}

/** The delimiters worth guessing between, in the order a tie is broken. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const

/**
 * The question a CSV read raises when nothing saved describes the file's shape. The fingerprint is appended so
 * that `exchange` can look the answer up in `exchange.profiles` without having to parse the file itself:
 * `exchange-csv.profile:<fingerprint>`. The answer is a `CsvProfile`.
 */
export const CSV_PROFILE_QUESTION = 'exchange-csv.profile'

export const csvProfileQuestionId = (fingerprint: string) => `${CSV_PROFILE_QUESTION}:${fingerprint}`

/** The fingerprint out of such a question id, or undefined when it is not one. */
export function csvFingerprintOf(questionId: string): string | undefined {
  const prefix = `${CSV_PROFILE_QUESTION}:`
  return questionId.startsWith(prefix) ? questionId.slice(prefix.length) : undefined
}

/**
 * The fixed column set the writer produces, in order. Fixed rather than profile-driven because an export is
 * read by a spreadsheet or another finance program, neither of which has an opinion the user needs to express.
 */
export const CSV_WRITE_COLUMNS = [
  'Date', 'Number', 'Payee', 'Category', 'Memo', 'Amount', 'Balance', 'Status', 'Account'
] as const

/** Why a value is not a usable profile, or undefined. Exported so the dialog and the reader agree on the rules. */
export function validateCsvProfile(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'That is not a column mapping.'
  const p = raw as Partial<CsvProfile>
  if (typeof p.delimiter !== 'string' || p.delimiter.length === 0) return 'A column separator is needed.'
  if (typeof p.columns !== 'object' || p.columns === null) return 'The columns are missing.'
  const columns = p.columns as CsvColumns
  if (columns.date === undefined) return 'Say which column holds the date.'
  const hasAmount = columns.amount !== undefined
  const hasPair = columns.debit !== undefined || columns.credit !== undefined
  if (!hasAmount && !hasPair) return 'Say which column holds the amount, or which hold the debit and credit.'
  if (hasAmount && hasPair) return 'Map either one amount column or a debit and credit pair, not both.'
  return undefined
}

// ---- Reading a file's dates and amounts ------------------------------------------------
//
// Here, in the shared contract, rather than in the `exchange-csv` plugin, because the mapping dialog's
// live preview and the reader must agree *by construction*. A preview that could disagree with the import
// it is predicting would be worse than no preview at all, and the preview is the whole point of the dialog.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/
const THREE = /^(\d{1,4})[-/. ](\d{1,4})[-/. ](\d{1,4})$/
const NAMED = /^(\d{1,2})[-/. ]([A-Za-z]{3,})[-/. ](\d{2,4})$/
const NAMED_FIRST = /^([A-Za-z]{3,})[-/. ](\d{1,2}),?[-/. ](\d{2,4})$/

/** 00–49 is this century, 50–99 the last: the rule every finance program uses for a two-digit year. */
export const expandYear = (value: number) => value >= 100 ? value : value < 50 ? 2000 + value : 1900 + value

/**
 * A date cell as `YYYY-MM-DD`, read the way the profile says. `ISO` and `YMD` both accept a year-first date;
 * `DMY` and `MDY` decide the two ambiguous positions. A month name is unambiguous and is accepted under any
 * setting, because a file that mixes `3-May-2026` into a DMY column is still saying May.
 *
 * Time after the date is ignored: some exports write `2026-10-15 00:00:00`.
 */
export function parseCsvDate(raw: string | undefined, format: CsvDateFormat): string | undefined {
  if (raw === undefined) return undefined
  const text = raw.trim().replace(/^["']|["']$/g, '')
  if (text === '') return undefined

  let named = NAMED.exec(text)
  if (named !== null) return build(expandYear(Number(named[3])), monthOf(named[2]), Number(named[1]))
  named = NAMED_FIRST.exec(text)
  if (named !== null) return build(expandYear(Number(named[3])), monthOf(named[1]), Number(named[2]))

  const iso = ISO_LIKE.exec(text)
  if (iso !== null) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const three = THREE.exec(text.split(/[ T]/)[0])
  if (three === null) return undefined
  const [a, b, c] = [Number(three[1]), Number(three[2]), Number(three[3])]
  switch (normaliseFormat(format)) {
    case 'YMD': return build(expandYear(a), b, c)
    case 'DMY': return build(expandYear(c), b, a)
    default: return build(expandYear(c), a, b)
  }
}

const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toUpperCase()) + 1

/** The named orders; anything else — a pattern like `dd-MMM-yyyy` — falls back to its letter order. */
function normaliseFormat(format: CsvDateFormat): 'DMY' | 'MDY' | 'YMD' {
  const upper = format.toUpperCase()
  if (upper === 'ISO' || upper === 'YMD') return 'YMD'
  if (upper === 'DMY' || upper === 'MDY') return upper
  // A pattern: whichever of d, m, y its letters put first.
  const order = [...upper].filter(c => c === 'D' || c === 'M' || c === 'Y')
  const first = order[0]
  const second = order.find(c => c !== first)
  if (first === 'Y') return 'YMD'
  if (first === 'D') return 'DMY'
  if (first === 'M') return second === 'D' ? 'MDY' : 'MDY'
  return 'YMD'
}

/** A real calendar date only: `31/02/2026` is a misread column, not a date, and must not become 3 March. */
function build(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const at = new Date(Date.UTC(y, m - 1, d))
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return undefined
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export type AmountResult = { ok: true, minor: number } | { ok: false }

/**
 * An amount cell as minor units, read as text rather than through `parseFloat` so that a grouped European
 * figure does not quietly lose three orders of magnitude. The profile's `decimal` says which separator is the
 * point; the other one, and any spaces, currency symbol or thousands marker, is stripped.
 *
 * Accepts the shapes bank exports actually use: `-12.34`, `(12.34)`, `12.34-`, `$1,234.56`, `CR 12.34`.
 */
export function parseCsvAmount(raw: string | undefined, decimal: '.' | ',' = '.', digits = 2): AmountResult {
  if (raw === undefined) return { ok: false }
  let text = raw.trim()
  if (text === '') return { ok: false }

  let negative = false
  // Minus signs that are not the ASCII hyphen: some locales export U+2212, and an en dash turns up from
  // spreadsheets. Stripped as "unknown characters", they used to turn a debit into a credit.
  text = text.replace(/[\u2212\u2012\u2013\uFE63\uFF0D]/g, '-')

  // `CR`/`DR`, as a few statements write them: CR raises the balance, DR lowers it. At either end, touching the
  // figure or not — `12.34DR` is as much a debit as `12.34 DR`, and once read it as a credit.
  const marker = /^(CR|DR)\s+|\s*(CR|DR)$/i.exec(text)
  if (marker !== null) {
    if ((marker[1] ?? marker[2]).toUpperCase() === 'DR') negative = true
    text = (text.slice(0, marker.index) + text.slice(marker.index + marker[0].length)).trim()
  }
  if (text.startsWith('(') && text.endsWith(')')) { negative = !negative; text = text.slice(1, -1).trim() }

  // What may decorate a figure: spacing (including the no-break and thin spaces used for grouping), currency
  // symbols, and an upper-case currency code at either end. Anything else left over means this is not an
  // amount — `5e3` is not 5,300 and `abc12` is not 12 — and it is refused rather than read as one.
  text = text
    .replace(/^[A-Z]{3}(?=[\s\d\p{Sc}(.,+-])|(?<=[\d\s)])[A-Z]{3}$/u, '')
    .replace(/[\s\u00A0\u202F\p{Sc}]/gu, '')
  if (/[^\d.,+-]/.test(text)) return { ok: false }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1) }
  else if (text.startsWith('+')) text = text.slice(1)
  if (text.endsWith('-')) { negative = !negative; text = text.slice(0, -1) }
  if (!/^[\d.,]*$/.test(text) || !/\d/.test(text)) return { ok: false }

  // The profile says which separator is the point, so there is nothing left to guess: the other one is
  // grouping and comes straight out. `12.345` against a '.' profile is twelve point three four five, not twelve
  // thousand — and `1.234,56` against a ',' profile is one thousand two hundred and thirty-four.
  const grouping = decimal === '.' ? ',' : '.'
  const bare = text.split(grouping).join('')
  const parts = bare.split(decimal)
  if (parts.length > 2) return { ok: false }
  const [whole, fraction = ''] = parts
  if (whole !== '' && !/^\d+$/.test(whole)) return { ok: false }
  if (fraction !== '' && !/^\d+$/.test(fraction)) return { ok: false }

  // More decimals than the currency has: rounded half away from zero, as the OFX reader does, rather than cut —
  // cutting `12.349` to `12.34` loses money on every such row, always in the same direction.
  const scaled = fraction.length <= digits ? fraction.padEnd(digits, '0') : fraction.slice(0, digits)
  const roundUp = fraction.length > digits && Number(fraction[digits]) >= 5
  const value = Number(`${whole === '' ? '0' : whole}${scaled}`) + (roundUp ? 1 : 0)
  if (!Number.isSafeInteger(value)) return { ok: false }
  return { ok: true, minor: negative && value !== 0 ? -value : value }
}
