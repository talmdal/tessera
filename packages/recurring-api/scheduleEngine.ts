// The schedule engine: turning a `Schedule` into dated occurrences, describing one in a sentence, and saying why
// one can't be used. Pure functions — no storage, no clock, and no `Date` object crosses a boundary. Dates are
// 'YYYY-MM-DD' strings, so no time zone enters the arithmetic.
//
// It lives in this package rather than in the plugin because both halves need it: the main process generates
// occurrences, and the series dialog previews the next few dates as the user types, with no round trip.
//
// The rules, each of which is a test (see docs/recurring-transactions-design.md, "Generating occurrences"):
//   - the index is the anchor, not the last date, so nothing accumulates error and no clamping compounds;
//   - a monthly or yearly day beyond the month's length clamps to its last day, and the anchor is unchanged;
//   - the weekend rule moves the date, never the sequence;
//   - `afterCount` counts occurrences from the first one, whether they were entered or skipped.
import { isIsoDate } from '@tessera/accounts-api'
import {
  FREQUENCY_CHOICES, MAX_INTERVAL, MAX_OCCURRENCES, isFrequency,
  type BusinessCalendar, type MonthDay, type MonthlyRule, type Occurrence, type Schedule, type WeekendRule
} from './schedule'

// ---- Dates, as plain strings

const DAY_MS = 86_400_000

interface Ymd { y: number, m: number, d: number }

const pad = (n: number) => String(n).padStart(2, '0')

