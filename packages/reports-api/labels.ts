// How periods, columns and dates read, in the user's own locale: "Jan 2026", "Q1 2026–27", "Mar 10 – 31, 2026". Only
// labels: every date is worked out in periods.ts, on day numbers. Dates are formatted in UTC from their own parts, so
// no time zone can move a day. `locale` is for tests; the default is the user's.
import type { YearStart } from '@tessera/ledger-api'
import {
  firstDayOf, isCalendarYear, lastDayOf, monthOf, quarterNumber, yearOf, type DateRange, type TimeColumn
} from './periods'

const EN_DASH = '–'

const utc = (date: string) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10) || '1')))

const formatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })

/** "Mar 10, 2026", "10 Mar 2026". */
export const dayLabel = (date: string, locale?: string): string =>
  formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(utc(date))

/** "Jan 2026". */
export const monthLabel = (month: string, locale?: string): string =>
  formatter(locale, { month: 'short', year: 'numeric' }).format(utc(`${month}-01`))

/** "2026" for a calendar year; "2026–27" for one starting in another month. */
export function yearLabel(range: DateRange, start: YearStart): string {
  const first = Number(range.from.slice(0, 4))
  return isCalendarYear(start) ? String(first) : `${first}${EN_DASH}${String((first + 1) % 100).padStart(2, '0')}`
}

/** Whether a range is whole months: from a 1st to a month's last day. */
const isWholeMonths = (range: DateRange) => range.from === firstDayOf(monthOf(range.from)) && range.to === lastDayOf(monthOf(range.to))

/**
 * A period as a report's heading names it: "2026" or "2026–27" for exactly a year of the ledger's; "March 2026" for one
 * whole month; "January – March 2026" for whole months; else its dates, "Mar 10 – Apr 15, 2026".
 */
export function periodLabel(range: DateRange, start: YearStart, locale?: string): string {
  const year = yearOf(range.from, start)
  if (year.from === range.from && year.to === range.to) return yearLabel(year, start)
  if (isWholeMonths(range)) {
    const months = formatter(locale, { month: 'long', year: 'numeric' })
    return monthOf(range.from) === monthOf(range.to)
      ? months.format(utc(range.from))
      : months.formatRange(utc(range.from), utc(range.to))
  }
  if (range.from === range.to) return dayLabel(range.from, locale)
  return formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(utc(range.from), utc(range.to))
}

/** A time column's heading: "Jan 2026", "Q1 2026", "2026–27", a date; a partial one by its dates, "Mar 10 – 31, 2026". */
export function columnLabel(column: TimeColumn, start: YearStart, locale?: string): string {
  if (column.grain === 'date') return dayLabel(column.key, locale)
  if (column.partial) {
    return column.from === column.to
      ? dayLabel(column.from, locale)
      : formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(utc(column.from), utc(column.to))
  }
  if (column.grain === 'month') return monthLabel(column.key, locale)
  const year = yearLabel(yearOf(column.from, { month: start.month, day: 1 }), start)
  return column.grain === 'year' ? year : `Q${quarterNumber(column.key, start)} ${year}`
}

/** The dates of a balances report: one date, or "Month ends, Jan – Jun 2026". */
export function datesLabel(dates: readonly string[], grain: 'month' | 'quarter' | 'year', locale?: string): string {
  if (dates.length === 1) return dayLabel(dates[0], locale)
  const ends = grain === 'month' ? 'Month ends' : grain === 'quarter' ? 'Quarter ends' : 'Year ends'
  const first = dates[0], last = dates[dates.length - 1]
  return `${ends}, ${formatter(locale, { month: 'short', year: 'numeric' }).formatRange(utc(first), utc(last))}`
}
