// @vitest-environment node
// @tessera/budget-api's planning arithmetic, against a walk of the calendar: the budget spike's check, kept
// (docs/budget-design.md, Phase B0 results, "The date arithmetic"). The oracle steps through every day with Date.UTC,
// which no time zone touches, and applies each frequency's definition day by day. The suite walks 2000 to 2040; set
// TESSERA_FULL_CALENDAR=1 to walk 1970 to 2100, as the spike did (about 20 s).
// Run by the `timezone` project, with TZ=Australia/Lord_Howe (half-hour daylight saving), where any date worked out
// through a local Date would slip a day.
import { describe, expect, it } from 'vitest'
import {
  BUDGET_AMOUNT_MAX, FREQUENCIES, addMonths, applyPlanChange, budgetYear, civil, dayNumber, daysInMonth, defaultSecondDay, dueDates, firstDayOf,
  isDate, isMonth, lastDayOf, lineCovers, monthsOf, occurrences, planFor, planProblem, plannedAmount, yearToDate,
  type Frequency, type LinePlan
} from '@tessera/budget-api'

const FULL = process.env.TESSERA_FULL_CALENDAR === '1'
const FROM_YEAR = FULL ? 1970 : 2000, TO_YEAR = FULL ? 2100 : 2040

// ---- The oracle's calendar: every day, from Date.UTC, independent of dayNumber and civil
const DAY = 86_400_000, T0 = Date.UTC(FROM_YEAR, 0, 1)
interface Day { index: number, y: number, m: number, d: number, iso: string, dim: number }
const days: Day[] = []
for (let t = T0, i = 0; t <= Date.UTC(TO_YEAR, 11, 31); t += DAY, i++) {
  const date = new Date(t)
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate()
  days.push({ index: i, y, m, d, iso: date.toISOString().slice(0, 10), dim: new Date(Date.UTC(y, m, 0)).getUTCDate() })
}
const indexOf = (iso: string) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - T0) / DAY)
const key = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`
const MONTHS = monthsOf({ from: `${FROM_YEAR}-01`, to: `${TO_YEAR}-12` })
const APART: Record<string, number> = { monthly: 1, everyTwoMonths: 2, quarterly: 3, twiceAYear: 6, yearly: 12 }

/** What a plan's definition says, day by day: month → the dates it falls due ('-' for each time with no particular day). */
function oracle(plan: LinePlan, within: [number, number] = [0, days.length - 1]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (month: string, value: string) => (out.get(month) ?? out.set(month, []).get(month)!).push(value)
  const hasDay = plan.due.length === 10
  const y0 = +plan.due.slice(0, 4), m0 = +plan.due.slice(5, 7)
  const first = hasDay ? indexOf(plan.due) : -Infinity
  for (let i = within[0]; i <= within[1]; i++) {
    const D = days[i]
    const since = (D.y - y0) * 12 + (D.m - m0)
    const month = key(D.y, D.m)
    switch (plan.frequency) {
      case 'weekly': case 'everyTwoWeeks':
        if (D.index >= first && (D.index - first) % (plan.frequency === 'weekly' ? 7 : 14) === 0) add(month, D.iso)
        break
      case 'twiceAMonth': {
        if (since < 0) break
        if (!hasDay) { if (D.d === 1) { add(month, '-'); add(month, '-') } break }
        const dueDay = +plan.due.slice(8, 10)
        for (const target of [dueDay, plan.secondDay ?? (dueDay <= 15 ? dueDay + 15 : dueDay - 15)]) {
          if (D.d === Math.min(target, D.dim) && D.index >= first) add(month, D.iso)
        }
        break
      }
      default: {
        const falls = since >= 0 && (plan.frequency === 'once' ? since === 0 : since % APART[plan.frequency] === 0)
        if (!falls) break
        if (!hasDay) { if (D.d === 1) add(month, '-'); break }
        if (D.d === Math.min(+plan.due.slice(8, 10), D.dim) && D.index >= first) add(month, D.iso)
      }
    }
  }
  return out
}

/** Every month of the walk where the plan disagrees with the calendar. */
function disagreements(plan: LinePlan): string[] {
  const truth = oracle(plan)
  const wrong: string[] = []
  for (const month of MONTHS) {
    const want = truth.get(month) ?? []
    if (occurrences(plan, month) !== want.length) wrong.push(`${month}: ${occurrences(plan, month)} times, the calendar says ${want.length}`)
    const dates = want.filter(d => d !== '-').sort()
    if (JSON.stringify(dueDates(plan, month)) !== JSON.stringify(dates)) wrong.push(`${month}: ${dueDates(plan, month)} against ${dates}`)
  }
  return wrong
}

const plan = (frequency: Frequency, due: string, over: Partial<LinePlan> = {}): LinePlan => ({ from: '1970-01', amount: 1, frequency, due, ...over })

describe('the time zone the arithmetic is tested in', () => {
  it('is one with half-hour daylight saving, so a date worked out through a local Date would slip', () => {
    // Lord Howe Island is UTC+10:30 in winter and UTC+11 in summer
    expect(new Date(2024, 6, 15).getTimezoneOffset()).toBe(-630)
    expect(new Date(2024, 0, 15).getTimezoneOffset()).toBe(-660)
  })
})

describe('days and months', () => {
  it('number every day exactly as the calendar does, both ways', () => {
    for (const D of days) {
      expect(dayNumber(D.y, D.m, D.d), D.iso).toBe(D.index + dayNumber(FROM_YEAR, 1, 1))
      expect(civil(D.index + dayNumber(FROM_YEAR, 1, 1)), D.iso).toEqual([D.y, D.m, D.d])
    }
    expect(dayNumber(1970, 1, 1)).toBe(0)
  })

  it('know months and dates as written, and how long each month is', () => {
    expect([isMonth('2027-03'), isMonth('2027-13'), isMonth('2027-3'), isMonth('0999-01'), isMonth(202703)]).toEqual([true, false, false, false, false])
    expect([isDate('2028-02-29'), isDate('2027-02-29'), isDate('2100-02-29'), isDate('2000-02-29'), isDate('2027-04-31')]).toEqual([true, false, false, true, false])
    for (const D of days.filter(x => x.d === 1)) expect(daysInMonth(D.y, D.m), D.iso).toBe(D.dim)
    expect([firstDayOf('2028-02'), lastDayOf('2028-02'), lastDayOf('2027-12')]).toEqual(['2028-02-01', '2028-02-29', '2027-12-31'])
    expect([addMonths('2027-01', -1), addMonths('2027-12', 1), addMonths('2027-06', 18), addMonths('2027-06', -30)]).toEqual(['2026-12', '2028-01', '2028-12', '2024-12'])
  })
})

describe('when a plan falls due', () => {
  it('weekly and fortnightly: on the first due date and every 7 or 14 days after, from every weekday', () => {
    const firsts = [...days.filter(D => D.iso >= '2026-12-20' && D.iso <= '2027-01-16').map(D => D.iso), `${FROM_YEAR}-01-01`, '2000-02-29', '2028-02-29', `${TO_YEAR}-12-31`]
    for (const frequency of ['weekly', 'everyTwoWeeks'] as const) for (const due of firsts) expect(disagreements(plan(frequency, due)), `${frequency} from ${due}`).toEqual([])
  })

  it('the month-based ones: due on every day of a 31-, 30- and 28-day month and of a leap February, or no particular day', () => {
    const dues: string[] = []
    for (const [y, m, n] of [[2027, 1, 31], [2027, 4, 30], [2027, 2, 28], [2024, 2, 29]]) for (let d = 1; d <= n; d++) dues.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    dues.push(...Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`))
    for (const frequency of ['once', 'monthly', 'everyTwoMonths', 'quarterly', 'twiceAYear', 'yearly'] as const) {
      for (const due of dues) expect(disagreements(plan(frequency, due)), `${frequency} due ${due}`).toEqual([])
    }
  })

  it('twice a month: every due day, the other half of the month by default, and every second day given', () => {
    for (let d = 1; d <= 31; d++) {
      const due = `2027-01-${String(d).padStart(2, '0')}`
      expect(disagreements(plan('twiceAMonth', due)), due).toEqual([])
      for (const secondDay of [1, 10, 15, 28, 29, 30, 31].filter(s => s !== d)) expect(disagreements(plan('twiceAMonth', due, { secondDay })), `${due} and ${secondDay}`).toEqual([])
    }
    expect(disagreements(plan('twiceAMonth', '2027-01'))).toEqual([])
  })

  it('never puts twice a month\'s two days on one day, by default (the spike found "15 days after" did, in 5 % of months)', () => {
    for (let d = 1; d <= 31; d++) {
      expect(defaultSecondDay(d)).toBe(d <= 15 ? d + 15 : d - 15)
      for (const month of monthsOf({ from: '2027-01', to: '2030-12' })) {
        const [a, b] = dueDates(plan('twiceAMonth', `1970-01-${String(d).padStart(2, '0')}`), month)
        expect(a, `${d} in ${month}`).not.toBe(b)
      }
    }
  })

  it('counts only the dates on or after the first due date: twice a month from the 20th falls once in its first month', () => {
    expect(dueDates(plan('twiceAMonth', '2027-03-20'), '2027-03')).toEqual(['2027-03-20'])
    expect(dueDates(plan('twiceAMonth', '2027-03-20'), '2027-04')).toEqual(['2027-04-05', '2027-04-20'])
    expect(occurrences(plan('monthly', '2027-03-20'), '2027-02')).toBe(0)
  })
})

