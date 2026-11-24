// How a report's figures read: amounts from minor units (display only, never converted), counts, and percentages
// from basis points; the chart's axis in short; dates. Every figure on screen goes through here.
import { formatAmount, minorDigits } from '@tessera/accounts-api'
import type { ResultColumn } from '@tessera/reports-api'

/** An amount in the table: no currency symbol (the heading names the currency), a minus when negative. */
export const amount = (minor: number, currency: string | null | undefined) =>
  currency ? formatAmount(minor, currency, { currency: false }) : (minor / 100).toFixed(2)

/** An amount with its symbol: the chart's tooltips, a screen reader's label. */
export const money = (minor: number, currency: string | null | undefined) =>
  currency ? formatAmount(minor, currency) : (minor / 100).toFixed(2)

const compactFormats = new Map<string, Intl.NumberFormat>()

/** An amount on the chart's value axis, short: "$1.2K", "-$350". */
export function axisAmount(minor: number, currency: string | null | undefined): string {
  const code = currency ?? ''
  let format = compactFormats.get(code)
  if (!format) {
    format = new Intl.NumberFormat(undefined, { ...(code && { style: 'currency', currency: code }), notation: 'compact', maximumFractionDigits: 1 })
    compactFormats.set(code, format)
  }
  return format.format(minor / 10 ** (code ? minorDigits(code) : 2))
}

/**
 * Basis points as a percentage with one decimal, rounded toward zero as the engine's shares are, so the rows of a
 * share never add up to more than they are: 4,529 is "45.2 %". In integers: 4529 / 10 in floating point is fine, but
 * a figure past the safe integers never reaches here (the engine refuses it).
 */
export function percent(basisPoints: number): string {
  const tenths = Math.trunc(basisPoints / 10)
  const sign = tenths < 0 ? '-' : ''
  const abs = Math.abs(tenths)
  return `${sign}${Math.floor(abs / 10).toLocaleString()}.${abs % 10} %`
}

/** A figure of a column, as the table shows it; "—" for none. */
export function figure(value: number | null, column: Pick<ResultColumn, 'unit'>, currency: string | null | undefined): string {
  if (value === null) return '—'
  if (column.unit === 'percent') return percent(value)
  if (column.unit === 'count') return value.toLocaleString()
  return amount(value, currency)
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })

/** 'Mar 15, 2027', in the user's locale, for a 'YYYY-MM-DD'. */
export const showDate = (date: string) => dateFormat.format(new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))))

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

/** When figures were worked out, for "Showing the figures from 10:42". */
export const showTime = (iso: string) => timeFormat.format(new Date(iso))
