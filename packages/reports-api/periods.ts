// Periods: presets to dates, from today and the ledger's year start; the columns a time axis has; the dates balances
// are wanted at; the period compared with. Pure, and worked on day numbers computed from the 'YYYY-MM-DD' text, never
// on `Date`s in a time zone (the budget's plan.ts found naive local Dates a day out in three zones). `today` is passed
// in. See docs/reporting-design.md, "Periods" and "The ledger's year start".
import type { YearStart } from '@tessera/ledger-api'
import type { AsOfValue, PeriodValue } from './spec'

/** Dates, inclusive, 'YYYY-MM-DD'. */
export interface DateRange {
  from: string
  to: string
}

export type Grain = 'month' | 'quarter' | 'year'

// ---- Days and months

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil): integers only. */
export function dayNumber(y: number, m: number, d: number): number {
  const year = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(year / 400)
  const yoe = year - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** The date of a day number, as [year, month, day] (Hinnant's civil_from_days). */
export function civil(z: number): [number, number, number] {
  const shifted = z + 719468
  const era = Math.floor(shifted / 146097)
  const doe = shifted - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return [era * 400 + yoe + (m <= 2 ? 1 : 0), m, d]
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
const parts = (date: string): [number, number, number] => [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))]

/** A day number as 'YYYY-MM-DD'. */
export const isoOf = (z: number): string => { const [y, m, d] = civil(z); return `${pad(y, 4)}-${pad(m)}-${pad(d)}` }

/** The day number of a 'YYYY-MM-DD' date. */
export const dayOf = (date: string): number => dayNumber(...parts(date))

/** How many days the month has. */
export const daysInMonth = (y: number, m: number): number =>
  m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31

/** A month written 'YYYY-MM', years 1000 to 9999. */
export function isMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false
  const m = Number(value.slice(5))
  return Number(value.slice(0, 4)) >= 1000 && m >= 1 && m <= 12
}

/** A real calendar date written 'YYYY-MM-DD', years 1000 to 9999. */
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isMonth(value.slice(0, 7))) return false
  const d = Number(value.slice(8))
  return d >= 1 && d <= daysInMonth(Number(value.slice(0, 4)), Number(value.slice(5, 7)))
}

/** `date` moved by `days`, either way. */
export const addDays = (date: string, days: number): string => isoOf(dayOf(date) + days)

/** Days from `from` to `to`, inclusive: 1 for one day. */
export const daysIn = (range: DateRange): number => dayOf(range.to) - dayOf(range.from) + 1

/** The month a date is in, 'YYYY-MM'. */
export const monthOf = (date: string): string => date.slice(0, 7)

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1
const monthOfIndex = (index: number) => `${pad(Math.floor(index / 12), 4)}-${pad(index % 12 + 1)}`

/** `month` moved by `count` months, either way. */
export const addMonths = (month: string, count: number): string => monthOfIndex(monthIndex(month) + count)

/** The first and last days of a month. */
export const firstDayOf = (month: string): string => `${month}-01`
export const lastDayOf = (month: string): string => `${month}-${pad(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`

/** Every month from `from` to `to`, inclusive, in order. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(monthOfIndex(i))
  return out
}

/** A day in a month, moved to the month's last day when the month is shorter (31 January + 1 month is 28 February). */
function dateIn(month: string, day: number): string {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
  return `${month}-${pad(Math.min(day, daysInMonth(y, m)))}`
}

/** `date` moved by `count` months, on the same day, or the month's last when it is shorter. */
export const addMonthsToDate = (date: string, count: number): string => dateIn(addMonths(monthOf(date), count), Number(date.slice(8, 10)))

const later = (a: string, b: string) => a > b ? a : b
const earlier = (a: string, b: string) => a < b ? a : b

// ---- Years and quarters, by the ledger's year start

/** The day the year starting in calendar year `year` begins. */
const yearStartIn = (year: number, start: YearStart): string => dateIn(`${pad(year, 4)}-${pad(start.month)}`, start.day)

/** Whether the year start is 1 January: a calendar year. */
export const isCalendarYear = (start: YearStart) => start.month === 1 && start.day === 1

/** The year (from the ledger's year start) that `date` falls in. */
export function yearOf(date: string, start: YearStart): DateRange {
  const y = Number(date.slice(0, 4))
  const begins = yearStartIn(y, start) <= date ? y : y - 1
  return { from: yearStartIn(begins, start), to: addDays(yearStartIn(begins + 1, start), -1) }
}

/** The quarter of the ledger's year that `date` falls in: three months from the year start, on its day. */
export function quarterOf(date: string, start: YearStart): DateRange {
  const year = yearOf(date, start)
  const starts = [0, 3, 6, 9, 12].map(k => dateIn(addMonths(monthOf(year.from), k), start.day))
  for (let k = 3; k >= 0; k--) {
    if (starts[k] <= date) return { from: starts[k], to: addDays(starts[k + 1], -1) }
  }
  return { from: starts[0], to: addDays(starts[1], -1) }
}

/** Which quarter of its year (1 to 4) a quarter starting in `month` is. */
export const quarterNumber = (month: string, start: YearStart): number =>
  Math.floor((((monthIndex(month) - (start.month - 1)) % 12) + 12) % 12 / 3) + 1

// ---- Presets

/**
 * The dates a period covers. `allDates` is the ledger's whole history, which only the caller knows (the earliest
 * opening date in scope to the latest transaction, or today): *All dates* needs it.
 */
