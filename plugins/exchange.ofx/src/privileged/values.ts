// OFX's money and dates, read the careful way.
import type { AccountType } from '@tessera/accounts-api'

export type AmountResult =
  | { ok: true, minor: number, rounded?: boolean }
  | { ok: false }

/**
 * An OFX amount as minor units. The specification allows a comma or a period as the decimal separator, and
 * exporters in the wild add grouping separators the specification does not.
 *
 * Read as text, never through `parseFloat`: 0.07 has no exact binary representation, and a reader that goes
 * through a float will eventually be a cent out on somebody's statement.
 */
export function parseAmount(raw: string | undefined, digits = 2): AmountResult {
  if (raw === undefined) return { ok: false }
  let text = raw.trim().replace(/\s/g, '')
  if (text === '') return { ok: false }

  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) { negative = true; text = text.slice(1, -1) }
  if (text.startsWith('-')) { negative = true; text = text.slice(1) }
  else if (text.startsWith('+')) text = text.slice(1)

  if (!/^[\d.,]*$/.test(text) || !/\d/.test(text)) return { ok: false }

  // OFX allows a period or a comma as the decimal separator and no grouping at all, so a single separator is
  // always the decimal point — `142.000` is three decimal places, not a hundred and forty-two thousand.
  // Grouping does turn up from broken exporters, and it gives itself away: either the two characters are both
  // present (`1,234.56`) or one of them repeats (`1.234.567`). Then the last one is the decimal point.
  const separators = [...text].filter(character => character === '.' || character === ',')
  const distinct = new Set(separators)
  const grouped = distinct.size > 1 || separators.length > 1
  const lastSeparator = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
  const after = lastSeparator === -1 ? '' : text.slice(lastSeparator + 1)

  // With grouping, a final group of exactly three digits is a group and not a fraction
  const isDecimal = lastSeparator !== -1 && after.length > 0 && !(grouped && after.length === 3)

  const whole = (isDecimal ? text.slice(0, lastSeparator) : text).replace(/[.,]/g, '')
  const fraction = isDecimal ? after : ''
  if (whole === '' && fraction === '') return { ok: false }

  let rounded = false
  let scaled: string
  if (fraction.length <= digits) {
    scaled = fraction.padEnd(digits, '0')
  } else {
    // More precision than the currency has. Trailing zeros are noise; anything else is rounded, and said so.
    const kept = fraction.slice(0, digits)
    const dropped = fraction.slice(digits)
    if (/[^0]/.test(dropped)) {
      rounded = true
      const roundUp = Number(dropped[0]) >= 5
      const value = BigInt(kept === '' ? '0' : kept) + (roundUp ? 1n : 0n)
      const carried = value >= 10n ** BigInt(digits)
      scaled = carried ? '0'.repeat(digits) : String(value).padStart(digits, '0')
      if (carried) {
        const minor = toMinor(String(BigInt(whole === '' ? '0' : whole) + 1n), scaled)
        return minor === undefined ? { ok: false } : { ok: true, minor: negative ? -minor : minor, rounded: true }
      }
    } else {
      scaled = kept.padEnd(digits, '0')
    }
  }

  const minor = toMinor(whole === '' ? '0' : whole, scaled)
  if (minor === undefined) return { ok: false }
  return { ok: true, minor: negative && minor !== 0 ? -minor : minor, ...(rounded && { rounded }) }
}

function toMinor(whole: string, fraction: string): number | undefined {
  const digits = `${whole.replace(/^0+(?=\d)/, '')}${fraction}`
  const value = Number(digits)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * The calendar date of an OFX timestamp: `YYYYMMDD` with an optional time, fraction and bracketed zone.
 *
 * The time is discarded rather than converted. Converting `20261103000000[-5:EST]` to UTC moves it to the 3rd
 * at 05:00, and `20261103000000[+13:NZDT]` to the **2nd** — a transaction silently on the wrong day, and worse,
 * on the wrong side of a statement boundary. A statement date is a calendar date in the bank's own terms.
 */
export function parseDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const digits = raw.trim().replace(/^\[|\]$/g, '')
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(digits)
  if (match === null) return undefined
  const [, year, month, day] = match
  const date = `${year}-${month}-${day}`
  return isRealDate(date) ? date : undefined
}

function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

/** What OFX calls an account type, as Tessera's. */
const ACCOUNT_TYPES: Record<string, AccountType> = {
  CHECKING: 'chequing',
  SAVINGS: 'savings',
  MONEYMRKT: 'savings',
  CREDITLINE: 'lineOfCredit',
  // A term deposit is not a chequing account and has no type of its own here
  CD: 'otherAsset'
}

export const accountTypeOf = (raw: string | undefined): AccountType | undefined =>
  raw === undefined ? undefined : ACCOUNT_TYPES[raw.trim().toUpperCase()]

/**
 * The `TRNTYPE` values that take money out. Used only by the `fromType` sign convention, for the exporters
 * that write every amount positive and leave the type word as the only indication of direction.
 */
const OUTGOING = new Set([
  'DEBIT', 'FEE', 'SRVCHG', 'ATM', 'POS', 'CHECK', 'PAYMENT', 'DIRECTDEBIT', 'REPEATPMT', 'CASH'
])

/**
 * Types that say nothing about direction. A transfer goes either way, so for these the file's own sign is the
 * only information there is and is kept — counting `XFER` as outgoing turned every incoming transfer negative.
 */
const DIRECTIONLESS = new Set(['XFER', 'OTHER'])

export type SignConvention = 'asGiven' | 'invert' | 'fromType'

export const SIGN_CONVENTIONS: readonly SignConvention[] = ['asGiven', 'invert', 'fromType']

export const isSignConvention = (value: unknown): value is SignConvention =>
  typeof value === 'string' && (SIGN_CONVENTIONS as readonly string[]).includes(value)

/** The amount as Tessera signs it: positive raises the account's balance. */
export function applySign(minor: number, trnType: string | undefined, convention: SignConvention): number {
  if (convention === 'invert') return minor === 0 ? 0 : -minor
  if (convention === 'fromType') {
    const type = (trnType ?? '').trim().toUpperCase()
    const magnitude = Math.abs(minor)
    // Zero has no sign, and `-0` prints as "-0.00".
    if (magnitude === 0) return 0
    if (DIRECTIONLESS.has(type)) return minor
    return OUTGOING.has(type) ? -magnitude : magnitude
  }
  return minor
}