describe('how much a month is planned', () => {
  it('is the design\'s worked example of 2027, month by month', () => {
    const year = monthsOf({ from: '2027-01', to: '2027-12' })
    const dollars = (line: Parameters<typeof plannedAmount>[0]) => year.map(m => plannedAmount(line, m) / 100)
    const p = (over: Partial<LinePlan> & Pick<LinePlan, 'amount' | 'frequency' | 'due'>): LinePlan => ({ from: '2027-01', ...over })
    expect(dollars({ plans: [p({ amount: 210000, frequency: 'everyTwoWeeks', due: '2027-01-08' })] })).toEqual([4200, 4200, 4200, 6300, 4200, 4200, 4200, 4200, 4200, 6300, 4200, 4200])
    expect(dollars({ plans: [p({ amount: 300000, frequency: 'monthly', due: '2027-01-25' })] })).toEqual(Array(12).fill(3000))
    expect(dollars({ plans: [p({ amount: 3500, frequency: 'weekly', due: '2027-01-04' })] })).toEqual([140, 140, 175, 140, 175, 140, 140, 175, 140, 140, 175, 140])
    expect(dollars({ plans: [p({ amount: 90000, frequency: 'quarterly', due: '2027-02-01' })] })).toEqual([0, 900, 0, 0, 900, 0, 0, 900, 0, 0, 900, 0])
    expect(dollars({ plans: [p({ amount: 120000, frequency: 'yearly', due: '2027-03-15' })] })).toEqual([0, 0, 1200, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const groceries = { plans: [p({ amount: 65000, frequency: 'monthly', due: '2027-01' }), p({ from: '2027-07', amount: 70000, frequency: 'monthly', due: '2027-07' })], overrides: { '2027-12': 90000 } }
    expect(dollars(groceries)).toEqual([650, 650, 650, 650, 650, 650, 700, 700, 700, 700, 700, 900])
    expect(dueDates(p({ amount: 1, frequency: 'everyTwoWeeks', due: '2027-01-08' }), '2027-04')).toEqual(['2027-04-02', '2027-04-16', '2027-04-30'])
  })

  it('follows the plan from the latest month on or before, a month\'s own amount, and nothing before the first plan (random lines)', () => {
    let seed = 42
    const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const window = monthsOf({ from: '2020-01', to: '2035-12' })
    const within: [number, number] = [indexOf('2020-01-01'), indexOf('2035-12-31')]
    for (let l = 0; l < 600; l++) {
      const froms = [...new Set(Array.from({ length: 1 + Math.floor(r() * 4) }, () => window[Math.floor(r() * window.length)]))].sort()
      const plans: LinePlan[] = froms.map(from => {
        const frequency = FREQUENCIES[Math.floor(r() * FREQUENCIES.length)]
        const around = days[indexOf(`${from}-01`) + Math.floor(r() * 400) - 200]
        const withDay = frequency === 'weekly' || frequency === 'everyTwoWeeks' || r() < 0.7
        return { from, amount: 1 + Math.floor(r() * 500000), frequency, due: withDay ? around.iso : around.iso.slice(0, 7), ...(frequency === 'twiceAMonth' && r() < 0.5 && { secondDay: 1 + Math.floor(r() * 31) }) }
      })
      const overrides: Record<string, number> = {}
      for (let k = Math.floor(r() * 4); k > 0; k--) overrides[window[Math.floor(r() * window.length)]] = Math.floor(r() * 100000)
      const truths = plans.map(p => oracle(p, within))
      for (const month of window) {
        const i = plans.map(p => p.from <= month).lastIndexOf(true)
        const want = overrides[month] ?? (i < 0 ? 0 : plans[i].amount * (truths[i].get(month)?.length ?? 0))
        expect(plannedAmount({ plans, overrides }, month), `line ${l}, ${month}`).toBe(want)
        expect(lineCovers({ plans, overrides }, month), `line ${l}, ${month}`).toBe(overrides[month] !== undefined || i >= 0)
        expect(planFor(plans, month), `line ${l}, ${month}`).toBe(i < 0 ? undefined : plans[i])
      }
    }
  })

  it('adds up a year as its months, the budget year and the year to date for every start month', () => {
    for (const month of MONTHS) for (let start = 1; start <= 12; start++) {
      const year = budgetYear(month, start)
      const months = monthsOf(year)
      expect(months, `${month}, starting ${start}`).toHaveLength(12)
      expect(+year.from.slice(5), `${month}, starting ${start}`).toBe(start)
      expect(year.from <= month && month <= year.to, `${month}, starting ${start}`).toBe(true)
      expect(yearToDate(month, start)).toEqual({ from: year.from, to: month })
    }
    expect(budgetYear('2027-03', 4)).toEqual({ from: '2026-04', to: '2027-03' })
    expect(monthsOf({ from: '2027-03', to: '2027-02' })).toEqual([])
  })
})

describe('what makes a plan valid', () => {
  const good: LinePlan = { from: '2027-01', amount: 65000, frequency: 'monthly', due: '2027-01' }
  it('takes a month to start from, a whole amount of zero or more up to the limit, a frequency and a due date or month', () => {
    expect(planProblem(good)).toBeUndefined()
    expect(planProblem({ ...good, amount: 0 })).toBeUndefined()
    expect(planProblem({ ...good, amount: BUDGET_AMOUNT_MAX })).toBeUndefined()
    expect(planProblem({ ...good, frequency: 'twiceAMonth', due: '2027-01-20', secondDay: 5 })).toBeUndefined()
    const field = (p: unknown) => planProblem(p)?.field
    expect(field(undefined)).toBe('amount')
    expect(field({ ...good, from: '2027-1' })).toBe('from')
    expect([field({ ...good, amount: -1 }), field({ ...good, amount: 1.5 }), field({ ...good, amount: BUDGET_AMOUNT_MAX + 1 }), field({ ...good, amount: '5' })]).toEqual(['amount', 'amount', 'amount', 'amount'])
    expect(field({ ...good, frequency: 'daily' })).toBe('frequency')
    expect([field({ ...good, due: '2027-02-30' }), field({ ...good, due: 'soon' })]).toEqual(['due', 'due'])
  })

  it('needs a day for weekly and fortnightly plans, and a second day only twice a month, not the first day again', () => {
    expect(planProblem({ ...good, frequency: 'weekly', due: '2027-01' })).toMatchObject({ field: 'due', message: 'Enter the date it is first due.' })
    expect(planProblem({ ...good, frequency: 'weekly', due: '2027-01-04' })).toBeUndefined()
    expect(planProblem({ ...good, secondDay: 15 })).toMatchObject({ field: 'secondDay' })
    expect(planProblem({ ...good, frequency: 'twiceAMonth', due: '2027-01-20', secondDay: 20 })).toMatchObject({ field: 'secondDay' })
    expect(planProblem({ ...good, frequency: 'twiceAMonth', due: '2027-01-20', secondDay: 32 })).toMatchObject({ field: 'secondDay' })
  })
})

describe('changing a line (applyPlanChange, shared by the service and the dialogs)', () => {
  const plan = (from: string, amount: number): LinePlan => ({ from, amount, frequency: 'monthly', due: from })
  const line = { plans: [plan('2027-01', 100), plan('2027-06', 300)], overrides: { '2027-03': 5 } }

  it('adds a plan from a month, in order, replacing one from the same month; later plans stay unless asked to go', () => {
    expect(applyPlanChange(line, { apply: 'from', plan: plan('2027-04', 200) }).plans.map(p => [p.from, p.amount]))
      .toEqual([['2027-01', 100], ['2027-04', 200], ['2027-06', 300]])
    expect(applyPlanChange(line, { apply: 'from', plan: plan('2027-01', 150) }).plans.map(p => [p.from, p.amount]))
      .toEqual([['2027-01', 150], ['2027-06', 300]])
    expect(applyPlanChange(line, { apply: 'from', plan: plan('2027-04', 200), replaceLater: true }).plans.map(p => p.from))
      .toEqual(['2027-01', '2027-04'])
  })

  it('sets a month\'s own amount, and takes it away, leaving no empty overrides behind', () => {
    expect(applyPlanChange(line, { apply: 'only', month: '2027-04', amount: 0 }).overrides).toEqual({ '2027-03': 5, '2027-04': 0 })
    expect(applyPlanChange(line, { apply: 'only', month: '2027-03', amount: null })).not.toHaveProperty('overrides')
  })

  it('never changes the line it is given', () => {
    const before = structuredClone(line)
    applyPlanChange(line, { apply: 'from', plan: plan('2027-02', 1), replaceLater: true })
    applyPlanChange(line, { apply: 'only', month: '2027-03', amount: null })
    expect(line).toEqual(before)
  })
})

