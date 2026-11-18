// QIF's money and dates, read the careful way. QIF carries no currency and no stable ids, writes amounts with
// whatever separators the exporting program's locale used, and writes dates in half a dozen shapes — several
// of them ambiguous on their own. Everything here is a pure function so the reader's choices are testable.
import type { AccountType } from '@tessera/accounts-api'

export type AmountResult = { ok: true, minor: number } | { ok: false }

/**
 * A QIF amount as minor units. `T-1,234.56` is the common form; European exports write `1.234,56`, and a few
 * write no fraction at all. Read as text, never through `parseFloat`.
 */
export function parseQifAmount(raw: string | undefined, digits = 2): AmountResult {
  if (raw === undefined) return { ok: false }
  let text = raw.trim().replace(/\s/g, '')
  if (text === '') return { ok: false }
  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) { negative = true; text = text.slice(1, -1) }
  if (text.startsWith('-')) { negative = true; text = text.slice(1) }
  else if (text.startsWith('+')) text = text.slice(1)
  if (text.endsWith('-')) { negative = true; text = text.slice(0, -1) }
  if (!/^[\d.,]*$/.test(text) || !/\d/.test(text)) return { ok: false }

  // The last separator is the decimal point when what follows it is not exactly three digits of a group
  const separators = [...text].filter(c => c === '.' || c === ',')
  const lastSeparator = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
  const after = lastSeparator === -1 ? '' : text.slice(lastSeparator + 1)
  // Three digits after the last separator is a group (`1,234`; `1.234` from a European export): no exporter
  // writes three decimal places. Anything else after a separator is the fraction.
  void separators
  const isDecimal = lastSeparator !== -1 && after.length > 0 && after.length !== 3

  const whole = (isDecimal ? text.slice(0, lastSeparator) : text).replace(/[.,]/g, '')
  const fraction = isDecimal ? after : ''
  const scaled = fraction.length <= digits ? fraction.padEnd(digits, '0') : fraction.slice(0, digits)
  const value = Number(`${whole === '' ? '0' : whole}${scaled}`)
  if (!Number.isSafeInteger(value)) return { ok: false }
  return { ok: true, minor: negative && value !== 0 ? -value : value }
}

export type DateOrder = 'dmy' | 'mdy'

/**
 * The shapes a QIF date comes in. The slash forms are ambiguous between D/M and M/D until the whole file has
 * been looked at, which is `inferDateOrder`'s job; the apostrophe (`1/5'26`) marks a year 2000 or later, and
 * Quicken pads the day with a space (`1/ 5'26`).
 */
const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
const SLASH = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*(['/.-])\s*(\d{1,4})$/
const MONTH_NAME = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2,4})$/
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Whether a date text is one of the slash forms, whose order the file as a whole decides. */
export const isSlashDate = (raw: string) => SLASH.test(raw.trim()) && !ISO.test(raw.trim())

/**
 * The two-digit year rule Quicken uses: an apostrophe means 2000 or later; otherwise 00–49 is this century
 * and 50–99 the last.
 */
export function expandYear(text: string, apostrophe: boolean): number {
  if (text.length === 4) return Number(text)
  const two = Number(text.padStart(2, '0'))
  if (apostrophe) return 2000 + two
  return two < 50 ? 2000 + two : 1900 + two
}

export function parseQifDate(raw: string | undefined, order: DateOrder): string | undefined {
  if (raw === undefined) return undefined
  const text = raw.trim()
  let y: number, m: number, d: number
  let match: RegExpExecArray | null
  if ((match = ISO.exec(text)) !== null) {
    ;[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  } else if ((match = SLASH.exec(text)) !== null) {
    const [, a, b, separator, year] = match
    y = expandYear(year, separator === "'")
    ;[m, d] = order === 'dmy' ? [Number(b), Number(a)] : [Number(a), Number(b)]
  } else if ((match = MONTH_NAME.exec(text)) !== null) {
    const month = MONTHS.indexOf(match[2].toUpperCase()) + 1
    if (month === 0) return undefined
    ;[y, m, d] = [expandYear(match[3], false), month, Number(match[1])]
  } else {
    return undefined
  }
  const at = new Date(Date.UTC(y, m - 1, d))
  if (isNaN(at.getTime()) || at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return undefined
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Which order the file's slash dates use, from the file itself: a first part above twelve can only be a day,
 * a second part above twelve can only be a day the other way round. Undefined when nothing in the file
 * settles it — then the reader has to ask.
 */
export function inferDateOrder(dates: readonly string[]): DateOrder | undefined {
  for (const raw of dates) {
    const match = SLASH.exec(raw.trim())
    if (match === null || ISO.test(raw.trim())) continue
    if (Number(match[1]) > 12) return 'dmy'
    if (Number(match[2]) > 12) return 'mdy'
  }
  return undefined
}

/** The `!Type:` word of a QIF block, as Tessera's account type. Investments have no type here yet. */
const ACCOUNT_TYPES: Record<string, AccountType> = {
  BANK: 'chequing',
  CASH: 'cash',
  CCARD: 'creditCard',
  'OTH A': 'otherAsset',
  'OTH L': 'otherLiability',
  INVST: 'investment',
  PORT: 'investment',
  '401(K)/403(B)': 'retirement'
}

export const accountTypeOf = (raw: string | undefined): AccountType | undefined =>
  raw === undefined ? undefined : ACCOUNT_TYPES[raw.trim().toUpperCase()]

/** The QIF type word for a Tessera account type, when writing. */
export function qifTypeOf(type: AccountType | undefined): string {
  switch (type) {
    case 'creditCard': return 'CCard'
    case 'cash': return 'Cash'
    case 'otherAsset': case 'investment': case 'retirement': return 'Oth A'
    case 'otherLiability': case 'loan': case 'mortgage': case 'lineOfCredit': return 'Oth L'
    default: return 'Bank'
  }
}

/** `C*` and `Cc` mean cleared; `CX` and `CR` mean reconciled. Anything else is nothing. */
export function clearedOf(raw: string | undefined): 'cleared' | 'reconciled' | undefined {
  const flag = raw?.trim()
  if (flag === '*' || flag === 'c') return 'cleared'
  if (flag === 'X' || flag === 'R') return 'reconciled'
  return undefined
}
