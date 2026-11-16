// The planning arithmetic: how much a line plans in a month, and on which days it falls due. Pure, and shared by the
// budget service and the dialogs' previews, so they can't disagree. Dates are worked on as day numbers computed from
// the 'YYYY-MM-DD' text, never as `Date`s in a time zone: a naive version with local Dates was wrong in London, Apia
// and Lord Howe (docs/budget-design.md, Phase B0 results, "The date arithmetic").
import { DAY_BASED_FREQUENCIES, FREQUENCIES, type BudgetLine, type Frequency, type LinePlan, type MonthRange, type PlanChange } from './model'
import { BUDGET_AMOUNT_MAX } from './protocol'

/** Months apart for the frequencies that fall in whole months. */
const MONTHS_APART: Partial<Record<Frequency, number>> = { monthly: 1, everyTwoMonths: 2, quarterly: 3, twiceAYear: 6, yearly: 12 }

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

/** A day number as 'YYYY-MM-DD'. */
export const isoOf = (z: number): string => { const [y, m, d] = civil(z); return `${pad(y, 4)}-${pad(m)}-${pad(d)}` }

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

const parseMonth = (month: string): [number, number] => [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
const monthIndex = (y: number, m: number) => y * 12 + (m - 1)
const monthOfIndex = (index: number) => `${pad(Math.floor(index / 12), 4)}-${pad(index % 12 + 1)}`

/** `month` moved by `count` months, either way: addMonths('2027-01', -1) is '2026-12'. */
export function addMonths(month: string, count: number): string {
  const [y, m] = parseMonth(month)
  return monthOfIndex(monthIndex(y, m) + count)
}

/** The first and last days of a month, 'YYYY-MM-DD'. */
export const firstDayOf = (month: string): string => `${month}-01`
export const lastDayOf = (month: string): string => { const [y, m] = parseMonth(month); return `${month}-${pad(daysInMonth(y, m))}` }

/** Every month of a range, in order. Empty when `to` is before `from`. */
export function monthsOf(range: MonthRange): string[] {
  const [fy, fm] = parseMonth(range.from)
  const [ty, tm] = parseMonth(range.to)
  const out: string[] = []
  for (let i = monthIndex(fy, fm); i <= monthIndex(ty, tm); i++) out.push(monthOfIndex(i))
  return out
}

/** The budget year a month falls in, for a year starting in `yearStartMonth` (1 to 12). */
export function budgetYear(month: string, yearStartMonth: number): MonthRange {
  const [y, m] = parseMonth(month)
  const start = monthIndex(m >= yearStartMonth ? y : y - 1, yearStartMonth)
  return { from: monthOfIndex(start), to: monthOfIndex(start + 11) }
}

/** The budget year up to and including `month`. */
export const yearToDate = (month: string, yearStartMonth: number): MonthRange =>
  ({ from: budgetYear(month, yearStartMonth).from, to: month })

// ---- When a plan falls due

/** The second day of a twice-a-month plan when none is given: the other half of the month (the 20th gives the 5th). */
export const defaultSecondDay = (day: number): number => day <= 15 ? day + 15 : day - 15

/**
 * The day numbers in `month` on which the plan falls due, on or after its first due date; a count instead for a plan
 * with no particular day. Ignores `from`: which plan applies to a month is `planFor`'s question.
 */
function dueDays(plan: LinePlan, month: string): number[] | number {
  const [y, m] = parseMonth(month)
  const [dy, dm] = parseMonth(plan.due)
  const hasDay = plan.due.length === 10
  const first = hasDay ? dayNumber(dy, dm, Number(plan.due.slice(8, 10))) : undefined
  if (plan.frequency === 'weekly' || plan.frequency === 'everyTwoWeeks') {
    if (first === undefined) return 0                  // refused by planProblem; nothing rather than nonsense
    const step = plan.frequency === 'weekly' ? 7 : 14
    const start = dayNumber(y, m, 1), end = dayNumber(y, m, daysInMonth(y, m))
    const low = Math.max(start, first)
    const days: number[] = []
    for (let z = first + Math.ceil((low - first) / step) * step; z <= end; z += step) days.push(z)
    return days
  }
  const since = monthIndex(y, m) - monthIndex(dy, dm)
  const clamp = (day: number) => dayNumber(y, m, Math.min(day, daysInMonth(y, m)))
  if (plan.frequency === 'twiceAMonth') {
    if (since < 0) return hasDay ? [] : 0
    if (first === undefined) return 2
    const day = Number(plan.due.slice(8, 10))
    return [clamp(day), clamp(plan.secondDay ?? defaultSecondDay(day))].filter(z => z >= first).sort((a, b) => a - b)
  }
  const falls = since >= 0 && (plan.frequency === 'once' ? since === 0 : since % MONTHS_APART[plan.frequency]! === 0)
  if (!falls) return hasDay ? [] : 0
  return first === undefined ? 1 : [clamp(Number(plan.due.slice(8, 10)))]
}

/** How many times the plan falls due in `month`. */
export function occurrences(plan: LinePlan, month: string): number {
  const days = dueDays(plan, month)
  return typeof days === 'number' ? days : days.length
}

/** The dates in `month` on which the plan falls due, 'YYYY-MM-DD', in order; none for a plan with no particular day. */
export function dueDates(plan: LinePlan, month: string): string[] {
  const days = dueDays(plan, month)
  return typeof days === 'number' ? [] : days.map(isoOf)
}

/** The plan that applies to `month`: the one with the latest `from` on or before it. Plans are in order of `from`. */
export function planFor(plans: readonly LinePlan[], month: string): LinePlan | undefined {
  let found: LinePlan | undefined
  for (const plan of plans) if (plan.from <= month) found = plan
  return found
}

/** Whether the line plans anything in `month`: a plan applies, or the month has an amount of its own. */
export const lineCovers = (line: Pick<BudgetLine, 'plans' | 'overrides'>, month: string): boolean =>
  line.overrides?.[month] !== undefined || planFor(line.plans, month) !== undefined

/** What the line plans for `month`: that month's own amount, else the plan's amount times the times it falls due. */
export function plannedAmount(line: Pick<BudgetLine, 'plans' | 'overrides'>, month: string): number {
  const own = line.overrides?.[month]
  if (own !== undefined) return own
  const plan = planFor(line.plans, month)
  return plan === undefined ? 0 : plan.amount * occurrences(plan, month)
}

// ---- Changing a line

/**
 * A line with a change applied, as `BudgetService.changeLine` applies it (the service and the Budget Line dialog's
 * preview both use this): a plan from a month replaces one from the same month, and with `replaceLater` every plan after
 * it; one month's own amount is set, or with `null` taken away so the plans apply again. Returns a new line.
 */
export function applyPlanChange<L extends Pick<BudgetLine, 'plans' | 'overrides'>>(line: L, change: PlanChange): L {
  if (change.apply === 'from') {
    const { plan } = change
    const plans = [...line.plans.filter(p => p.from !== plan.from && !(change.replaceLater && p.from > plan.from)), plan]
      .sort((a, b) => a.from < b.from ? -1 : 1)
    return { ...line, plans }
  }
  const overrides = { ...line.overrides }
  if (change.amount === null) delete overrides[change.month]
  else overrides[change.month] = change.amount
  const { overrides: _old, ...rest } = line
  return (Object.keys(overrides).length > 0 ? { ...rest, overrides } : rest) as L
}

// ---- What makes a plan valid

/** What is wrong with a plan, naming the field a form shows it on; undefined when nothing is. */
export function planProblem(plan: unknown): { field: 'from' | 'amount' | 'frequency' | 'due' | 'secondDay', message: string } | undefined {
  if (typeof plan !== 'object' || plan === null) return { field: 'amount', message: 'Enter the amount and how often.' }
  const p = plan as Partial<LinePlan>
  if (!isMonth(p.from)) return { field: 'from', message: 'Choose the month it starts from.' }
  if (typeof p.amount !== 'number' || !Number.isSafeInteger(p.amount) || p.amount < 0) {
    return { field: 'amount', message: 'Enter an amount of zero or more.' }
  }
  if (p.amount > BUDGET_AMOUNT_MAX) return { field: 'amount', message: 'That amount is too large for a budget.' }
  if (!(FREQUENCIES as readonly unknown[]).includes(p.frequency)) return { field: 'frequency', message: 'Choose how often.' }
  const frequency = p.frequency as Frequency
  if (DAY_BASED_FREQUENCIES.includes(frequency)) {
    if (!isDate(p.due)) return { field: 'due', message: 'Enter the date it is first due.' }
  } else if (!isDate(p.due) && !isMonth(p.due)) {
    return { field: 'due', message: 'Enter the date it is first due, or the month for no particular day.' }
  }
  if (p.secondDay !== undefined) {
    if (frequency !== 'twiceAMonth') return { field: 'secondDay', message: 'Only a plan due twice a month has a second day.' }
    if (!Number.isInteger(p.secondDay) || p.secondDay < 1 || p.secondDay > 31) return { field: 'secondDay', message: 'Choose a day from 1 to 31.' }
    if (isDate(p.due) && Number(p.due.slice(8, 10)) === p.secondDay) return { field: 'secondDay', message: 'Choose a second day other than the first.' }
  }
  return undefined
}
