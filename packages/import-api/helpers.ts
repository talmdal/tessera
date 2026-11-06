// Pure helpers for format plugins: amounts as canonical decimal strings, and dates as YYYY-MM-DD. Nothing here goes
// through floating point, and nothing guesses: text that could mean two things is refused, so a format can warn
// about the line instead of importing a wrong amount or date.
import { isIsoDate } from '@tessera/accounts-api'

/** The decimal separator a file uses. The grouping separator is then the other one (or a space or apostrophe). */
export type DecimalSeparator = '.' | ','

const CANONICAL = /^-?(0|[1-9]\d*)(\.\d+)?$/

/**
 * True for a canonical decimal: an optional minus, digits without leading zeros, and an optional '.' with at least
 * one digit after it. Negative zero isn't canonical ('0.00' is).
 */
export function isCanonicalDecimal(text: unknown): text is string {
  return typeof text === 'string' && CANONICAL.test(text) && !/^-0(\.0+)?$/.test(text)
}

/** Grouping that is either absent or regular: 1,234,567 (thousands) or 12,34,567 (lakhs). */
function validGrouping(whole: string, group: string): boolean {
  if (!whole.includes(group)) return /^\d*$/.test(whole)
  const g = group === '.' ? '\\.' : group
  return new RegExp(`^\\d{1,3}(${g}\\d{3})+$`).test(whole) || new RegExp(`^\\d{1,2}(${g}\\d{2})*${g}\\d{3}$`).test(whole)
}

/**
 * A bank's way of writing an amount, as a canonical decimal string for `StatementLine.amount`, or undefined when it
 * isn't one. Handles grouping ('1,234.56', or '1.234,56' with `decimal: ','`), spaces and apostrophes as grouping
 * ("1 234,56", "1'234.56"), a leading or trailing minus ('-12.00', '12.00-'), parentheses for negatives ('(12.00)'),
 * a leading '+', and a currency sign or code before or after ('$12.00', '12.00 CAD'). Trailing zeros are kept
 * ('12.50' stays '12.50'); the import manager drops those beyond the currency's digits.
 *
 * Grouping must be regular, so a wrong `decimal` is caught rather than misread: '12,50' with `decimal: '.'` is
 * undefined, not 1250.
 */
export function canonicalDecimal(text: string, options: { decimal?: DecimalSeparator } = {}): string | undefined {
  const decimal = options.decimal ?? '.'
  const group = decimal === '.' ? ',' : '.'

  let s = String(text ?? '').trim()
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1).trim() }
  // An ISO currency code or a currency sign, before or after the number (keeping a sign written before it)
  s = s.replace(/^([-−+]?)\s*(?:[A-Z]{3}|[$€£¥₹])\s*/, '$1').replace(/\s*(?:[A-Z]{3}|[$€£¥₹])$/, '')
  if (/^[-−]/.test(s)) { negative = !negative; s = s.slice(1) }
  else if (s.startsWith('+')) s = s.slice(1)
  else if (/[-−]$/.test(s)) { negative = !negative; s = s.slice(0, -1) }
  // A space (including no-break and narrow no-break spaces) or an apostrophe between digits groups them, and is held
  // to the same rule as the grouping separator: '1 234,56' is fine, '12 50' is not 1250
  s = s.trim().replace(/(\d)[\s\u00a0\u202f'’](?=\d)/g, `$1${group}`)

  const at = s.lastIndexOf(decimal)
  const whole = at === -1 ? s : s.slice(0, at)
  const fraction = at === -1 ? '' : s.slice(at + 1)
  if (!validGrouping(whole, group) || !/^\d*$/.test(fraction) || (whole === '' && fraction === '')) return undefined

  const digits = whole.split(group).join('').replace(/^0+(?=\d)/, '') || '0'
  const zero = /^0*$/.test(digits + fraction)
  return `${negative && !zero ? '-' : ''}${digits}${fraction === '' ? '' : `.${fraction}`}`
}

/** The order of a date's parts in a file: '2026-10-05' is YMD, '10/05/2026' MDY in the US, '05/10/2026' DMY elsewhere. */
export type DateOrder = 'YMD' | 'MDY' | 'DMY'

/** Three numbers separated by '/', '-', '.' or a space, and an optional time of day, which is ignored. */
const DATE = /^(\d{1,4})[/\-. ](\d{1,4})[/\-. ](\d{1,4})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * A date as a file writes it, as YYYY-MM-DD, or undefined when it isn't a real date in that order. Years must have
 * four digits ('10/05/26' is refused: the century would be a guess). With 'YMD', the compact '20261005' is accepted
 * too. A time of day after the date is ignored: a bank's dates are calendar dates, not instants.
 */
export function isoDate(text: string, order: DateOrder): string | undefined {
  const s = String(text ?? '').trim()
  let parts: string[] | undefined
  if (order === 'YMD' && /^\d{8}$/.test(s)) parts = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)]
  else {
    const m = DATE.exec(s)
    if (m) parts = [m[1], m[2], m[3]]
  }
  if (!parts) return undefined

  const [year, month, day] = order === 'YMD' ? parts : order === 'MDY' ? [parts[2], parts[0], parts[1]] : [parts[2], parts[1], parts[0]]
  if (year.length !== 4 || month.length > 2 || day.length > 2) return undefined
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  return isIsoDate(iso) ? iso : undefined
}