export function resolvePeriod(value: PeriodValue, today: string, start: YearStart, allDates?: DateRange): DateRange {
  if (!('preset' in value)) return { from: value.from, to: value.to }
  const month = monthOf(today)
  switch (value.preset) {
    case 'thisMonth': return { from: firstDayOf(month), to: lastDayOf(month) }
    case 'lastMonth': return { from: firstDayOf(addMonths(month, -1)), to: lastDayOf(addMonths(month, -1)) }
    case 'thisQuarter': return quarterOf(today, start)
    case 'lastQuarter': return quarterOf(addDays(quarterOf(today, start).from, -1), start)
    case 'thisYear': return yearOf(today, start)
    case 'lastYear': return yearOf(addDays(yearOf(today, start).from, -1), start)
    case 'yearToDate': return { from: yearOf(today, start).from, to: today }
    case 'last3Months': return { from: firstDayOf(addMonths(month, -2)), to: lastDayOf(month) }
    case 'last12Months': return { from: firstDayOf(addMonths(month, -11)), to: lastDayOf(month) }
    case 'allDates':
      if (!allDates) throw new Error('All dates needs the ledger’s first and last dates')
      return { ...allDates }
  }
}

/** How many whole months a range is, when it starts and ends on the same day of the month (6 April to 5 April); else undefined. */
function wholeMonths(range: DateRange): number | undefined {
  const next = addDays(range.to, 1)
  const count = monthIndex(monthOf(next)) - monthIndex(monthOf(range.from))
  return count >= 1 && addMonthsToDate(range.from, count) === next ? count : undefined
}

/**
 * The period a report compares with: the same length immediately before (a year of months before a year of months;
 * 37 days before 37 days), or the same dates a year earlier (29 February becomes 28 February).
 */
export function comparedPeriod(range: DateRange, compare: 'previousPeriod' | 'previousYear'): DateRange {
  if (compare === 'previousYear') return { from: addMonthsToDate(range.from, -12), to: addMonthsToDate(range.to, -12) }
  const months = wholeMonths(range)
  if (months !== undefined) return { from: addMonthsToDate(range.from, -months), to: addDays(range.from, -1) }
  const days = daysIn(range)
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) }
}

// ---- Columns

/**
 * A column of a time axis: its key, its dates (within the period), and the source's time keys that fall in it (months
 * for a range source, a date for balances). Quarters and years are whole months, from the month the year starts in:
 * totals are kept by month, so a year starting on the 6th has columns from the 1st.
 */
export interface TimeColumn {
  key: string
  from: string
  to: string
  keys: string[]
  /** The column doesn't cover its whole month, quarter or year: the period starts or ends inside it. */
  partial: boolean
  grain: Grain | 'date'
}

/** The months, quarters or years of a period, each present even if nothing happened in it. */
export function timeColumns(range: DateRange, grain: Grain, start: YearStart): TimeColumn[] {
  const size = grain === 'month' ? 1 : grain === 'quarter' ? 3 : 12
  const offset = start.month - 1
  const buckets = new Map<number, string[]>()
  for (const month of monthsBetween(monthOf(range.from), monthOf(range.to))) {
    const bucket = Math.floor((monthIndex(month) - offset) / size) * size + offset
    const list = buckets.get(bucket)
    if (list) list.push(month)
    else buckets.set(bucket, [month])
  }
  return [...buckets].map(([bucket, months]) => {
    const first = firstDayOf(monthOfIndex(bucket))
    const last = lastDayOf(monthOfIndex(bucket + size - 1))
    const from = later(first, range.from)
    const to = earlier(last, range.to)
    return { key: monthOfIndex(bucket), from, to, keys: months, partial: from !== first || to !== last, grain }
  })
}

/** One column per date, in order, each once. */
export const dateColumns = (dates: readonly string[]): TimeColumn[] =>
  [...new Set(dates)].sort().map(date => ({ key: date, from: date, to: date, keys: [date], partial: false, grain: 'date' as const }))

// ---- As of

/**
 * The dates a balances report is for: one, or the end of each month, quarter or year (by the ledger's year start) of a
 * period, with the period's own end if it falls after the last of them. A series never reaches past today: its first
 * date after today becomes today, and it stops there.
 */
export function resolveAsOf(value: AsOfValue, grain: Grain, today: string, start: YearStart, allDates?: DateRange): string[] {
  if ('date' in value) return [value.date]
  if ('at' in value) {
    switch (value.at) {
      case 'today': return [today]
      case 'endOfLastMonth': return [lastDayOf(addMonths(monthOf(today), -1))]
      case 'endOfLastYear': return [addDays(yearOf(today, start).from, -1)]
    }
  }
  const range = resolvePeriod(value.ends, today, start, allDates)
  const ends: string[] = []
  if (grain === 'month') {
    for (const month of monthsBetween(monthOf(range.from), monthOf(range.to))) if (lastDayOf(month) <= range.to) ends.push(lastDayOf(month))
  } else {
    // Exact quarter and year ends, by the year start's day: 5 July ends a quarter of a year from 6 April
    const of = grain === 'quarter' ? quarterOf : yearOf
    for (let period = of(range.from, start); period.to <= range.to; period = of(addDays(period.to, 1), start)) ends.push(period.to)
  }
  if (ends[ends.length - 1] !== range.to) ends.push(range.to)
  const dates: string[] = []
  for (const date of ends) {
    if (date > today) { dates.push(today); break }
    dates.push(date)
  }
  return [...new Set(dates)].sort()
}
