// How budgets look: months and periods in words, amounts, and the share of a budget spent.
import { formatAmount } from '@tessera/accounts-api'
import { budgetYear, yearToDate, type BudgetPeriod, type MonthRange } from '@tessera/budget-api'

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' })
const monthYearFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortMonthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })

const utc = (month: string, day = 1) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, day))

/** 'March 2027'. */
export const monthName = (month: string) => monthYearFormat.format(utc(month))
/** 'March'. */
export const monthOnly = (month: string) => monthFormat.format(utc(month))
/** 'Mar'. */
export const shortMonth = (month: string) => shortMonthFormat.format(utc(month))
/** 'Mar 15, 2027', in the user's locale, for a 'YYYY-MM-DD'. */
export const showDate = (date: string) => dateFormat.format(utc(date.slice(0, 7), Number(date.slice(8, 10))))

/** The months a period covers, for a budget whose year starts in `yearStartMonth`. */
export function periodMonths(period: BudgetPeriod, month: string, yearStartMonth: number): MonthRange {
  if (period === 'yearToDate') return yearToDate(month, yearStartMonth)
  if (period === 'year') return budgetYear(month, yearStartMonth)
  return { from: month, to: month }
}

/** 'January to March 2027'; 'April 2026 to March 2027'; 'March 2027' for one month. */
export function rangeName({ from, to }: MonthRange): string {
  if (from === to) return monthName(to)
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthOnly(from)} to ${monthName(to)}`
  return `${monthName(from)} to ${monthName(to)}`
}

/** What the period is called in the heading: 'March 2027', 'Year to date, January to March 2027'. */
export function periodName(period: BudgetPeriod, month: string, yearStartMonth: number): string {
  const range = periodMonths(period, month, yearStartMonth)
  if (period === 'month') return monthName(month)
  return `${period === 'yearToDate' ? 'Year to date' : 'Year'}, ${rangeName(range)}`
}

/** An amount in the grid: no currency symbol (the heading names the currency), a minus when negative. */
export const amount = (minor: number, currency: string) => formatAmount(minor, currency, { currency: false })

/**
 * How much of a budget the actual is, as a whole percentage, rounded down, for the bar and its label; undefined when
 * there is no budget to measure against. In integers, as the plugin's warnings are worked out, so the two agree: with
 * `actual / budget * 100` in floating point, 29 of 100 showed 28 %. BigInt once `actual × 100` would pass the safe
 * integers.
 */
export function percentOf(actual: number, budget: number): number | undefined {
  if (budget <= 0) return undefined
  if (actual <= 0) return 0
  const scaled = actual * 100
  if (Number.isSafeInteger(scaled)) return (scaled - scaled % budget) / budget
  return Number(BigInt(actual) * 100n / BigInt(budget))
}
