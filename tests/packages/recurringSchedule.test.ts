// @vitest-environment node
// The schedule engine: calendar maths only, no storage and no clock. See docs/recurring-transactions-design.md,
// "Generating occurrences" — every rule listed there is a test here.
import { describe, expect, it } from 'vitest'
import {
  FREQUENCY_CHOICES, MAX_OCCURRENCES,
  addIsoDays, applyWeekendRule, countThrough, describeSchedule, firstIndexOnOrAfter, holidaySet, isBusinessDay,
  occurrenceAt, occurrencesFrom, ordinal, validateSchedule, weekdayOf,
  type MonthlyRule, type Schedule
} from '@tessera/recurring-api'

/** A schedule, with monthly-on-the-start-day as the default. */
const every = (over: Partial<Schedule> & Pick<Schedule, 'frequency'>): Schedule =>
  ({ interval: 1, startDate: '2026-01-15', ...over })

/** The dates of the first `count` occurrences. */
const dates = (schedule: Schedule, count = 5) => occurrencesFrom(schedule, { limit: count }).map(o => o.date)

describe('frequencies and intervals', () => {
  it('repeats daily, every n days', () => {
    expect(dates(every({ frequency: 'daily' }), 4)).toEqual(['2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18'])
    expect(dates(every({ frequency: 'daily', interval: 10 }), 3)).toEqual(['2026-01-15', '2026-01-25', '2026-02-04'])
  })

  it('repeats weekly on the start date\'s weekday, every n weeks', () => {
    // 2026-01-15 is a Thursday
    expect(weekdayOf('2026-01-15')).toBe(4)
    expect(dates(every({ frequency: 'weekly' }), 3)).toEqual(['2026-01-15', '2026-01-22', '2026-01-29'])
    expect(dates(every({ frequency: 'weekly', interval: 2 }), 3)).toEqual(['2026-01-15', '2026-01-29', '2026-02-12'])
    expect(dates(every({ frequency: 'weekly', interval: 4 }), 3)).toEqual(['2026-01-15', '2026-02-12', '2026-03-12'])
    for (const date of dates(every({ frequency: 'weekly', interval: 4 }), 12)) expect(weekdayOf(date)).toBe(4)
  })

  it('repeats monthly, and every n months for quarterly and twice a year', () => {
    expect(dates(every({ frequency: 'monthly' }), 3)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
    expect(dates(every({ frequency: 'monthly', interval: 2 }), 3)).toEqual(['2026-01-15', '2026-03-15', '2026-05-15'])
    expect(dates(every({ frequency: 'monthly', interval: 3 }), 3)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15'])
    expect(dates(every({ frequency: 'monthly', interval: 6 }), 3)).toEqual(['2026-01-15', '2026-07-15', '2027-01-15'])
  })

  it('repeats yearly, in the start date\'s month unless another is named', () => {
    expect(dates(every({ frequency: 'yearly' }), 3)).toEqual(['2026-01-15', '2027-01-15', '2028-01-15'])
    expect(dates(every({ frequency: 'yearly', interval: 2 }), 3)).toEqual(['2026-01-15', '2028-01-15', '2030-01-15'])
    // A month of its own: the first occurrence is the next one the rule produces, not the start date
    expect(dates(every({ frequency: 'yearly', month: 7 }), 2)).toEqual(['2026-07-15', '2027-07-15'])
  })

  it('covers every choice the dialog offers', () => {
    for (const { frequency, interval } of FREQUENCY_CHOICES) {
      const found = dates(every({ frequency, interval }), 3)
      expect(found).toHaveLength(3)
      expect([...found].sort()).toEqual(found)
    }
  })
})

describe('the month end', () => {
  const monthly = (day: MonthlyRule['kind'] extends never ? never : number | 'last', startDate = '2026-01-31') =>
    every({ frequency: 'monthly', startDate, monthlyRule: { kind: 'dayOfMonth', day } })

  it('clamps the 31st to each month\'s length, and remembers the 31st for the months that have it', () => {
    expect(dates(monthly(31), 7)).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'
    ])
  })

  it('gives 29 February in a leap year', () => {
    expect(dates(monthly(31, '2028-01-31'), 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31'])
    // 2100 is not a leap year, though it divides by 4
    expect(dates(monthly(31, '2100-01-31'), 2)).toEqual(['2100-01-31', '2100-02-28'])
  })

  it('follows the last day of each month', () => {
    expect(dates(monthly('last'), 5)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
  })

  it('never walks backwards: the index is the anchor, not the date before it', () => {
    // The bug this rules out: advancing from a clamped 28 February would give 28 March, then 28 April, for ever
    const found = dates(monthly(31), 25)
    expect(found[13]).toBe('2027-02-28')
    expect(found[24]).toBe('2028-01-31')
    // 25 months from January 2026 reach January 2028, which holds 15 months of 31 days
    expect(found.filter(d => d.endsWith('-31'))).toHaveLength(15)
  })
})

describe('the nth weekday of the month', () => {
  const nth = (week: 1 | 2 | 3 | 4 | -1, weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6) =>
    every({ frequency: 'monthly', startDate: '2026-01-01', monthlyRule: { kind: 'nthWeekday', week, weekday } })

  it('finds the second Tuesday', () => {
    const found = dates(nth(2, 2), 4)
    expect(found).toEqual(['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14'])
    for (const date of found) expect(weekdayOf(date)).toBe(2)
  })

  it('finds the first and fourth of a weekday, in every month', () => {
    expect(dates(nth(1, 5), 3)).toEqual(['2026-01-02', '2026-02-06', '2026-03-06'])
    expect(dates(nth(4, 5), 3)).toEqual(['2026-01-23', '2026-02-27', '2026-03-27'])
  })

  it('finds the last of a weekday, which is the fourth or the fifth', () => {
    const found = dates(nth(-1, 5), 4)
    expect(found).toEqual(['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24'])
    for (const date of found) expect(weekdayOf(date)).toBe(5)
    // January 2026 has five Fridays, so the last is not the fourth
    expect(found[0]).not.toBe(dates(nth(4, 5), 1)[0])
  })

  it('works when the first of the month is the weekday itself', () => {
    // 2026-05-01 is a Friday
    expect(occurrenceAt(nth(1, 5), 4)!.date).toBe('2026-05-01')
  })
})

describe('twice a month', () => {
  it('runs through both days, two to a month, defaulting to the 1st and the last day', () => {
    const schedule = every({ frequency: 'semiMonthly', startDate: '2026-01-01' })
    expect(dates(schedule, 6)).toEqual([
      '2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01', '2026-03-31'
    ])
  })

  it('takes the two days it is given, clamping each', () => {
    const schedule = every({ frequency: 'semiMonthly', startDate: '2026-01-01', semiMonthlyDays: [15, 31] })
    expect(dates(schedule, 6)).toEqual([
      '2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31'
    ])
  })

  it('ignores the interval, and counts an end after n through both days', () => {
    const schedule = every({ frequency: 'semiMonthly', startDate: '2026-01-01', interval: 5, end: { kind: 'afterCount', count: 6 } })
    // Six occurrences is three months, not six
    expect(dates(schedule, 10)).toEqual([
      '2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01', '2026-03-31'
    ])
  })

  it('can produce the same date twice in a short month, which only the index tells apart', () => {
    const schedule = every({ frequency: 'semiMonthly', startDate: '2026-02-01', semiMonthlyDays: [28, 'last'] })
    const [first, second] = occurrencesFrom(schedule, { limit: 2 })
    expect([first.date, second.date]).toEqual(['2026-02-28', '2026-02-28'])
    expect([first.index, second.index]).toEqual([0, 1])
    // The earlier of the two is the one a search finds
    expect(firstIndexOnOrAfter(schedule, '2026-02-28')).toBe(0)
  })

  it('starts at the first of its days on or after the start date', () => {
    const schedule = every({ frequency: 'semiMonthly', startDate: '2026-01-20', semiMonthlyDays: [1, 15] })
    expect(dates(schedule, 3)).toEqual(['2026-02-01', '2026-02-15', '2026-03-01'])
  })
})

describe('the weekend rule', () => {
  // 2026-08-01 is a Saturday, 2026-08-02 a Sunday
  const daily = (weekendRule: Schedule['weekendRule']) => every({ frequency: 'daily', startDate: '2026-07-31', weekendRule })

  it('moves a Saturday and a Sunday back to the Friday', () => {
    expect(applyWeekendRule('2026-08-01', 'before')).toBe('2026-07-31')
    expect(applyWeekendRule('2026-08-02', 'before')).toBe('2026-07-31')
    expect(dates(daily('before'), 4)).toEqual(['2026-07-31', '2026-07-31', '2026-07-31', '2026-08-03'])
  })

  it('moves a Saturday and a Sunday on to the Monday', () => {
    expect(applyWeekendRule('2026-08-01', 'after')).toBe('2026-08-03')
    expect(applyWeekendRule('2026-08-02', 'after')).toBe('2026-08-03')
    expect(dates(daily('after'), 4)).toEqual(['2026-07-31', '2026-08-03', '2026-08-03', '2026-08-03'])
  })

  it('leaves a weekday alone, and leaves everything alone without a rule', () => {
    expect(applyWeekendRule('2026-07-31', 'before')).toBe('2026-07-31')
    expect(applyWeekendRule('2026-08-01', 'none')).toBe('2026-08-01')
    expect(applyWeekendRule('2026-08-01', undefined)).toBe('2026-08-01')
  })

  it('reports the date it moved from, and only then', () => {
    const moved = occurrencesFrom(daily('after'), { limit: 3 })
    expect(moved[0]).toEqual({ index: 0, date: '2026-07-31' })
    expect(moved[1]).toEqual({ index: 1, date: '2026-08-03', scheduledDate: '2026-08-01' })
  })

  it('moves the date, never the sequence: a monthly series cannot drift', () => {
    // The 1st of each month, moved; the anchors stay on the 1st however often a weekend moves one
    const schedule = every({ frequency: 'monthly', startDate: '2026-08-01', weekendRule: 'after' })
    const found = occurrencesFrom(schedule, { limit: 6 })
    expect(found.map(o => o.scheduledDate ?? o.date)).toEqual([
      '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01'
    ])
    expect(found.map(o => o.date)).toEqual([
      '2026-08-03', '2026-09-01', '2026-10-01', '2026-11-02', '2026-12-01', '2027-01-01'
    ])
  })

  it('can move a date into the month before, without changing what comes next', () => {
    // 2026-11-01 is a Sunday: moved back it lands in October
    const schedule = every({ frequency: 'monthly', startDate: '2026-11-01', weekendRule: 'before' })
    const [first, second] = occurrencesFrom(schedule, { limit: 2 })
    expect(first).toEqual({ index: 0, date: '2026-10-30', scheduledDate: '2026-11-01' })
    expect(second.date).toBe('2026-12-01')
  })
})

describe('the business-day rule, with holidays', () => {
  // Friday 2026-12-25 and Monday 2026-12-28 are holidays; so is Friday 2027-01-01
  const calendar = { holidays: ['2026-12-25', '2026-12-28', '2027-01-01'] }

  it('knows what a business day is', () => {
    expect(isBusinessDay('2026-12-24')).toBe(true)                 // Thursday
    expect(isBusinessDay('2026-12-26')).toBe(false)                // Saturday
    expect(isBusinessDay('2026-12-25')).toBe(true)                 // a Friday, with no calendar
    expect(isBusinessDay('2026-12-25', calendar)).toBe(false)      // the same Friday, a holiday
    expect(holidaySet(undefined).size).toBe(0)
  })

  it('steps over a holiday as it would a weekend, and over a run of both', () => {
    // Christmas Day is a Friday: back lands on Thursday the 24th
    expect(applyWeekendRule('2026-12-25', 'before', calendar)).toBe('2026-12-24')
    // Forward from Christmas Day: Saturday, Sunday and the Monday holiday are all stepped over, to Tuesday the 29th
    expect(applyWeekendRule('2026-12-25', 'after', calendar)).toBe('2026-12-29')
    // Saturday the 26th, back: Friday is a holiday, so Thursday
    expect(applyWeekendRule('2026-12-26', 'before', calendar)).toBe('2026-12-24')
    // A business day is never moved, calendar or not
    expect(applyWeekendRule('2026-12-24', 'after', calendar)).toBe('2026-12-24')
    // Without the calendar the Friday is an ordinary day
    expect(applyWeekendRule('2026-12-25', 'after')).toBe('2026-12-25')
  })

  it('moves an occurrence that lands on a holiday, and no other', () => {
    const schedule = every({ frequency: 'monthly', startDate: '2026-11-25', weekendRule: 'after' })
    const plain = occurrencesFrom(schedule, { limit: 3 }).map(o => o.date)
    const observed = occurrencesFrom(schedule, { limit: 3, calendar }).map(o => o.date)
    expect(plain).toEqual(['2026-11-25', '2026-12-25', '2027-01-25'])
    expect(observed).toEqual(['2026-11-25', '2026-12-29', '2027-01-25'])
    expect(occurrenceAt(schedule, 1, calendar)).toEqual({ index: 1, date: '2026-12-29', scheduledDate: '2026-12-25' })
  })

  it('still never drifts: the anchors ignore the calendar', () => {
    const schedule = every({ frequency: 'monthly', startDate: '2026-11-25', weekendRule: 'after' })
    const anchors = occurrencesFrom(schedule, { limit: 4, calendar }).map(o => o.scheduledDate ?? o.date)
    expect(anchors).toEqual(['2026-11-25', '2026-12-25', '2027-01-25', '2027-02-25'])
  })

  it('counts and searches with the same calendar it generates with', () => {
    const schedule = every({ frequency: 'yearly', startDate: '2026-12-25', weekendRule: 'before' })
    // Christmas 2026 moves back to the 24th, so by the 24th one has fallen due; without the calendar none has
    expect(countThrough(schedule, 0, '2026-12-24', calendar)).toBe(1)
    expect(countThrough(schedule, 0, '2026-12-24')).toBe(0)
    expect(firstIndexOnOrAfter(schedule, '2026-12-24', calendar)).toBe(0)
    expect(occurrenceAt(schedule, firstIndexOnOrAfter(schedule, '2026-12-25', calendar)!, calendar)!.date).toBe('2027-12-24')
  })

  it('gives up rather than walking for ever through a calendar that is all holidays', () => {
    const everyDay = { holidays: Array.from({ length: 60 }, (_, i) => addIsoDays('2026-12-01', i)) }
    const moved = applyWeekendRule('2026-12-10', 'after', everyDay)
    // Fourteen steps on, and no further: a calendar like this is a mistake, not something to loop on
    expect(moved).toBe('2026-12-24')
  })
})

describe('when a series ends', () => {
  it('stops on a date, which it compares with the anchor rather than a moved date', () => {
    const schedule = every({ frequency: 'monthly', startDate: '2026-01-15', end: { kind: 'onDate', date: '2026-03-15' } })
    expect(dates(schedule, 10)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
    expect(occurrenceAt(schedule, 3)).toBeUndefined()

    // 2027-01-01 is a Friday; 2026-08-01, a Saturday, moves back into July but its anchor is still August
    const moved = every({ frequency: 'monthly', startDate: '2026-07-01', weekendRule: 'before', end: { kind: 'onDate', date: '2026-07-31' } })
    expect(dates(moved, 5)).toEqual(['2026-07-01'])
  })

  it('stops after a count, whether the occurrences were entered or skipped', () => {
    const schedule = every({ frequency: 'weekly', end: { kind: 'afterCount', count: 3 } })
    expect(dates(schedule, 10)).toEqual(['2026-01-15', '2026-01-22', '2026-01-29'])
    expect(occurrenceAt(schedule, 2)).toBeDefined()
    expect(occurrenceAt(schedule, 3)).toBeUndefined()
  })

  it('never ends without an end rule', () => {
    expect(occurrenceAt(every({ frequency: 'monthly' }), 5000)!.date).toBe('2442-09-15')
    expect(occurrencesFrom(every({ frequency: 'daily' }))).toHaveLength(MAX_OCCURRENCES)
  })
})

describe('occurrenceAt and occurrencesFrom', () => {
  const monthly = every({ frequency: 'monthly' })

  it('refuses an index that is not a whole number at or above zero', () => {
    expect(occurrenceAt(monthly, -1)).toBeUndefined()
    expect(occurrenceAt(monthly, 1.5)).toBeUndefined()
    expect(occurrenceAt(monthly, Number.NaN)).toBeUndefined()
    expect(occurrenceAt(monthly, 0)).toEqual({ index: 0, date: '2026-01-15' })
  })

  it('gives nothing for a schedule it cannot use', () => {
    expect(occurrenceAt({ ...monthly, startDate: 'the 15th' }, 0)).toBeUndefined()
    expect(occurrenceAt({ ...monthly, startDate: '2026-02-30' }, 0)).toBeUndefined()
    expect(occurrenceAt({ ...monthly, interval: 0 }, 0)).toBeUndefined()
    expect(occurrencesFrom({ ...monthly, frequency: 'fortnightly' as never })).toEqual([])
    expect(occurrenceAt(undefined as never, 0)).toBeUndefined()
  })

  it('starts where it is asked to, and keeps each occurrence\'s own index', () => {
    const found = occurrencesFrom(monthly, { fromIndex: 3, limit: 2 })
    expect(found.map(o => [o.index, o.date])).toEqual([[3, '2026-04-15'], [4, '2026-05-15']])
    expect(occurrencesFrom(monthly, { fromIndex: -5, limit: 1 })[0].index).toBe(0)
  })

  it('stops at a date, counting the date a transaction would get', () => {
    expect(occurrencesFrom(monthly, { until: '2026-03-15' }).map(o => o.date))
      .toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
    expect(occurrencesFrom(monthly, { until: '2026-03-14' })).toHaveLength(2)
    expect(occurrencesFrom(monthly, { until: 'soon' })).toEqual([])
  })

  it('never returns more than the cap, however large a limit is asked for', () => {
    expect(occurrencesFrom(every({ frequency: 'daily' }), { limit: 50_000 })).toHaveLength(MAX_OCCURRENCES)
    expect(occurrencesFrom(monthly, { limit: 0 })).toEqual([])
  })
})

describe('finding an index by date', () => {
  const monthly = every({ frequency: 'monthly' })

  it('finds the occurrence on the date, and the next one after a date between two', () => {
    expect(firstIndexOnOrAfter(monthly, '2026-01-15')).toBe(0)
    expect(firstIndexOnOrAfter(monthly, '2026-01-16')).toBe(1)
    expect(firstIndexOnOrAfter(monthly, '2026-02-14')).toBe(1)
    expect(firstIndexOnOrAfter(monthly, '2026-02-15')).toBe(1)
  })

  it('gives the first occurrence for any date at or before the start', () => {
    expect(firstIndexOnOrAfter(monthly, '2020-01-01')).toBe(0)
    expect(firstIndexOnOrAfter(monthly, '2026-01-14')).toBe(0)
  })

  it('reaches far without scanning, for a series left alone for years', () => {
    const daily = every({ frequency: 'daily', startDate: '2000-03-01' })
    expect(firstIndexOnOrAfter(daily, '2026-11-13')).toBe(9753)
    expect(occurrenceAt(daily, 9753)!.date).toBe('2026-11-13')
    const weekly = every({ frequency: 'weekly', startDate: '2001-01-04', interval: 2 })
    expect(occurrenceAt(weekly, firstIndexOnOrAfter(weekly, '2026-06-01')!)!.date).toBe('2026-06-04')
  })

  it('agrees with the generated sequence at every step, weekend rule and all', () => {
    const schedule = every({ frequency: 'monthly', startDate: '2026-01-31', monthlyRule: { kind: 'dayOfMonth', day: 31 }, weekendRule: 'before' })
    for (const occurrence of occurrencesFrom(schedule, { limit: 40 })) {
      expect(firstIndexOnOrAfter(schedule, occurrence.date)).toBeLessThanOrEqual(occurrence.index)
      expect(occurrenceAt(schedule, occurrence.index)!.date).toBe(occurrence.date)
    }
  })

  it('gives nothing once the series has ended, or for something that is not a date', () => {
    const ending = every({ frequency: 'monthly', end: { kind: 'afterCount', count: 2 } })
    expect(firstIndexOnOrAfter(ending, '2026-02-15')).toBe(1)
    expect(firstIndexOnOrAfter(ending, '2026-02-16')).toBeUndefined()
    expect(firstIndexOnOrAfter(monthly, 'tomorrow')).toBeUndefined()
  })
})

describe('counting what is due', () => {
  const monthly = every({ frequency: 'monthly' })

  it('counts the occurrences on or before a date, from an index', () => {
    expect(countThrough(monthly, 0, '2026-01-14')).toBe(0)
    expect(countThrough(monthly, 0, '2026-01-15')).toBe(1)
    expect(countThrough(monthly, 0, '2026-04-20')).toBe(4)
    // Three were entered already: one is still due
    expect(countThrough(monthly, 3, '2026-04-20')).toBe(1)
    expect(countThrough(monthly, 4, '2026-04-20')).toBe(0)
  })

  it('counts no further than the end rule', () => {
    const ending = every({ frequency: 'monthly', end: { kind: 'afterCount', count: 2 } })
    expect(countThrough(ending, 0, '2030-01-01')).toBe(2)
    expect(countThrough(ending, 1, '2030-01-01')).toBe(1)
  })

  it('caps a long-abandoned daily series rather than counting for ever', () => {
    expect(countThrough(every({ frequency: 'daily', startDate: '2000-01-01' }), 0, '2026-11-13')).toBe(MAX_OCCURRENCES)
  })
})

describe('describing a schedule', () => {
  it('uses the dialog\'s own wording where there is some', () => {
    expect(describeSchedule(every({ frequency: 'daily' }))).toBe('Daily')
    expect(describeSchedule(every({ frequency: 'daily', interval: 3 }))).toBe('Every 3 days')
    expect(describeSchedule(every({ frequency: 'weekly' }))).toBe('Weekly on Thursday')
    expect(describeSchedule(every({ frequency: 'weekly', interval: 2 }))).toBe('Every two weeks on Thursday')
    expect(describeSchedule(every({ frequency: 'weekly', interval: 3 }))).toBe('Every 3 weeks on Thursday')
    expect(describeSchedule(every({ frequency: 'monthly', interval: 3 }))).toBe('Quarterly on the 15th')
    expect(describeSchedule(every({ frequency: 'monthly', interval: 6 }))).toBe('Twice a year on the 15th')
  })

  it('names the day a monthly or yearly schedule falls on', () => {
    expect(describeSchedule(every({ frequency: 'monthly' }))).toBe('Monthly on the 15th')
    expect(describeSchedule(every({ frequency: 'monthly', startDate: '2026-01-01' }))).toBe('Monthly on the 1st')
    expect(describeSchedule(every({ frequency: 'monthly', monthlyRule: { kind: 'dayOfMonth', day: 'last' } })))
      .toBe('Monthly on the last day')
    expect(describeSchedule(every({ frequency: 'monthly', monthlyRule: { kind: 'nthWeekday', week: 2, weekday: 2 } })))
      .toBe('Monthly on the second Tuesday')
    expect(describeSchedule(every({ frequency: 'monthly', monthlyRule: { kind: 'nthWeekday', week: -1, weekday: 5 } })))
      .toBe('Monthly on the last Friday')
    expect(describeSchedule(every({ frequency: 'yearly', startDate: '2026-07-01' }))).toBe('Yearly on 1 July')
    expect(describeSchedule(every({ frequency: 'yearly', month: 3, monthlyRule: { kind: 'nthWeekday', week: 1, weekday: 1 } })))
      .toBe('Yearly on the first Monday in March')
  })

  it('names both days of a twice-a-month schedule', () => {
    expect(describeSchedule(every({ frequency: 'semiMonthly' }))).toBe('Twice a month, on the 1st and the last day')
    expect(describeSchedule(every({ frequency: 'semiMonthly', semiMonthlyDays: [2, 22] })))
      .toBe('Twice a month, on the 2nd and the 22nd')
  })

  it('mentions a weekend rule, since it changes the dates', () => {
    expect(describeSchedule(every({ frequency: 'monthly', weekendRule: 'before' })))
      .toBe('Monthly on the 15th (moved to the business day before)')
    expect(describeSchedule(every({ frequency: 'monthly', weekendRule: 'after' })))
      .toBe('Monthly on the 15th (moved to the next business day)')
    expect(describeSchedule(every({ frequency: 'monthly', weekendRule: 'none' }))).toBe('Monthly on the 15th')
  })

  it('says nothing about a schedule it cannot read', () => {
    expect(describeSchedule({ ...every({ frequency: 'monthly' }), startDate: 'soon' })).toBe('')
  })

  it('writes ordinals the way English does', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '30th', '31st'])
  })
})

describe('validating a schedule', () => {
  const monthly = every({ frequency: 'monthly' })
  const why = (over: Partial<Schedule>) => validateSchedule({ ...monthly, ...over })

  it('accepts every schedule the engine generates from', () => {
    for (const { frequency, interval } of FREQUENCY_CHOICES) expect(validateSchedule(every({ frequency, interval }))).toBeUndefined()
    expect(why({ monthlyRule: { kind: 'nthWeekday', week: -1, weekday: 0 } })).toBeUndefined()
    expect(why({ weekendRule: 'before', end: { kind: 'onDate', date: '2027-01-01' } })).toBeUndefined()
    expect(why({ end: { kind: 'afterCount', count: 1 } })).toBeUndefined()
  })

  it('wants a frequency, a whole interval of at least one, and a start date', () => {
    expect(validateSchedule(undefined as never)).toMatch(/how often/)
    expect(why({ frequency: 'fortnightly' as never })).toMatch(/how often/)
    expect(why({ interval: 0 })).toMatch(/1 or more/)
    expect(why({ interval: 1.5 })).toMatch(/whole number/)
    expect(why({ interval: 1000 })).toMatch(/999 or fewer/)
    expect(why({ startDate: '15 January' })).toBe('Enter the date it starts.')
    expect(why({ startDate: '2026-02-30' })).toBe('Enter the date it starts.')
  })

  it('checks a day of the month, and refuses one where it means nothing', () => {
    expect(why({ monthlyRule: { kind: 'dayOfMonth', day: 0 } })).toMatch(/1 to 31/)
    expect(why({ monthlyRule: { kind: 'dayOfMonth', day: 32 } })).toMatch(/1 to 31/)
    expect(why({ monthlyRule: { kind: 'nthWeekday', week: 5 as never, weekday: 1 } })).toMatch(/first, second/)
    expect(why({ monthlyRule: { kind: 'nthWeekday', week: 1, weekday: 7 as never } })).toMatch(/day of the week/)
    expect(why({ monthlyRule: { kind: 'whenever' } as never })).toMatch(/which day of the month/)
    expect(validateSchedule(every({ frequency: 'weekly', monthlyRule: { kind: 'dayOfMonth', day: 1 } })))
      .toMatch(/monthly and yearly schedules only/)
  })

  it('checks the two days of a twice-a-month schedule', () => {
    const semi = (semiMonthlyDays: Schedule['semiMonthlyDays']) => validateSchedule(every({ frequency: 'semiMonthly', semiMonthlyDays }))
    expect(semi([1, 15])).toBeUndefined()
    expect(semi([15, 'last'])).toBeUndefined()
    expect(semi([15, 1])).toMatch(/earlier one first/)
    expect(semi([15, 15])).toMatch(/two different days/)
    expect(semi(['last', 15])).toMatch(/earlier one first/)
    expect(semi([1] as never)).toMatch(/two days/)
    expect(semi([1, 40] as never)).toMatch(/two days/)
    expect(why({ semiMonthlyDays: [1, 15] })).toMatch(/twice-a-month schedule only/)
  })

  it('checks a month, and refuses one where it means nothing', () => {
    expect(validateSchedule(every({ frequency: 'yearly', month: 13 }))).toMatch(/1 to 12/)
    expect(validateSchedule(every({ frequency: 'yearly', month: 0 }))).toMatch(/1 to 12/)
    expect(why({ month: 7 })).toMatch(/yearly schedule only/)
  })

  it('checks the weekend rule and the end rule', () => {
    expect(why({ weekendRule: 'skip' as never })).toMatch(/at a weekend/)
    expect(why({ end: { kind: 'whenever' } as never })).toBe('Choose when it ends.')
    expect(why({ end: { kind: 'onDate', date: 'never' } })).toBe('Enter the date it ends.')
    expect(why({ end: { kind: 'onDate', date: '2025-12-31' } })).toBe('It can’t end before it starts.')
    expect(why({ end: { kind: 'afterCount', count: 0 } })).toMatch(/1 or more/)
    expect(why({ end: { kind: 'afterCount', count: 2.5 } })).toMatch(/1 or more/)
  })

  it('refuses a well-formed schedule that would never happen', () => {
    // Monthly on the 15th, starting the 20th: the first occurrence is next month, after it has ended
    expect(why({ startDate: '2026-01-20', monthlyRule: { kind: 'dayOfMonth', day: 15 }, end: { kind: 'onDate', date: '2026-01-31' } }))
      .toBe('This never happens. Change when it starts, or when it ends.')
  })
})

/**
 * The sequences above were written alongside the engine, so these were computed independently (Python's `calendar`)
 * and pasted in whole. They are the cases where an off-by-one hides easily: month-end clamping over two years, the
 * nth weekday, the last weekday in a month with five of them, twice a month, and a yearly series anchored on a
 * leap day.
 */
describe('cross-checked against an independent implementation', () => {
  const run = (schedule: Schedule, count: number) => occurrencesFrom(schedule, { limit: count }).map(o => o.date)

  it('clamps the 31st the same way for two years', () => {
    expect(run(every({ frequency: 'monthly', startDate: '2026-01-31' }), 24)).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31',
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30',
      '2027-07-31', '2027-08-31', '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31'
    ])
  })

  it('finds the second Tuesday of twelve months', () => {
    expect(run(every({ frequency: 'monthly', startDate: '2026-01-01', monthlyRule: { kind: 'nthWeekday', week: 2, weekday: 2 } }), 12)).toEqual([
      '2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09',
      '2026-07-14', '2026-08-11', '2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08'
    ])
  })

  it('finds the last Friday of twelve months, five-Friday months included', () => {
    expect(run(every({ frequency: 'monthly', startDate: '2026-01-01', monthlyRule: { kind: 'nthWeekday', week: -1, weekday: 5 } }), 12)).toEqual([
      '2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26',
      '2026-07-31', '2026-08-28', '2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25'
    ])
  })

  it('runs twice a month for half a year', () => {
    expect(run(every({ frequency: 'semiMonthly', startDate: '2026-01-01' }), 12)).toEqual([
      '2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01', '2026-03-31',
      '2026-04-01', '2026-04-30', '2026-05-01', '2026-05-31', '2026-06-01', '2026-06-30'
    ])
  })

  it('keeps a yearly series anchored on 29 February, clamping the years that lack one', () => {
    expect(run(every({ frequency: 'yearly', startDate: '2028-02-29' }), 8)).toEqual([
      '2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28',
      '2032-02-29', '2033-02-28', '2034-02-28', '2035-02-28'
    ])
  })
})

describe('the date helpers the engine publishes', () => {
  it('adds and subtracts days across months, years and a leap day', () => {
    expect(addIsoDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addIsoDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addIsoDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addIsoDays('2026-11-13', 0)).toBe('2026-11-13')
  })

  it('knows the weekday, Sunday first', () => {
    expect(['2026-11-15', '2026-11-16', '2026-11-20', '2026-11-21'].map(weekdayOf)).toEqual([0, 1, 5, 6])
  })
})