const isoOf = ({ y, m, d }: Ymd) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`

function parseIso(iso: string): Ymd {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}

const utcOf = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d)

/** How many days are in month `m` (1–12) of year `y`; day 0 of the next month is the last of this one. */
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** `n` days after `iso` (negative moves back). */
export function addIsoDays(iso: string, n: number): string {
  const at = new Date(utcOf(parseIso(iso)) + n * DAY_MS)
  return isoOf({ y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() })
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
const daysBetween = (from: Ymd, to: Ymd) => Math.round((utcOf(to) - utcOf(from)) / DAY_MS)

/** 0 for Sunday, 6 for Saturday. */
export const weekdayOf = (iso: string) => new Date(utcOf(parseIso(iso))).getUTCDay()

const monthsBetween = (from: Ymd, to: Ymd) => (to.y - from.y) * 12 + (to.m - from.m)

/** A month number that may have run past December, carried into its year. */
function normaliseMonth(y: number, m: number): { y: number, m: number } {
  const total = y * 12 + (m - 1)
  const year = Math.floor(total / 12)
  return { y: year, m: total - year * 12 + 1 }
}

// ---- The rules

const SATURDAY = 6
const SUNDAY = 0

/** The longest run of non-business days a rule will step over: a fortnight is more than any calendar has. */
const MAX_SHIFT = 14

const NO_HOLIDAYS: ReadonlySet<string> = new Set()

/** The calendar's holidays as a set, so each date is one lookup. */
export function holidaySet(calendar: BusinessCalendar | undefined): ReadonlySet<string> {
  if (!calendar?.holidays) return NO_HOLIDAYS
  return calendar.holidays instanceof Set ? calendar.holidays : new Set(calendar.holidays)
}

/** A business day: not a Saturday, not a Sunday, not a holiday the calendar names. */
export function isBusinessDay(iso: string, calendar?: BusinessCalendar | ReadonlySet<string>): boolean {
  const weekday = weekdayOf(iso)
  if (weekday === SATURDAY || weekday === SUNDAY) return false
  const holidays = calendar instanceof Set ? calendar : holidaySet(calendar as BusinessCalendar | undefined)
  return !holidays.has(iso)
}

/**
 * Where a business-day rule puts a date: on the nearest business day before it or after it. A business day is
 * never moved; the rule is applied to the anchor, not compounded. Without a calendar, only weekends count.
 */
export function applyWeekendRule(iso: string, rule: WeekendRule | undefined, calendar?: BusinessCalendar | ReadonlySet<string>): string {
  if (rule === undefined || rule === 'none') return iso
  const holidays = calendar instanceof Set ? calendar : holidaySet(calendar as BusinessCalendar | undefined)
  const step = rule === 'before' ? -1 : 1
  let at = iso
  for (let moved = 0; moved < MAX_SHIFT && !isBusinessDay(at, holidays); moved++) at = addIsoDays(at, step)
  return at
}

/** A day of the month inside a given month: `'last'`, and anything past the month's end, become its last day. */
const clampDay = (day: MonthDay, y: number, m: number) =>
  day === 'last' ? daysInMonth(y, m) : Math.min(Math.max(Math.trunc(day), 1), daysInMonth(y, m))

/** The day `rule` picks in month `m` of year `y`. Weeks 1–4 always exist, since every month has 28 days or more. */
function dayFromRule(rule: MonthlyRule, y: number, m: number): number {
  if (rule.kind === 'dayOfMonth') return clampDay(rule.day, y, m)
  const { week, weekday } = rule
  if (week === -1) {
    const last = daysInMonth(y, m)
    const lastWeekday = weekdayOf(isoOf({ y, m, d: last }))
    return last - (lastWeekday - weekday + 7) % 7
  }
  const firstWeekday = weekdayOf(isoOf({ y, m, d: 1 }))
  return 1 + (weekday - firstWeekday + 7) % 7 + (week - 1) * 7
}

const DEFAULT_SEMI_MONTHLY: [MonthDay, MonthDay] = [1, 'last']

/** A schedule reduced to what generating needs, computed once per call rather than per occurrence. */
interface Compiled {
  schedule: Schedule
  start: Ymd
  rule: MonthlyRule
  semiMonthlyDays: [MonthDay, MonthDay]
  month: number
  /**
   * How many raw dates the rule produces before the start date. It is 0 unless an explicit day, month or pair of
   * days puts the rule's first date earlier than the start ("monthly on the 15th, starting the 20th"), in which
   * case occurrence 0 is the next one. Never more than 2 (twice a month is the densest rule that can be shifted).
   */
  offset: number
  /** The book's holidays, for the business-day rule. */
  holidays: ReadonlySet<string>
}

/** The guards generating depends on. Everything else `validateSchedule` reports; this only keeps the maths safe. */
function usable(schedule: Schedule | undefined | null): schedule is Schedule {
  if (typeof schedule !== 'object' || schedule === null) return false
  const { frequency, interval, startDate } = schedule
  return isFrequency(frequency) && Number.isInteger(interval) && interval >= 1 && interval <= MAX_INTERVAL && isIsoDate(startDate)
}

function compile(schedule: Schedule, calendar?: BusinessCalendar): Compiled | undefined {
  if (!usable(schedule)) return undefined
  const start = parseIso(schedule.startDate)
  const compiled: Compiled = {
    schedule,
    start,
    rule: schedule.monthlyRule ?? { kind: 'dayOfMonth', day: start.d },
    semiMonthlyDays: schedule.semiMonthlyDays ?? DEFAULT_SEMI_MONTHLY,
    month: schedule.month ?? start.m,
    offset: 0,
    holidays: holidaySet(calendar)
  }
  // Only a rule that names its own day, days or month can fall before the start date
  if (schedule.monthlyRule !== undefined || schedule.semiMonthlyDays !== undefined || schedule.month !== undefined) {
    for (let raw = 0; raw < 4 && rawDateAt(compiled, raw) < schedule.startDate; raw++) compiled.offset = raw + 1
  }
  return compiled
}

/** The unadjusted date of raw index `raw` (the sequence before `offset` is applied). Always increasing in `raw`. */
function rawDateAt(c: Compiled, raw: number): string {
  const { frequency, interval } = c.schedule
  switch (frequency) {
    case 'daily':
      return addIsoDays(c.schedule.startDate, raw * interval)
    case 'weekly':
      return addIsoDays(c.schedule.startDate, raw * interval * 7)
    case 'semiMonthly': {
      const { y, m } = normaliseMonth(c.start.y, c.start.m + Math.floor(raw / 2))
      return isoOf({ y, m, d: clampDay(c.semiMonthlyDays[raw % 2], y, m) })
    }
    case 'monthly': {
      const { y, m } = normaliseMonth(c.start.y, c.start.m + raw * interval)
      return isoOf({ y, m, d: dayFromRule(c.rule, y, m) })
    }
    case 'yearly': {
      const y = c.start.y + raw * interval
      return isoOf({ y, m: c.month, d: dayFromRule(c.rule, y, c.month) })
    }
  }
}

/** The occurrence at a public index, or undefined once the end rule has passed. */
function at(c: Compiled, index: number): Occurrence | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined
  const end = c.schedule.end
  if (end?.kind === 'afterCount') {
    if (!Number.isInteger(end.count) || index >= end.count) return undefined
  }
  const scheduled = rawDateAt(c, index + c.offset)
  // The end date belongs to the rule, so it is compared with the anchor, not with a date a business-day rule moved
  if (end?.kind === 'onDate' && (!isIsoDate(end.date) || scheduled > end.date)) return undefined
  const date = applyWeekendRule(scheduled, c.schedule.weekendRule, c.holidays)
  return { index, date, ...(date !== scheduled && { scheduledDate: scheduled }) }
}

// ---- What the rest of the plugin uses

/**
 * The occurrence at `index`, or undefined when the end rule has passed (or the schedule can't be used at all —
 * `validateSchedule` says why). Total: no clock, no exceptions. `calendar` supplies the holidays a business-day
 * rule steps over; without it, only weekends do.
 */
export function occurrenceAt(schedule: Schedule, index: number, calendar?: BusinessCalendar): Occurrence | undefined {
  const c = compile(schedule, calendar)
  return c && at(c, index)
}

/**
 * Occurrences in ascending order, from `fromIndex` (default 0). Stops at the end rule, at `limit`
 * (`MAX_OCCURRENCES` at most, and by default), or once a date passes `until` — which is compared with the date a
 * transaction would get, business-day rule and all, since that is the date a caller is asking about.
 */
export function occurrencesFrom(
  schedule: Schedule,
  options: { fromIndex?: number, until?: string, limit?: number, calendar?: BusinessCalendar } = {}
): Occurrence[] {
  const c = compile(schedule, options.calendar)
  if (!c) return []
  const { until } = options
  if (until !== undefined && !isIsoDate(until)) return []
  const cap = Math.min(options.limit ?? MAX_OCCURRENCES, MAX_OCCURRENCES)
  const found: Occurrence[] = []
  for (let index = Math.max(0, Math.trunc(options.fromIndex ?? 0)); found.length < cap; index++) {
    const occurrence = at(c, index)
    // A business-day rule never makes a later occurrence land earlier (the nearest business day on one side of a
    // later anchor is never before that of an earlier one), so the first one past `until` ends the search
    if (!occurrence || (until !== undefined && occurrence.date > until)) break
    found.push(occurrence)
  }
  return found
}

/** How far a search will walk before giving up, so a strange schedule can't hang the app. */
const SEARCH_LIMIT = 512

/** Roughly which index lands on `target`, from the frequency alone; the search corrects it in a step or two. */
function estimateIndex(c: Compiled, target: Ymd): number {
  const { frequency, interval } = c.schedule
  const months = monthsBetween(c.start, target)
  const raw = frequency === 'daily' ? Math.floor(daysBetween(c.start, target) / interval)
    : frequency === 'weekly' ? Math.floor(daysBetween(c.start, target) / (7 * interval))
      : frequency === 'semiMonthly' ? months * 2
        : frequency === 'monthly' ? Math.floor(months / interval)
          : Math.floor(months / (12 * interval))
  return raw - c.offset
}

/**
 * The index of the first occurrence falling on or after `date`, or undefined when the series ends before it. Used
 * to place a series' next occurrence after an edit, where the gap can be years, so it estimates rather than scans.
 */
export function firstIndexOnOrAfter(schedule: Schedule, date: string, calendar?: BusinessCalendar): number | undefined {
  const c = compile(schedule, calendar)
  if (!c || !isIsoDate(date)) return undefined

  let index = Math.max(0, estimateIndex(c, parseIso(date)))
  // Back up until the one before is genuinely earlier, so the answer is the *first* match even where dates repeat
  for (let steps = 0; index > 0 && steps < SEARCH_LIMIT; steps++) {
    const previous = at(c, index - 1)
    if (!previous || previous.date < date) break
    index--
  }
  for (let steps = 0; steps <= SEARCH_LIMIT; steps++) {
    const occurrence = at(c, index)
    if (!occurrence) return undefined
    if (occurrence.date >= date) return occurrence.index
    index++
  }
  return undefined
}

/**
 * How many occurrences fall on or before `date`, counting from `fromIndex` — the count behind "3 overdue".
 * Capped at `MAX_OCCURRENCES`, which a book abandoned for years could reach.
 */
export function countThrough(schedule: Schedule, fromIndex: number, date: string, calendar?: BusinessCalendar): number {
  return occurrencesFrom(schedule, { fromIndex, until: date, calendar }).length
}

// ---- Saying it in words

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const WEEK_NAMES: Readonly<Record<string, string>> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' }

/** '1st', '2nd', '3rd', '11th', '21st'. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** 'Monthly', 'Quarterly', 'Every two weeks' — the dialog's wording where there is one, else 'Every 5 days'. */
function everyLabel(frequency: Schedule['frequency'], interval: number): string {
  const choice = FREQUENCY_CHOICES.find(c => c.frequency === frequency && c.interval === interval)
  if (choice) return choice.label
  const unit = frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : 'year'
  return `Every ${interval} ${unit}s`
}

/** 'the 15th', 'the last day', 'the second Tuesday'. */
function dayLabel(rule: MonthlyRule): string {
  if (rule.kind === 'dayOfMonth') return rule.day === 'last' ? 'the last day' : `the ${ordinal(rule.day)}`
  return `the ${WEEK_NAMES[String(rule.week)] ?? ''} ${WEEKDAY_NAMES[rule.weekday] ?? ''}`.replace(/\s+/g, ' ').trim()
}

const WEEKEND_NOTE: Readonly<Record<WeekendRule, string>> = {
  none: '',
  before: ' (moved to the business day before)',
  after: ' (moved to the next business day)'
}

/**
 * The schedule in one sentence, for the list's Frequency column and the dialog's preview: 'Monthly on the 15th',
 * 'Every two weeks on Friday', 'Yearly on 1 July'. When it ends is shown separately, so it isn't included here.
 */
export function describeSchedule(schedule: Schedule): string {
  const c = compile(schedule)
  if (!c) return ''
  const { frequency, interval } = schedule
  const every = everyLabel(frequency, interval)
  const base = (() => {
    switch (frequency) {
      case 'daily':
        return every
      case 'weekly':
        return `${every} on ${WEEKDAY_NAMES[weekdayOf(schedule.startDate)]}`
      case 'semiMonthly':
        return `${every}, on ${dayLabel({ kind: 'dayOfMonth', day: c.semiMonthlyDays[0] })} and ${dayLabel({ kind: 'dayOfMonth', day: c.semiMonthlyDays[1] })}`
      case 'monthly':
        return `${every} on ${dayLabel(c.rule)}`
      case 'yearly':
        return c.rule.kind === 'dayOfMonth' && c.rule.day !== 'last'
          ? `${every} on ${c.rule.day} ${MONTH_NAMES[c.month - 1]}`
          : `${every} on ${dayLabel(c.rule)} in ${MONTH_NAMES[c.month - 1]}`
    }
  })()
  return `${base}${WEEKEND_NOTE[schedule.weekendRule ?? 'none'] ?? ''}`
}

// ---- Saying why it can't be used

const WEEKEND_RULES: readonly string[] = ['none', 'before', 'after']
const END_KINDS: readonly string[] = ['never', 'onDate', 'afterCount']

const isMonthDay = (value: unknown): value is MonthDay =>
  value === 'last' || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31)

/** Sorts a day of the month, with 'last' after every number, so a pair can be checked for order. */
const dayRank = (day: MonthDay) => day === 'last' ? 32 : day

function problemWithRule(rule: MonthlyRule): string | undefined {
  if (typeof rule !== 'object' || rule === null) return 'Choose which day of the month it falls on.'
  if (rule.kind === 'dayOfMonth') {
    return isMonthDay(rule.day) ? undefined : 'Choose a day from 1 to 31, or the last day of the month.'
  }
  if (rule.kind === 'nthWeekday') {
    if (![1, 2, 3, 4, -1].includes(rule.week)) return 'Choose the first, second, third, fourth or last week of the month.'
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) return 'Choose a day of the week.'
    return undefined
  }
  return 'Choose which day of the month it falls on.'
}

/**
 * Why a schedule can't be used, or undefined. The dialog shows it as the user types; the service enforces it, so a
 * schedule that reaches storage always produces at least one occurrence.
 */
export function validateSchedule(schedule: Schedule): string | undefined {
  if (typeof schedule !== 'object' || schedule === null) return 'Choose how often it repeats.'
  const { frequency, interval, startDate, monthlyRule, semiMonthlyDays, month, weekendRule, end } = schedule

  if (!isFrequency(frequency)) return 'Choose how often it repeats.'
  if (!Number.isInteger(interval) || interval < 1) return 'Repeat it every 1 or more — enter a whole number.'
  if (interval > MAX_INTERVAL) return `Repeat it every ${MAX_INTERVAL} or fewer.`
  if (!isIsoDate(startDate)) return 'Enter the date it starts.'

  if (monthlyRule !== undefined) {
    if (frequency !== 'monthly' && frequency !== 'yearly') return 'A day of the month applies to monthly and yearly schedules only.'
    const problem = problemWithRule(monthlyRule)
    if (problem) return problem
  }

  if (semiMonthlyDays !== undefined) {
    if (frequency !== 'semiMonthly') return 'Two days a month apply to a twice-a-month schedule only.'
    if (!Array.isArray(semiMonthlyDays) || semiMonthlyDays.length !== 2 || !semiMonthlyDays.every(isMonthDay)) {
      return 'Choose two days from 1 to 31, or the last day of the month.'
    }
    if (dayRank(semiMonthlyDays[0]) >= dayRank(semiMonthlyDays[1])) return 'Choose two different days, the earlier one first.'
  }

  if (month !== undefined) {
    if (frequency !== 'yearly') return 'A month applies to a yearly schedule only.'
    if (!Number.isInteger(month) || month < 1 || month > 12) return 'Choose a month from 1 to 12.'
  }

  if (weekendRule !== undefined && !WEEKEND_RULES.includes(weekendRule)) return 'Choose what happens when it falls at a weekend.'

  if (end !== undefined) {
    if (typeof end !== 'object' || end === null || !END_KINDS.includes(end.kind)) return 'Choose when it ends.'
    if (end.kind === 'onDate') {
      if (!isIsoDate(end.date)) return 'Enter the date it ends.'
      if (end.date < startDate) return 'It can’t end before it starts.'
    }
    if (end.kind === 'afterCount' && (!Number.isInteger(end.count) || end.count < 1)) {
      return 'Enter how many times it repeats — 1 or more.'
    }
  }

  // Everything is well formed, and yet the rule produces nothing: "monthly on the 15th" ending before the 15th
  if (occurrenceAt(schedule, 0) === undefined) return 'This never happens. Change when it starts, or when it ends.'
  return undefined
}
