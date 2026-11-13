// How a recurring transaction repeats. Pure data and (from phase 1) pure functions: no storage, no clock, no Date
// object crossing a boundary. Dates are 'YYYY-MM-DD' throughout, as everywhere else in the finance domain.
//
// Occurrences are computed from the schedule and an index, never stored, so an edited schedule has no stored future
// rows to rewrite. See docs/recurring-transactions-design.md, "The schedule".

export const FREQUENCIES = ['daily', 'weekly', 'semiMonthly', 'monthly', 'yearly'] as const

export type Frequency = typeof FREQUENCIES[number]

/** What a person calls each frequency, on its own (an interval of 1). */
export const FREQUENCY_LABELS: Readonly<Record<Frequency, string>> = {
  daily: 'Daily',
  weekly: 'Weekly',
  semiMonthly: 'Twice a month',
  monthly: 'Monthly',
  yearly: 'Yearly'
}

/** A day of the month: 1–31, or the last day whatever the month's length. */
export type MonthDay = number | 'last'

/** How a monthly or yearly schedule picks the day in its month. */
export type MonthlyRule =
  | { kind: 'dayOfMonth', day: MonthDay }
  /** 'the second Tuesday'; with `week: -1`, 'the last Friday'. `weekday` is 0 for Sunday. */
  | { kind: 'nthWeekday', week: 1 | 2 | 3 | 4 | -1, weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }

/**
 * What to do when an occurrence lands on a day that is not a business day: a Saturday, a Sunday, or a holiday the
 * book knows about (see `BusinessCalendar`). The rule moves the date only; the next occurrence is still measured
 * from the unadjusted anchor, so a rule can never drift a series.
 */
export type WeekendRule = 'none' | 'before' | 'after'

/**
 * The days a business-day rule steps over, beyond weekends. The engine is given one by whoever knows the book's
 * holidays; without one, only weekends count.
 */
export interface BusinessCalendar {
  /** YYYY-MM-DD dates that are not business days, over and above Saturdays and Sundays. */
  holidays?: Iterable<string>
}

export type ScheduleEnd =
  | { kind: 'never' }
  | { kind: 'onDate', date: string }
  /** Stops after this many occurrences counted from the start date, whether they were entered or skipped. */
  | { kind: 'afterCount', count: number }

export interface Schedule {
  frequency: Frequency
  /** Every `interval` units of the frequency; at least 1. Ignored by `semiMonthly`. */
  interval: number
  /** YYYY-MM-DD: the first occurrence, and the anchor every later one is measured from. */
  startDate: string
  /** `monthly` and `yearly`. Default: the start date's day of the month. */
  monthlyRule?: MonthlyRule
  /** `semiMonthly` only: the two days of each month, ascending. Default `[1, 'last']`. */
  semiMonthlyDays?: [MonthDay, MonthDay]
  /** `yearly` only, 1–12. Default: the start date's month. */
  month?: number
  /** Default `'none'`. */
  weekendRule?: WeekendRule
  /** Default `{ kind: 'never' }`. */
  end?: ScheduleEnd
}

/** One dated instance of a schedule. Computed, never stored. */
export interface Occurrence {
  /**
   * 0-based position in the schedule's sequence. Occurrence 0 is the start date, unless an explicit day, month or
   * pair of days puts the rule's first date earlier ("monthly on the 15th, starting the 20th"), when it is the
   * first the rule produces on or after the start date.
   */
  index: number
  /** YYYY-MM-DD, after the weekend rule. This is the date the transaction gets. */
  date: string
  /** The unadjusted date, present only when the weekend rule moved it. */
  scheduledDate?: string
}

/** The frequency and interval behind each choice the dialog offers, in the order it offers them. */
export const FREQUENCY_CHOICES: readonly { label: string, frequency: Frequency, interval: number }[] = [
  { label: 'Daily', frequency: 'daily', interval: 1 },
  { label: 'Weekly', frequency: 'weekly', interval: 1 },
  { label: 'Every two weeks', frequency: 'weekly', interval: 2 },
  { label: 'Every four weeks', frequency: 'weekly', interval: 4 },
  { label: 'Twice a month', frequency: 'semiMonthly', interval: 1 },
  { label: 'Monthly', frequency: 'monthly', interval: 1 },
  { label: 'Every two months', frequency: 'monthly', interval: 2 },
  { label: 'Quarterly', frequency: 'monthly', interval: 3 },
  { label: 'Twice a year', frequency: 'monthly', interval: 6 },
  { label: 'Yearly', frequency: 'yearly', interval: 1 }
]

export const isFrequency = (value: unknown): value is Frequency => (FREQUENCIES as readonly unknown[]).includes(value)

export const MAX_INTERVAL = 999

/** The largest number of occurrences `occurrencesFrom` will generate in one call, so a bad schedule can't hang. */
export const MAX_OCCURRENCES = 1000
