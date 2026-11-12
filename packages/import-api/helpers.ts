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

/**
 * A file's name without what changes from one download to the next: the extension, digits and dates, copy suffixes
 * ('Checking 2026-10 (2).qif' → 'checking', 'Visa - Copy.csv' → 'visa'); words joined by '-'. Empty when nothing is
 * left. The import manager keys a statement that has no key of its own by it, and a format may key its statements
 * the same way. (Since import-api 1.6.)
 */
export function fileNameStem(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '').toLowerCase()
    .replace(/\(\d+\)|\bcopy\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}]+/gu, ' ').trim().replace(/\s+/g, '-')
}

/** The order of a date's parts in a file: '2026-10-05' is YMD, '10/05/2026' MDY in the US, '05/10/2026' DMY elsewhere. */
export type DateOrder = 'YMD' | 'MDY' | 'DMY'

/** How `isoDate` and `guessDateOrder` read dates beyond the plain numeric forms. Both are off unless asked for. */
export interface DateOptions {
  /**
   * Accept two-digit years: `yy` is the latest year ending in `yy` that isn't after `pivot`. Callers pass the current
   * year plus 10, so in 2026 '26' is 2026, '36' is 2036 and '37' is 1937. Without it, a two-digit year is refused.
   * Only a year written last (MDY, DMY) may have two digits: '26/10/05' first would make almost every date ambiguous.
   */
  pivot?: number
  /**
   * Accept a month's name, in English or French, in full or cut short ('Oct', 'oct.', 'octobre', 'Sept', 'févr.'):
   * '5 Oct 2026', '05-Oct-2026', 'Oct 5, 2026', 'October 5 2026', '5 octobre 2026', '2026-Oct-05'. Where the name
   * stands says the order, so `order` is not used for these.
   */
  monthNames?: boolean
}

/** Three numbers separated by '/', '-', '.' or a space, and an optional time of day, which is ignored. */
const DATE = /^(\d{1,4})[/\-. ](\d{1,4})[/\-. ](\d{1,4})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** A time of day after a date, which is ignored. */
const TIME = /(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)$/

/** Months' full names, English and French, without accents: a name cut short is read as the month it starts. */
const MONTH_NAMES: readonly (readonly string[])[] = [
  ['january', 'janvier'], ['february', 'fevrier'], ['march', 'mars'], ['april', 'avril'], ['may', 'mai'], ['june', 'juin'],
  ['july', 'juillet'], ['august', 'aout'], ['september', 'septembre'], ['october', 'octobre'], ['november', 'novembre'],
  ['december', 'decembre']
]

const withoutAccents = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/**
 * The month (1 to 12) a word names, or undefined: a full name, or at least its first three letters when those start
 * only one month's names ('jui' could be juin or juillet, so it names neither).
 */
export function monthOf(word: string): number | undefined {
  const w = withoutAccents(word.trim().toLowerCase()).replace(/\.$/, '')
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return undefined
  const months = new Set<number>()
  MONTH_NAMES.forEach((names, i) => { if (names.some(name => name.startsWith(w))) months.add(i + 1) })
  return months.size === 1 ? [...months][0] : undefined
}

/** A year as written: four digits, or two with a pivot. */
function yearOf(text: string, pivot: number | undefined): string | undefined {
  if (text.length === 4) return text
  if (text.length !== 2 || pivot === undefined) return undefined
  const century = Math.floor(pivot / 100) * 100
  const year = century + Number(text)
  return String(year > pivot ? year - 100 : year)
}

function iso(year: string | undefined, month: string | number, day: string): string | undefined {
  if (year === undefined || String(month).length > 2 || day.length > 2) return undefined
  const text = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`
  return isIsoDate(text) ? text : undefined
}

/** A date written with its month's name, and the order its parts come in; undefined when it isn't one. */
function namedDate(text: string, pivot: number | undefined): { date: string, order: DateOrder } | undefined {
  const parts = text.replace(TIME, '').trim().split(/[\s/\-,]+|\.(?=\s|\d|$)/).filter(part => part !== '')
  if (parts.length !== 3) return undefined
  const named = parts.map(part => /\d/.test(part) ? undefined : monthOf(part))
  const at = named.findIndex(month => month !== undefined)
  if (at === -1 || named.filter(m => m !== undefined).length !== 1) return undefined
  const numbers = parts.filter((_, i) => i !== at)
  if (!numbers.every(n => /^\d{1,4}$/.test(n))) return undefined
  const month = named[at]!
  if (at === 0) {                                        // Oct 5, 2026
    const date = iso(yearOf(numbers[1], pivot), month, numbers[0])
    return date ? { date, order: 'MDY' } : undefined
  }
  if (at === 1 && numbers[0].length === 4) {             // 2026-Oct-05
    const date = iso(numbers[0], month, numbers[1])
    return date ? { date, order: 'YMD' } : undefined
  }
  if (at === 1) {                                        // 5 Oct 2026
    const date = iso(yearOf(numbers[1], pivot), month, numbers[0])
    return date ? { date, order: 'DMY' } : undefined
  }
  return undefined
}

/**
 * A date as a file writes it, as YYYY-MM-DD, or undefined when it isn't a real date in that order. Years must have
 * four digits ('10/05/26' is refused: the century would be a guess) unless `options.pivot` says how to read two. With
 * 'YMD', the compact '20261005' is accepted too. A time of day after the date is ignored: a bank's dates are calendar
 * dates, not instants. With `options.monthNames`, dates written with the month's name are read too.
 */
export function isoDate(text: string, order: DateOrder, options: DateOptions = {}): string | undefined {
  const s = String(text ?? '').trim()
  let parts: string[] | undefined
  if (order === 'YMD' && /^\d{8}$/.test(s)) parts = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)]
  else {
    const m = DATE.exec(s)
    if (m) parts = [m[1], m[2], m[3]]
  }
  if (!parts) return options.monthNames ? namedDate(s, options.pivot)?.date : undefined

  const [year, month, day] = order === 'YMD' ? parts : order === 'MDY' ? [parts[2], parts[0], parts[1]] : [parts[2], parts[1], parts[0]]
  return iso(yearOf(year, order === 'YMD' ? undefined : options.pivot), month, day)
}

const ORDERS: readonly DateOrder[] = ['YMD', 'MDY', 'DMY']

/**
 * The orders in which every sample is a real date, for a column or field that holds every date in a file. One order:
 * decided. Several: ambiguous ('03/04/2026' throughout), so ask, or use a remembered choice. None: these aren't dates in
 * any one order. A date written with its month's name allows only the order it is written in. Empty samples are
 * ignored, and with none left the answer is empty.
 */
export function guessDateOrder(samples: readonly string[], options: DateOptions = {}): DateOrder[] {
  const texts = samples.map(s => String(s ?? '').trim()).filter(s => s !== '')
  if (texts.length === 0) return []
  return ORDERS.filter(order => texts.every(text => {
    if (DATE.test(text) || /^\d{8}$/.test(text)) return isoDate(text, order, { ...options, monthNames: false }) !== undefined
    if (!options.monthNames) return false
    return namedDate(text, options.pivot)?.order === order
  }))
}

/**
 * The decimal separators with which every sample is an amount. '1,234' fits both; '1,234.56' and '12,50' decide.
 * Empty samples are ignored, and with none left the answer is empty.
 */
export function guessDecimal(samples: readonly string[]): DecimalSeparator[] {
  const texts = samples.map(s => String(s ?? '').trim()).filter(s => s !== '')
  if (texts.length === 0) return []
  return (['.', ','] as const).filter(decimal => texts.every(text => canonicalDecimal(text, { decimal }) !== undefined))
}
