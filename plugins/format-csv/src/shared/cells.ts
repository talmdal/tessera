// What a CSV cell holds: a date, an amount, or text. Dates are read with the import API's helpers (month names and
// two-digit years allowed, as banks write both); amounts too, plus what CSV exports add: a 'CR' or 'DR' after the
// number. Amounts stay canonical decimal strings, and are added and negated as whole numbers, never floats.
import { canonicalDecimal, isoDate, type DateOrder, type DecimalSeparator } from '@tessera/import-api'

export const DATE_ORDERS: readonly DateOrder[] = ['YMD', 'MDY', 'DMY']

/** The pivot for two-digit years: a year ending in `yy` is the latest one not more than 10 years from now. */
export const pivotFor = (today: Date = new Date()) => today.getFullYear() + 10

/** A cell's date in `order`, as YYYY-MM-DD, or undefined. */
export const dateIn = (text: string, order: DateOrder, pivot: number): string | undefined =>
  isoDate(text, order, { pivot, monthNames: true })

/** True when the cell is a date in at least one order. */
export const isDateCell = (text: string, pivot: number): boolean =>
  text.trim() !== '' && DATE_ORDERS.some(order => dateIn(text, order, pivot) !== undefined)

/** A 'CR' or 'DR' written after (or before) an amount: '12.50 CR', 'DR 12.50'. */
const MARKED_AFTER = /^(.*?\d.*?)\s*\b(CR|DR)\.?$/i
const MARKED_BEFORE = /^(CR|DR)\.?\s*\b(.*\d.*)$/i

export interface AmountCell {
  /** Canonical, signed as written: a 'DR' makes it negative, a 'CR' positive. */
  amount: string
  /** 'CR' or 'DR', when the cell said so. */
  marker?: 'CR' | 'DR'
}

/** The amount a cell holds with `decimal` as the separator, or undefined when it holds none. */
export function amountIn(text: string, decimal: DecimalSeparator): AmountCell | undefined {
  let s = text.trim()
  if (s === '') return undefined
  let marker: 'CR' | 'DR' | undefined
  const after = MARKED_AFTER.exec(s)
  const before = after ? undefined : MARKED_BEFORE.exec(s)
  if (after) { marker = after[2].toUpperCase() as 'CR' | 'DR'; s = after[1] }
  else if (before) { marker = before[1].toUpperCase() as 'CR' | 'DR'; s = before[2] }
  const canonical = canonicalDecimal(s, { decimal })
  if (canonical === undefined) return undefined
  if (!marker) return { amount: canonical }
  return { amount: marker === 'DR' ? negate(magnitude(canonical)) : magnitude(canonical), marker }
}

/** True when the cell is an amount with either separator. */
export const isAmountCell = (text: string): boolean => amountIn(text, '.') !== undefined || amountIn(text, ',') !== undefined

/** A canonical decimal without its sign. */
export const magnitude = (canonical: string) => canonical.replace(/^-/, '')

/** A canonical decimal negated ('0' stays '0'). */
export function negate(canonical: string): string {
  if (canonical.startsWith('-')) return canonical.slice(1)
  return /^0(\.0+)?$/.test(canonical) ? canonical : `-${canonical}`
}

const decimalsOf = (canonical: string) => canonical.split('.')[1]?.length ?? 0

/** A canonical decimal as a whole number of units of 10^-decimals. */
export function toUnits(canonical: string, decimals: number): bigint {
  const negative = canonical.startsWith('-')
  const [whole, fraction = ''] = magnitude(canonical).split('.')
  const units = BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals))
  return negative ? -units : units
}

/** Units of 10^-decimals as a canonical decimal. */
export function fromUnits(units: bigint, decimals: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const text = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
  return negative && units !== 0n ? `-${text}` : text
}

/** a − b, canonical, with as many decimals as the longer of the two. */
export function subtract(a: string, b: string): string {
  const decimals = Math.max(decimalsOf(a), decimalsOf(b))
  return fromUnits(toUnits(a, decimals) - toUnits(b, decimals), decimals)
}

/** a + b, canonical. */
export const add = (a: string, b: string) => subtract(a, negate(b))

/** True when two canonical decimals are the same number ('12.5' and '12.50'). */
export const same = (a: string, b: string) => /^-?0(\.0+)?$/.test(subtract(a, b))

/** The sign of a canonical decimal: -1, 0 or 1. */
export const signOf = (canonical: string): number => /^-?0(\.0+)?$/.test(canonical) ? 0 : canonical.startsWith('-') ? -1 : 1
