// @tessera/reports-api's pure code: periods on any year start (every preset on every day of several years, in a time
// zone with half-hour daylight saving, where a date worked out through a local Date slips a day), the labels, the
// checks on sources, definitions, specs and parameters (each problem with its path), options as merge patches, and
// the engine on plain rows. See docs/reporting-design.md, "Periods", "Report definitions" and "The engine".
import { describe, expect, it } from 'vitest'
import {
  REPORT_CELLS_MAX, REPORT_SPEC_VERSION, ReportsError, TOP_OPTION, addDays, applyOptions, applyTop, averageOf, columnLabel, comparedPeriod, dateColumns,
  datesLabel, dayOf, definitionProblems, groupProblem, isDate, mergePatch, migrateSpec, optionValues, parameterProblems,
  periodLabel, quarterOf, ratio, resolveAsOf, resolvePeriod, shape, sourceProblem, specProblems, timeColumns, yearLabel, yearOf,
  type DateRange, type PeriodPreset, type ReportDefinitionContribution, type ReportSourceContribution, type ReportSpec,
  type ShapeInput, type SourceResult, type SourceRow
} from '@tessera/reports-api'

const CALENDAR = { month: 1, day: 1 }
const UK_TAX = { month: 4, day: 6 }
const JULY = { month: 7, day: 1 }
const LATE_FEBRUARY = { month: 2, day: 28 }

/**
 * A label as these tests compare it: the spaces Intl uses (thin, no-break) as plain ones, and none around a range's
 * dash. How a range is punctuated is the locale data's (ICU and CLDR, which differ between Node and Electron
 * versions: "10–31 Mar 2026" in one, "10 – 31 Mar 2026" in another), not this code's.
 */
const plain = (label: string) => label.replace(/[\u2009\u202f\u00a0]/g, ' ').replace(/\s*–\s*/g, '–')

/** Every date from `from` to `to`. */
const days = (from: string, to: string) => Array.from({ length: dayOf(to) - dayOf(from) + 1 }, (_, i) => addDays(from, i))
const length = (r: DateRange) => dayOf(r.to) - dayOf(r.from) + 1

describe('periods', () => {
  it('resolves each preset from today and a calendar year', () => {
    const on = (preset: PeriodPreset, today = '2026-11-16') => resolvePeriod({ preset }, today, CALENDAR)
    expect(on('thisMonth')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(on('lastMonth')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(on('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(on('thisQuarter')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(on('lastQuarter')).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(on('thisYear')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(on('lastYear')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(on('yearToDate')).toEqual({ from: '2026-01-01', to: '2026-11-16' })
    expect(on('last3Months')).toEqual({ from: '2026-09-01', to: '2026-11-30' })
    expect(on('last12Months')).toEqual({ from: '2025-12-01', to: '2026-11-30' })
    expect(resolvePeriod({ preset: 'allDates' }, '2026-11-16', CALENDAR, { from: '2019-03-01', to: '2026-12-20' })).toEqual({ from: '2019-03-01', to: '2026-12-20' })
    expect(() => resolvePeriod({ preset: 'allDates' }, '2026-11-16', CALENDAR)).toThrow()
    expect(resolvePeriod({ from: '2026-03-10', to: '2026-04-15' }, '2026-11-16', CALENDAR)).toEqual({ from: '2026-03-10', to: '2026-04-15' })
  })

  it('follows the ledger\'s year start to its very day: a UK tax year, a year from July, one from 28 February', () => {
    expect(resolvePeriod({ preset: 'thisYear' }, '2026-11-16', UK_TAX)).toEqual({ from: '2026-04-06', to: '2027-04-05' })
    expect(resolvePeriod({ preset: 'thisYear' }, '2026-04-05', UK_TAX)).toEqual({ from: '2025-04-06', to: '2026-04-05' })
    expect(resolvePeriod({ preset: 'lastYear' }, '2026-04-06', UK_TAX)).toEqual({ from: '2025-04-06', to: '2026-04-05' })
    expect(resolvePeriod({ preset: 'yearToDate' }, '2026-11-16', UK_TAX)).toEqual({ from: '2026-04-06', to: '2026-11-16' })
    expect(resolvePeriod({ preset: 'thisQuarter' }, '2026-11-16', UK_TAX)).toEqual({ from: '2026-10-06', to: '2027-01-05' })
    expect(resolvePeriod({ preset: 'lastQuarter' }, '2026-11-16', UK_TAX)).toEqual({ from: '2026-07-06', to: '2026-10-05' })
    expect(resolvePeriod({ preset: 'thisYear' }, '2026-06-30', JULY)).toEqual({ from: '2025-07-01', to: '2026-06-30' })
    // A year from 28 February runs to 27 February, and takes in 29 February of a leap year
    expect(resolvePeriod({ preset: 'thisYear' }, '2024-02-29', LATE_FEBRUARY)).toEqual({ from: '2024-02-28', to: '2025-02-27' })
    expect(length(resolvePeriod({ preset: 'thisYear' }, '2024-03-01', LATE_FEBRUARY))).toBe(366)
  })

  it('holds every preset to its rules on every day of 2023 and 2024 (a leap year), for every year start', () => {
    const starts = [...Array.from({ length: 12 }, (_, i) => ({ month: i + 1, day: 1 })), UK_TAX, LATE_FEBRUARY, { month: 12, day: 31 }, { month: 1, day: 31 }]
    // Checked without an expect for each, which would make this the slowest test by far: what breaks a rule is listed
    const wrong: string[] = []
    for (const start of starts) {
      for (const today of days('2023-01-01', '2024-12-31')) {
        const p = (preset: PeriodPreset) => resolvePeriod({ preset }, today, start)
        const year = p('thisYear'), last = p('lastYear'), quarter = p('thisQuarter'), lastQuarter = p('lastQuarter'), month = p('thisMonth')
        const check = (rule: string, holds: boolean) => { if (!holds) wrong.push(`${today}, year from ${start.day}/${start.month}: ${rule}`) }
        check('this year holds today', year.from <= today && today <= year.to)
        check('a year is 365 or 366 days', length(year) === 365 || length(year) === 366)
        check('last year ends the day before this one', addDays(last.to, 1) === year.from)
        check('this quarter holds today', quarter.from <= today && today <= quarter.to)
        check('last quarter ends the day before this one', addDays(lastQuarter.to, 1) === quarter.from)
        check('a quarter is 89 to 92 days', length(quarter) >= 89 && length(quarter) <= 92)
        const quarters = [yearOf(today, start).from]
        for (let k = 0; k < 4; k++) quarters.push(addDays(quarterOf(quarters[k], start).to, 1))
        check('four quarters tile the year', quarters[4] === addDays(year.to, 1))
        const ytd = p('yearToDate')
        check('year to date runs from the year start to today', ytd.from === year.from && ytd.to === today)
        check('this month holds today, from the 1st', month.from <= today && today <= month.to && month.from.endsWith('-01'))
        check('last month ends the day before this one', addDays(p('lastMonth').to, 1) === month.from)
        check('the last 12 months end with this one, twelve of them', p('last12Months').to === month.to && timeColumns(p('last12Months'), 'month', start).length === 12)
        check('the last 3 months are three', timeColumns(p('last3Months'), 'month', start).length === 3)
        check('every date is a date', [year, last, quarter, lastQuarter, month].every(r => isDate(r.from) && isDate(r.to)))
      }
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })

  it('compares with the period before, of the same length, or the same dates a year earlier', () => {
    expect(comparedPeriod({ from: '2026-01-01', to: '2026-12-31' }, 'previousPeriod')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(comparedPeriod({ from: '2025-01-01', to: '2025-12-31' }, 'previousPeriod')).toEqual({ from: '2024-01-01', to: '2024-12-31' })
    expect(comparedPeriod({ from: '2026-03-01', to: '2026-03-31' }, 'previousPeriod')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(comparedPeriod({ from: '2024-04-06', to: '2025-04-05' }, 'previousPeriod')).toEqual({ from: '2023-04-06', to: '2024-04-05' })
    // 37 days before 37 days
    expect(comparedPeriod({ from: '2026-03-10', to: '2026-04-15' }, 'previousPeriod')).toEqual({ from: '2026-02-01', to: '2026-03-09' })
    expect(comparedPeriod({ from: '2026-03-10', to: '2026-04-15' }, 'previousYear')).toEqual({ from: '2025-03-10', to: '2025-04-15' })
    expect(comparedPeriod({ from: '2024-02-29', to: '2024-02-29' }, 'previousYear')).toEqual({ from: '2023-02-28', to: '2023-02-28' })
    expect(comparedPeriod({ from: '2024-01-01', to: '2024-02-29' }, 'previousYear')).toEqual({ from: '2023-01-01', to: '2023-02-28' })
  })

  it('makes a time axis of months, quarters or years by the year start, each present, partial ones marked', () => {
    const months = timeColumns({ from: '2026-03-10', to: '2026-06-15' }, 'month', CALENDAR)
    expect(months.map(c => [c.key, c.from, c.to, c.partial])).toEqual([
      ['2026-03', '2026-03-10', '2026-03-31', true], ['2026-04', '2026-04-01', '2026-04-30', false],
      ['2026-05', '2026-05-01', '2026-05-31', false], ['2026-06', '2026-06-01', '2026-06-15', true]
    ])
    expect(timeColumns({ from: '2026-01-01', to: '2026-12-31' }, 'quarter', CALENDAR).map(c => [c.key, c.keys])).toEqual([
      ['2026-01', ['2026-01', '2026-02', '2026-03']], ['2026-04', ['2026-04', '2026-05', '2026-06']],
      ['2026-07', ['2026-07', '2026-08', '2026-09']], ['2026-10', ['2026-10', '2026-11', '2026-12']]
    ])
    // A year from 6 April: whole months from the 1st, so the year's first and last days fall in partial columns
    expect(timeColumns({ from: '2026-04-06', to: '2027-04-05' }, 'quarter', UK_TAX).map(c => [c.key, c.from, c.to, c.partial])).toEqual([
      ['2026-04', '2026-04-06', '2026-06-30', true], ['2026-07', '2026-07-01', '2026-09-30', false],
      ['2026-10', '2026-10-01', '2026-12-31', false], ['2027-01', '2027-01-01', '2027-03-31', false],
      ['2027-04', '2027-04-01', '2027-04-05', true]
    ])
    expect(timeColumns({ from: '2024-07-01', to: '2026-06-30' }, 'year', JULY).map(c => c.key)).toEqual(['2024-07', '2025-07'])
    expect(dateColumns(['2026-02-28', '2026-01-31', '2026-01-31']).map(c => c.key)).toEqual(['2026-01-31', '2026-02-28'])
  })

  it('gives the dates of a balances report: one, or month, quarter and year ends, never past today', () => {
    expect(resolveAsOf({ at: 'today' }, 'month', '2026-11-16', CALENDAR)).toEqual(['2026-11-16'])
    expect(resolveAsOf({ at: 'endOfLastMonth' }, 'month', '2026-11-16', CALENDAR)).toEqual(['2026-10-31'])
    expect(resolveAsOf({ at: 'endOfLastYear' }, 'month', '2026-11-16', CALENDAR)).toEqual(['2025-12-31'])
    expect(resolveAsOf({ at: 'endOfLastYear' }, 'month', '2026-11-16', UK_TAX)).toEqual(['2026-04-05'])
    expect(resolveAsOf({ date: '2026-03-31' }, 'month', '2026-11-16', CALENDAR)).toEqual(['2026-03-31'])
    expect(resolveAsOf({ ends: { from: '2026-01-01', to: '2026-06-30' } }, 'month', '2026-11-16', CALENDAR))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'])
    // The last point of a series that ends in the future is today
    expect(resolveAsOf({ ends: { preset: 'thisYear' } }, 'quarter', '2026-11-16', CALENDAR)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-11-16'])
    expect(resolveAsOf({ ends: { preset: 'thisYear' } }, 'quarter', '2027-03-16', UK_TAX)).toEqual(['2026-07-05', '2026-10-05', '2027-01-05', '2027-03-16'])
    // A period ending mid-month ends with its own last day
    expect(resolveAsOf({ ends: { from: '2026-01-01', to: '2026-03-15' } }, 'month', '2026-11-16', CALENDAR)).toEqual(['2026-01-31', '2026-02-28', '2026-03-15'])
    expect(resolveAsOf({ ends: { from: '2020-01-01', to: '2025-12-31' } }, 'year', '2026-11-16', CALENDAR)).toEqual(['2020-12-31', '2021-12-31', '2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31'])
  })

  it('never goes through a local Date: the same dates in every time zone', () => {
    // Run in the timezone project (Australia/Lord_Howe); the dates above are those of every zone. The labels are made
    // from each date's own parts, in UTC, so they are too
    const zone = process.env.TZ
    try {
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe', 'Europe/London']) {
        process.env.TZ = tz
        expect(resolvePeriod({ preset: 'thisYear' }, '2026-04-06', UK_TAX), tz).toEqual({ from: '2026-04-06', to: '2027-04-05' })
        expect(periodLabel({ from: '2026-03-01', to: '2026-03-31' }, CALENDAR, 'en-GB'), tz).toBe('March 2026')
        expect(columnLabel(timeColumns({ from: '2026-01-01', to: '2026-01-31' }, 'month', CALENDAR)[0], CALENDAR, 'en-GB'), tz).toBe('Jan 2026')
      }
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })
})

describe('labels', () => {
  it('name periods as a heading does, in the user\'s locale', () => {
    expect(plain(periodLabel({ from: '2026-01-01', to: '2026-12-31' }, CALENDAR, 'en-GB'))).toBe('2026')
    expect(plain(periodLabel({ from: '2026-04-06', to: '2027-04-05' }, UK_TAX, 'en-GB'))).toBe('2026–27')
    expect(plain(periodLabel({ from: '2026-03-01', to: '2026-03-31' }, CALENDAR, 'en-GB'))).toBe('March 2026')
    expect(plain(periodLabel({ from: '2026-01-01', to: '2026-03-31' }, CALENDAR, 'en-GB'))).toBe('January–March 2026')
    expect(plain(periodLabel({ from: '2026-03-10', to: '2026-04-15' }, CALENDAR, 'en-GB'))).toBe('10 Mar–15 Apr 2026')
    expect(plain(periodLabel({ from: '2026-03-10', to: '2026-04-15' }, CALENDAR, 'en-US'))).toBe('Mar 10–Apr 15, 2026')
    expect(plain(periodLabel({ from: '2026-03-10', to: '2026-03-10' }, CALENDAR, 'en-GB'))).toBe('10 Mar 2026')
    expect(yearLabel({ from: '2099-04-06', to: '2100-04-05' }, UK_TAX)).toBe('2099–00')
  })

  it('name columns: months, partial months by their dates, quarters and years of the ledger\'s year', () => {
    const labels = (range: DateRange, grain: 'month' | 'quarter' | 'year', start = CALENDAR) => timeColumns(range, grain, start).map(c => plain(columnLabel(c, start, 'en-GB')))
    expect(labels({ from: '2026-03-10', to: '2026-04-30' }, 'month')).toEqual(['10–31 Mar 2026', 'Apr 2026'])
    expect(labels({ from: '2026-01-01', to: '2026-06-30' }, 'quarter')).toEqual(['Q1 2026', 'Q2 2026'])
    expect(labels({ from: '2026-07-01', to: '2026-12-31' }, 'quarter', UK_TAX)).toEqual(['Q2 2026–27', 'Q3 2026–27'])
    expect(labels({ from: '2025-04-01', to: '2027-03-31' }, 'year', { month: 4, day: 1 })).toEqual(['2025–26', '2026–27'])
    expect(columnLabel(dateColumns(['2026-01-31'])[0], CALENDAR, 'en-GB')).toBe('31 Jan 2026')
    expect(plain(datesLabel(['2026-01-31', '2026-06-30'], 'month', 'en-GB'))).toBe('Month ends, Jan–Jun 2026')
    expect(plain(datesLabel(['2026-01-31'], 'month', 'en-GB'))).toBe('31 Jan 2026')
  })
})

// ---- A source, and specs on it, for the checks and the engine

const SOURCE: ReportSourceContribution = {
  id: 'test.flows', label: 'Test', service: 'test.flows', time: 'range',
  fields: [
    { kind: 'dimension', key: 'month', label: 'Month', type: 'time' },
    { kind: 'dimension', key: 'group', label: 'Group', type: 'enum', signed: true, values: [{ id: 'in', label: 'In', sign: 1 }, { id: 'out', label: 'Out', sign: -1 }] },
    { kind: 'dimension', key: 'flow', label: 'Flow', type: 'member', tree: true, signed: true, values: [{ id: 'in', label: 'In', sign: 1 }, { id: 'out', label: 'Out', sign: -1 }] },
    { kind: 'dimension', key: 'category', label: 'Category', type: 'member', tree: true, noneLabel: 'Uncategorised', plural: 'categories' },
    { kind: 'dimension', key: 'payee', label: 'Payee', type: 'member', noneLabel: 'No payee', plural: 'payees' },
    { kind: 'measure', key: 'amount', label: 'Amount', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'count', label: 'Count', unit: 'count', combine: 'sum' },
    { kind: 'measure', key: 'balance', label: 'Balance', unit: 'money', combine: 'last', dimensions: ['month', 'category'] },
    { kind: 'measure', key: 'given', label: 'Given', unit: 'percent', combine: 'none' },
    { kind: 'measure', key: 'openingBalance', label: 'Opening', unit: 'money', combine: 'none', dimensions: ['month'] },
    { kind: 'measure', key: 'closingBalance', label: 'Closing', unit: 'money', combine: 'none', dimensions: ['month'] },
    { kind: 'measure', key: 'opened', label: 'Opened', unit: 'money', combine: 'sum', dimensions: ['month'] }
  ]
}

const SPEC: ReportSpec = {
  specVersion: 1, source: 'test.flows',
  parameters: { period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed', compare: 'none', compareOptions: ['previousPeriod'] },
  query: { filters: [{ dimension: 'group', in: ['out'] }], rows: { dimension: 'category', depth: 1, sort: 'valueDesc' }, measures: [{ measure: 'amount', label: 'Spending' }] },
  presentation: { show: 'both', table: { totals: { row: true } }, chart: { kind: 'donut', measure: 0 } }
}

const DEFINITION: ReportDefinitionContribution = {
  id: 'test.spending', label: 'Spending', description: 'Where it went.', group: 'test.group', version: 1, spec: SPEC,
  options: [
    { key: 'detail', label: 'Detail', kind: 'choice', default: 'top', choices: [
      { value: 'top', label: 'Top', patch: {} },
      { value: 'all', label: 'All', patch: { query: { rows: { depth: 'all' } } } }
    ] },
    { key: 'count', label: 'Count too', kind: 'boolean', default: false, patch: { query: { measures: [{ measure: 'amount' }, { measure: 'count' }] } } }
  ]
}

const paths = (problems: { path: string }[]) => problems.map(p => p.path)
const withSpec = (patch: object) => mergePatch(SPEC, patch)

describe('checking contributions', () => {
  it('accepts a well-formed source, and names what is wrong with one that isn\'t', () => {
    expect(sourceProblem(SOURCE, 'test')).toBeUndefined()
    expect(sourceProblem(SOURCE, 'other')).toBe('A report source contributed by "other" needs an id starting with "other."')
    expect(sourceProblem({ ...SOURCE, service: '' }, 'test')).toBe('Report source "test.flows" needs a service')
    expect(sourceProblem({ ...SOURCE, time: 'weekly' }, 'test')).toBe('Report source "test.flows" needs time: range, months or asOf')
    expect(sourceProblem({ ...SOURCE, fields: [...SOURCE.fields, SOURCE.fields[0]] }, 'test')).toBe('Report source "test.flows" has two fields with the same key')
    expect(sourceProblem({ ...SOURCE, fields: [{ kind: 'dimension', key: 'x', label: 'X', type: 'enum' }, SOURCE.fields[5]] }, 'test')).toBe('Enum dimension "x" of source "test.flows" needs its values')
    expect(sourceProblem({ ...SOURCE, fields: [{ kind: 'measure', key: 'm', label: 'M', unit: 'money', combine: 'sum', dimensions: ['nope'] }] }, 'test')).toBe('Measure "m" of source "test.flows" names a dimension it doesn\'t have')
    expect(sourceProblem({ ...SOURCE, fields: [SOURCE.fields[0]] }, 'test')).toBe('Report source "test.flows" needs a measure')
    expect(sourceProblem({ ...SOURCE, fields: [...SOURCE.fields, { kind: 'dimension', key: 'day', label: 'Day', type: 'time' }] }, 'test')).toBe('Report source "test.flows" has more than one time dimension')
    expect(groupProblem({ id: 'test.group', label: 'Tests' }, 'test')).toBeUndefined()
    expect(groupProblem({ id: 'group', label: 'Tests' }, 'test')).toBe('A report group contributed by "test" needs an id starting with "test."')
  })

  it('accepts a well-formed spec, and names each problem by its path', () => {
    expect(specProblems(SPEC, SOURCE)).toEqual([])
    expect(paths(specProblems({ ...SPEC, specVersion: REPORT_SPEC_VERSION + 1 }, SOURCE))).toEqual(['specVersion'])
    expect(paths(specProblems({ ...SPEC, source: 'other.flows' }, SOURCE))).toEqual(['source'])
    expect(paths(specProblems(withSpec({ query: { rows: { dimension: 'lines' } } }), SOURCE))).toEqual(['query.rows.dimension'])
    expect(specProblems(withSpec({ query: { rows: { dimension: 'lines' } } }), SOURCE)[0].message).toBe('“lines” is not a dimension of source “test.flows”.')
    expect(paths(specProblems(withSpec({ query: { rows: { dimension: 'payee', depth: 2 } } }), SOURCE))).toEqual(['query.rows.depth'])
    expect(paths(specProblems(withSpec({ query: { rows: { grain: 'month' } } }), SOURCE))).toEqual(['query.rows.grain'])
    expect(paths(specProblems(withSpec({ query: { rows: { top: 0 } } }), SOURCE))).toEqual(['query.rows.top'])
    expect(paths(specProblems(withSpec({ query: { rows: { dimension: 'month', depth: null } } }), SOURCE))).toEqual(['query.rows.dimension'])
    expect(paths(specProblems(withSpec({ query: { columns: { dimension: 'category' } } }), SOURCE))).toEqual(['query.columns.dimension'])
    expect(paths(specProblems(withSpec({ query: { columns: { dimension: 'month', grain: 'week' } } }), SOURCE))).toEqual(['query.columns.grain'])
    expect(paths(specProblems(withSpec({ query: { measures: [] } }), SOURCE))).toEqual(['query.measures', 'presentation.chart.measure'])
    expect(paths(specProblems(withSpec({ query: { measures: [{ measure: 'nope' }] } }), SOURCE))).toEqual(['query.measures[0].measure'])
    expect(paths(specProblems(withSpec({ query: { measures: [{ measure: 'amount', show: 'average' }] } }), SOURCE))).toEqual(['query.measures[0].show'])
    // A measure broken down by a dimension it doesn't allow
    expect(specProblems(withSpec({ query: { rows: { dimension: 'payee', depth: null }, measures: [{ measure: 'balance' }] } }), SOURCE))
      .toEqual([
        { path: 'query.measures[0].measure', message: '“balance” can’t be broken down by “payee”.' },
        { path: 'query.measures[0].measure', message: '“balance” can’t be broken down by “group”.' }
      ])
    expect(paths(specProblems(withSpec({ query: { filters: [{ dimension: 'group', in: ['sideways'] }] } }), SOURCE))).toEqual(['query.filters[0]'])
    expect(paths(specProblems(withSpec({ query: { filters: [{ dimension: 'month', in: ['2026-01'] }] } }), SOURCE))).toEqual(['query.filters[0].dimension'])
    expect(paths(specProblems(withSpec({ presentation: { table: { nets: [{ label: 'Net' }] } } }), SOURCE))).toEqual(['presentation.table.nets'])
    expect(paths(specProblems(withSpec({ query: { rows: { dimension: 'flow' } }, presentation: { table: { nets: [{ label: 'Net', after: 'sideways' }] } } }), SOURCE))).toEqual(['presentation.table.nets[0].after'])
    expect(paths(specProblems(withSpec({ presentation: { table: { totals: { column: true } } } }), SOURCE))).toEqual(['presentation.table.totals.column'])
    expect(paths(specProblems(withSpec({ presentation: { chart: { measure: 3 } } }), SOURCE))).toEqual(['presentation.chart.measure'])
    expect(paths(specProblems(withSpec({ presentation: { chart: { slices: 9 } } }), SOURCE))).toEqual(['presentation.chart.slices'])
    expect(paths(specProblems(withSpec({ presentation: { chart: { kind: 'bar', slices: null, line: { row: 'net' } } } }), SOURCE))).toEqual(['presentation.chart.line'])
    expect(paths(specProblems(withSpec({ query: { measures: [{ measure: 'given' }] } }), SOURCE))).toEqual(['presentation.chart.measure'])
    expect(paths(specProblems(withSpec({ parameters: { period: null } }), SOURCE))).toEqual(['parameters.period'])
    expect(paths(specProblems(withSpec({ parameters: { asOf: { at: 'today' } } }), SOURCE))).toEqual(['parameters.asOf'])
    expect(paths(specProblems(withSpec({ parameters: { compare: 'previousYear' } }), SOURCE))).toEqual(['parameters.compare'])
    expect(paths(specProblems(withSpec({ parameters: { compareOptions: ['asOf'] } }), SOURCE))).toEqual(['parameters.compareOptions'])
    expect(paths(specProblems(withSpec({ parameters: { currency: 'all' } }), SOURCE))).toEqual(['parameters.currency'])
    expect(paths(specProblems(withSpec({ parameters: { choose: ['month'] } }), SOURCE))).toEqual(['parameters.choose'])
    expect(paths(specProblems(withSpec({ presentation: { table: { balanceRows: true } } }), SOURCE))).toEqual([])
    expect(paths(specProblems(withSpec({ presentation: { show: 'pie' } }), SOURCE))).toEqual(['presentation.show'])
  })

  it('keeps ledger ids out of definitions: no sub-ledger or account in the scope, no filter on members', () => {
    const def = (patch: object) => definitionProblems(mergePatch(DEFINITION, patch), SOURCE, 'test')
    expect(definitionProblems(DEFINITION, SOURCE, 'test')).toEqual([])
    expect(paths(def({ spec: { parameters: { scope: { kind: 'subLedger', subLedgerId: 'S1' } } } }))).toEqual(['spec.parameters.scope'])
    expect(paths(def({ spec: { parameters: { scope: { kind: 'accounts', accountIds: ['A1'] } } } }))).toEqual(['spec.parameters.scope'])
    expect(paths(def({ spec: { parameters: { scope: { kind: 'types', types: ['chequing'], subLedgerId: 'S1' } } } }))).toEqual(['spec.parameters.scope'])
    expect(paths(def({ spec: { parameters: { scope: { kind: 'types', types: ['chequing'] } } } }))).toEqual([])
    expect(paths(def({ spec: { query: { filters: [{ dimension: 'category', in: ['C1'] }] } } }))).toEqual(['spec.query.filters[0].dimension'])
    // The same are fine in a saved or designed spec
    expect(specProblems(mergePatch(SPEC, { parameters: { scope: { kind: 'subLedger', subLedgerId: 'S1' } }, query: { filters: [{ dimension: 'category', in: ['C1'] }] } }), SOURCE, true)).toEqual([])
    expect(paths(def({ id: 'spending' }))).toEqual(['id'])
    expect(paths(def({ version: 0, description: '' }))).toEqual(['description', 'version'])
  })

  it('checks the options, and every spec a user can reach with them', () => {
    const def = (options: unknown) => definitionProblems({ ...DEFINITION, options } as ReportDefinitionContribution, SOURCE, 'test')
    expect(paths(def([{ key: 'a b', label: 'A', kind: 'boolean', default: false, patch: {} }]))).toEqual(['options[0].key'])
    expect(paths(def([{ key: 'a', label: 'A', kind: 'boolean', default: 'no', patch: {} }]))).toEqual(['options[0].default'])
    expect(paths(def([{ key: 'a', label: 'A', kind: 'boolean', default: false, patch: { spec: {} } }]))).toEqual(['options[0].patch'])
    expect(paths(def([{ key: 'a', label: 'A', kind: 'choice', default: 'x', choices: [{ value: 'y', label: 'Y', patch: {} }, { value: 'z', label: 'Z', patch: {} }] }]))).toEqual(['options[0].default'])
    expect(paths(def([{ key: 'a', label: 'A', kind: 'choice', default: 'y', choices: [{ value: 'y', label: 'Y', patch: {} }] }]))).toEqual(['options[0].choices'])
    expect(paths(def([DEFINITION.options![0], DEFINITION.options![0]]))).toEqual(['options[1].key'])
    // A value whose spec is invalid: a depth on a dimension with none
    const bad = def([{ key: 'a', label: 'A', kind: 'choice', default: 'y', choices: [{ value: 'y', label: 'Y', patch: {} }, { value: 'z', label: 'Z', patch: { query: { rows: { dimension: 'payee' } } } }] }])
    expect(bad).toEqual([{ path: 'options[0]=z.query.rows.depth', message: '“payee” isn’t a tree, so it has no depth.' }])
  })

  it('checks parameters: a saved report\'s may name ledger ids, a definition\'s may not', () => {
    expect(parameterProblems({ scope: { kind: 'subLedger', subLedgerId: 'S1' }, period: { from: '2026-01-01', to: '2026-01-31' }, chosen: { category: ['C1'] } }, SOURCE, true)).toEqual([])
    expect(paths(parameterProblems({ period: { from: '2026-02-01', to: '2026-01-31' } }, SOURCE, true))).toEqual(['parameters.period'])
    expect(paths(parameterProblems({ period: { from: '2026-02-30', to: '2026-03-31' } }, SOURCE, true))).toEqual(['parameters.period'])
    expect(paths(parameterProblems({ period: { preset: 'nextYear' } }, SOURCE, true))).toEqual(['parameters.period'])
    expect(paths(parameterProblems({ scope: { kind: 'types', types: ['wallet'] } }, SOURCE, true))).toEqual(['parameters.scope'])
    expect(paths(parameterProblems({ currency: 'dollars' }, SOURCE, true))).toEqual(['parameters.currency'])
    expect(paths(parameterProblems({ compare: 'subLedgers' }, SOURCE, true))).toEqual([])
    expect(paths(parameterProblems({ compare: { asOf: { at: 'today' } } }, SOURCE, true))).toEqual(['parameters.compare'])
    expect(paths(parameterProblems({ source: { budget: 'B1' } }, SOURCE, true))).toEqual(['parameters.source.budget'])
    expect(paths(parameterProblems({ chosen: { month: ['2026-01'] } }, SOURCE, true))).toEqual(['parameters.chosen.month'])
    expect(paths(parameterProblems({ chosen: { category: ['C1'] } }, SOURCE, false))).toEqual(['parameters.chosen'])
    expect(paths(parameterProblems({ scope: { kind: 'ledger' } }, { ...SOURCE, scopes: 'none' }, true))).toEqual(['parameters.scope'])
  })
})

describe('options and specs', () => {
  it('merges patches as RFC 7396 says: objects merge, arrays and values replace, null removes', () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1, 2], e: 'x' }, { a: { b: 3 }, d: [9], e: null, f: { g: 1 } })).toEqual({ a: { b: 3, c: 2 }, d: [9], f: { g: 1 } })
    const target = { a: { b: 1 } }
    mergePatch(target, { a: { b: 2 } })
    expect(target).toEqual({ a: { b: 1 } })
  })

  it('applies each option\'s value in order, the default for one not given or no longer offered', () => {
    const options = DEFINITION.options!
    expect(applyOptions(SPEC, options, {})).toEqual(SPEC)
    expect(applyOptions(SPEC, options, { detail: 'all' }).query.rows).toEqual({ dimension: 'category', depth: 'all', sort: 'valueDesc' })
    expect(applyOptions(SPEC, options, { count: true }).query.measures).toEqual([{ measure: 'amount' }, { measure: 'count' }])
    expect(applyOptions(SPEC, options, { detail: 'sideways', count: 'yes' })).toEqual(SPEC)
    expect(optionValues(options, { detail: 'sideways', gone: true, count: true })).toEqual({ values: { detail: 'top', count: true }, dropped: ['detail', 'gone'] })
  })

  it('keeps Show the top with the option values, when it is a number of rows or all, and drops one that isn\'t (R4)', () => {
    const options = DEFINITION.options!
    expect(optionValues(options, { [TOP_OPTION]: '12' }).values).toEqual({ detail: 'top', count: false, [TOP_OPTION]: '12' })
    expect(optionValues(options, { [TOP_OPTION]: 'all' }).values[TOP_OPTION]).toBe('all')
    for (const bad of ['0', '501', '07', 'ten', 12 as never]) expect(optionValues(options, { [TOP_OPTION]: bad }), String(bad)).toEqual({ values: { detail: 'top', count: false }, dropped: [TOP_OPTION] })
    // Options never read it, so it patches nothing
    expect(applyOptions(SPEC, options, { [TOP_OPTION]: '3' })).toEqual(SPEC)
  })

  it('settles a row axis\'s top: the report\'s own choice, else the user\'s for `user`, else its own number (R4)', () => {
    const withTop = (top: number | 'user' | undefined) => spec({ query: { rows: { dimension: 'payee', depth: null, top: top ?? null } } })
    expect(applyTop(withTop('user'), {}, 25).query.rows?.top).toBe(25)
    expect(applyTop(withTop('user'), { [TOP_OPTION]: '7' }, 25).query.rows?.top).toBe(7)
    expect(applyTop(withTop(6), {}, 25).query.rows?.top).toBe(6)
    expect(applyTop(withTop(6), { [TOP_OPTION]: '9' }, 25).query.rows?.top).toBe(9)
    expect(applyTop(withTop('user'), { [TOP_OPTION]: 'all' }, 25).query.rows).not.toHaveProperty('top')
    // Rows that keep no top stay so, whatever is chosen
    expect(applyTop(withTop(undefined), { [TOP_OPTION]: '7' }, 25).query.rows).not.toHaveProperty('top')
    // 'user' is a spec's word for it; anything else is still refused
    expect(paths(specProblems(withTop('user'), SOURCE))).toEqual([])
    expect(paths(specProblems(spec({ query: { rows: { top: 'many' } } }), SOURCE))).toEqual(['query.rows.top'])
  })

  it('brings a spec up to date, and refuses one that is newer or isn\'t one', () => {
    expect(migrateSpec(SPEC)).toEqual(SPEC)
    expect(() => migrateSpec({ ...SPEC, specVersion: 99 })).toThrow(/newer version/)
    expect(() => migrateSpec('report')).toThrow(ReportsError)
  })
})

// ---- The engine

const m = (id: string, label: string, parentId: string | null = null, extra: object = {}) => ({ id, label, parentId, ...extra })
/** Members: Food (Groceries, Dining), Housing, Car; and payees. */
const CATEGORIES = [m('food', 'Food'), m('groceries', 'Groceries', 'food'), m('dining', 'Dining', 'food'), m('housing', 'Housing'), m('car', 'Car')]
const row = (keys: (string | null)[], values: number[], extra: Partial<SourceRow> = {}): SourceRow => ({ keys, values, ...extra })
const result = (rows: SourceRow[], members: SourceResult['members'] = { category: CATEGORIES }, extra: Partial<SourceResult> = {}): SourceResult =>
  ({ rows, members, notes: [], ...extra })

/** Shapes rows keyed [category] or [category, month], valued [amount]. */
function shaped(spec: ReportSpec, r: SourceResult, extra: Partial<ShapeInput> = {}) {
  const dims = [...new Set([spec.query.rows?.dimension, spec.query.columns?.dimension].filter((d): d is string => d !== undefined))]
  return shape({ spec, source: SOURCE, result: r, dimensions: extra.dimensions ?? dims, measures: extra.measures ?? ['amount'], ...extra })
}
const lines = (s: ReturnType<typeof shape>) => s.rows.map(r => [r.label, r.kind, r.depth, ...r.values])
const spec = (patch: object) => mergePatch<ReportSpec>({ ...SPEC, query: { ...SPEC.query, filters: [] } }, patch)

describe('the engine', () => {
  const food = result([
    row(['groceries'], [60000]), row(['dining'], [20000]), row(['food'], [5000]), row(['housing'], [150000]), row(['car'], [-2500]), row([null], [4100])
  ])

  it('rolls a tree up to a depth, sorts by value, and puts Uncategorised last whatever its size', () => {
    expect(lines(shaped(SPEC, food))).toEqual([
      ['Housing', 'member', 1, 150000], ['Food', 'member', 1, 85000], ['Car', 'member', 1, -2500], ['Uncategorised', 'none', 1, 4100],
      ['Total', 'total', 1, 236600]
    ])
  })

  it('shows every level with depth all: parents hold subtotals, and what a parent has of its own is "(other)"', () => {
    expect(lines(shaped(spec({ query: { rows: { depth: 'all' } } }), food))).toEqual([
      ['Housing', 'member', 1, 150000], ['Food', 'subtotal', 1, 85000], ['Groceries', 'member', 2, 60000], ['Dining', 'member', 2, 20000],
      ['Food (other)', 'own', 2, 5000], ['Car', 'member', 1, -2500], ['Uncategorised', 'none', 1, 4100], ['Total', 'total', 1, 236600]
    ])
    // Below: a heading, the children, and a Total row, as the budget view draws its groups; deeper parents hold theirs
    const below = shaped(spec({ query: { rows: { depth: 'all', subtotals: 'below', sort: 'label' } } }), food)
    expect(lines(below).slice(0, 6)).toEqual([
      ['Car', 'member', 1, -2500], ['Food', 'heading', 1, null], ['Dining', 'member', 2, 20000], ['Groceries', 'member', 2, 60000],
      ['Food (other)', 'own', 2, 5000], ['Total food', 'subtotal', 1, 85000]
    ])
    expect(below.rows.find(r => r.label === 'Dining')?.parentId).toBe('food')
    const deeper = shaped(spec({ query: { rows: { depth: 'all', subtotals: 'below' } } }), result(
      [row(['groceries'], [60000]), row(['housing'], [1])],
      { category: [m('all', 'Everything'), m('food', 'Food', 'all'), m('groceries', 'Groceries', 'food'), m('housing', 'Housing', 'all')] }))
    expect(lines(deeper)).toEqual([
      ['Everything', 'heading', 1, null], ['Food', 'subtotal', 2, 60000], ['Groceries', 'member', 3, 60000], ['Housing', 'member', 2, 1],
      ['Total everything', 'subtotal', 1, 60001], ['Total', 'total', 1, 60001]
    ])
  })

  it('sorts naturally, by label, or by value either way', () => {
    const order = (sort: string) => shaped(spec({ query: { rows: { sort } } }), food).rows.map(r => r.label)
    expect(order('natural')).toEqual(['Food', 'Housing', 'Car', 'Uncategorised', 'Total'])
    expect(order('label')).toEqual(['Car', 'Food', 'Housing', 'Uncategorised', 'Total'])
    expect(order('valueAsc')).toEqual(['Car', 'Food', 'Housing', 'Uncategorised', 'Total'])
  })

  it('keeps the top rows and gathers the rest as Other, named with their count; no payee is never gathered', () => {
    const payees = result(
      [...Array.from({ length: 30 }, (_, i) => row([`p${i}`], [(i + 1) * 100])), row([null], [50])],
      { payee: Array.from({ length: 30 }, (_, i) => m(`p${i}`, `Payee ${i}`)) }
    )
    const s = shaped(spec({ query: { rows: { dimension: 'payee', depth: null, top: 3 } } }), payees)
    expect(lines(s)).toEqual([
      ['Payee 29', 'member', 1, 3000], ['Payee 28', 'member', 1, 2900], ['Payee 27', 'member', 1, 2800],
      ['Other payees (27)', 'other', 1, 37800], ['No payee', 'none', 1, 50], ['Total', 'total', 1, 46550]
    ])
    expect(s.notes).toEqual([{ tone: 'info', text: 'Showing the top 3 of 30 payees.' }])
  })

  it('pivots months across, each present even if empty, with a total and an average a month (halves up)', () => {
    const columns = [{ key: '2026-01', label: 'Jan', keys: ['2026-01'] }, { key: '2026-02', label: 'Feb', keys: ['2026-02'] }, { key: '2026-03', label: 'Mar', keys: ['2026-03'] }]
    const r = result([row(['food', '2026-01'], [100]), row(['food', '2026-03'], [201]), row(['car', '2026-02'], [-5])])
    const s = shaped(spec({
      query: { columns: { dimension: 'month', grain: 'month' }, measures: [{ measure: 'amount' }, { measure: 'amount', show: 'average', label: 'Average a month' }, { measure: 'amount', show: 'cumulative' }] },
      presentation: { table: { totals: { row: true, column: true } }, chart: { kind: 'line', measure: 0 } }
    }), r, { columns })
    expect(s.columns.map(c => c.group ? `${c.group}:${c.label}` : c.label)).toEqual([
      'Jan:Amount', 'Jan:Amount to date', 'Feb:Amount', 'Feb:Amount to date', 'Mar:Amount', 'Mar:Amount to date',
      'Total:Amount', 'Total:Amount to date', 'Average a month'
    ])
    expect(lines(s)).toEqual([
      ['Food', 'member', 1, 100, 100, null, 100, 201, 301, 301, 301, 100],
      ['Car', 'member', 1, null, null, -5, -5, null, -5, -5, -5, -2],
      ['Total', 'total', 1, 100, 100, -5, 95, 201, 296, 296, 296, 99]
    ])
    expect(s.chart).toEqual({ kind: 'line', categories: ['Jan', 'Feb', 'Mar'], unit: 'money', series: [
      { key: 'food', label: 'Food', values: [100, null, 201], as: 'line' }, { key: 'car', label: 'Car', values: [null, -5, null], as: 'line' }
    ] })
  })

  it('works out shares in basis points, rounded down, exactly even past the safe integers', () => {
    expect(ratio(1842000, 4074790)).toBe(4520)
    expect(ratio(1, 3)).toBe(3333)
    expect(ratio(-1, 3)).toBe(-3333)
    expect(ratio(5, 0)).toBeNull()
    // 9 × 10¹⁴ × 10⁴ is past 2⁵³: worked out with BigInt
    expect(ratio(900_000_000_000_000, 2_700_000_000_000_001)).toBe(3333)
    // Just under 2067: in floating point, 1,000,000,000,000,031 × 10⁴ rounds up, and the share with it
    expect(ratio(1_000_000_000_000_031, 4_837_929_366_231_403)).toBe(2066)
    expect(averageOf(5, 2)).toBe(3)
    expect(averageOf(-5, 2)).toBe(-2)
    expect(averageOf(-7, 2)).toBe(-3)
    expect(averageOf(481895, 6)).toBe(80316)
    const s = shaped(spec({ query: { measures: [{ measure: 'amount' }, { measure: 'amount', show: 'share', label: 'Share' }] } }), food)
    expect(s.rows.map(r => r.values[1])).toEqual([6339, 3592, -105, 173, 10000])
  })

  it('refuses a figure that can\'t be exact rather than showing a wrong one', () => {
    const huge = result([row(['food'], [Number.MAX_SAFE_INTEGER]), row(['car'], [Number.MAX_SAFE_INTEGER])])
    expect(() => shaped(SPEC, huge)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }))
  })

  it('totals by each measure\'s combine: sum adds, last takes the last column, none takes the source\'s', () => {
    const columns = [{ key: '2026-01', label: 'Jan' }, { key: '2026-02', label: 'Feb' }]
    const r = result([row(['food', '2026-01'], [100, 7]), row(['food', '2026-02'], [150, 8]), row(['car', '2026-02'], [20, 9])], undefined, { totals: { '': [0, 5500], food: [0, 4200] } })
    const s = shaped(spec({
      query: { columns: { dimension: 'month', grain: 'month' }, measures: [{ measure: 'balance' }, { measure: 'given' }] },
      presentation: { table: { totals: { row: true, column: true } }, chart: { kind: 'bar', measure: 0 } }
    }), r, { columns, measures: ['balance', 'given'] })
    expect(lines(s)).toEqual([
      ['Food', 'member', 1, 100, 7, 150, 8, 150, 4200],
      ['Car', 'member', 1, null, null, 20, 9, 20, null],
      ['Total', 'total', 1, 100, 7, 170, 17, 170, 5500]
    ])
  })

  it('says what each row and column gathers, for Show Transactions, only when its source can list transactions (1.1)', () => {
    const listing = { ...SOURCE, drillDown: true }
    const all = spec({ query: { rows: { depth: 'all' } } })
    // A source that can't list them: nothing to drill, anywhere
    const plain = shaped(all, food)
    expect(plain.rows.every(r => r.drill === undefined) && plain.columns.every(c => c.drill === undefined)).toBe(true)
    const s = shaped(all, food, { source: listing })
    const drills = Object.fromEntries(s.rows.map(r => [r.label, r.drill]))
    expect(drills).toEqual({
      Housing: { keys: ['housing'] }, Food: { keys: ['food'] }, Groceries: { keys: ['groceries'] }, Dining: { keys: ['dining'] },
      'Food (other)': { keys: ['food'], own: true }, Car: { keys: ['car'] }, Uncategorised: { keys: [null] }, Total: {}
    })
    expect(s.columns[0].drill).toEqual({ measure: 'amount' })
    // Other: the rows it gathers
    const payees = result(Array.from({ length: 5 }, (_, i) => row([`p${i}`], [(i + 1) * 100])), { payee: Array.from({ length: 5 }, (_, i) => m(`p${i}`, `P${i}`)) })
    const top = shaped(spec({ query: { rows: { dimension: 'payee', depth: null, top: 2 } } }), payees, { source: listing })
    expect(top.rows.find(r => r.kind === 'other')?.drill).toEqual({ keys: ['p2', 'p1', 'p0'] })
    // Months across: each month's; the total the period's; a running total up to its month; an average, a change: nothing
    const columns = [{ key: '2026-01', label: 'Jan', keys: ['2026-01'] }, { key: 'q', label: 'Feb–Mar', keys: ['2026-02', '2026-03'] }]
    const across = shaped(spec({
      query: { columns: { dimension: 'month', grain: 'month' }, measures: [{ measure: 'amount' }, { measure: 'amount', show: 'cumulative' }, { measure: 'amount', show: 'average' }] },
      presentation: { table: { totals: { row: true, column: true } }, chart: null }
    }), result([row(['food', '2026-01'], [100])]), { source: listing, columns })
    expect(across.columns.map(c => [c.group ?? '', c.label, c.drill])).toEqual([
      ['Jan', 'Amount', { measure: 'amount', months: ['2026-01'] }], ['Jan', 'Amount to date', { measure: 'amount', months: ['2026-01'] }],
      ['Feb–Mar', 'Amount', { measure: 'amount', months: ['2026-02', '2026-03'] }],
      ['Feb–Mar', 'Amount to date', { measure: 'amount', months: ['2026-01', '2026-02', '2026-03'] }],
      ['Total', 'Amount', { measure: 'amount' }], ['Total', 'Amount to date', { measure: 'amount' }], ['', 'Average', undefined]
    ])
    // Compared: the earlier period's; a change is no sum of transactions
    const compared = shaped(spec({ query: { measures: [{ measure: 'amount' }, { measure: 'amount', show: 'compared' }, { measure: 'amount', show: 'change' }] } }),
      food, { source: listing, compared: { result: food, label: '2025' } })
    expect(compared.columns.map(c => c.drill)).toEqual([{ measure: 'amount' }, { measure: 'amount', compared: true }, undefined])
    // Balances at a date are no sum of transactions either
    const asOf = shaped(all, food, { source: { ...listing, time: 'asOf' } })
    expect(asOf.columns[0].drill).toBeUndefined()
  })

  it('works out a per cent of another figure in each cell, at every level, never for a net (1.3)', () => {
    const budgetSource: ReportSourceContribution = {
      ...SOURCE, drillDown: true,
      fields: [
        // Copies: the flow dimension's values change below, and SOURCE is every test's
        ...structuredClone(SOURCE.fields.filter(f => f.kind === 'dimension')),
        { kind: 'measure', key: 'budget', label: 'Budget', unit: 'money', combine: 'sum', drillDown: false },
        { kind: 'measure', key: 'actual', label: 'Actual', unit: 'money', combine: 'sum' },
        { kind: 'measure', key: 'remaining', label: 'Remaining', unit: 'money', combine: 'sum', drillDown: false }
      ]
    }
    const flowField = budgetSource.fields.find(f => f.key === 'flow') as { values: { id: string, label: string, sign: 1 | -1, negativeIsBad?: boolean }[] }
    flowField.values = [{ id: 'in', label: 'In', sign: 1 }, { id: 'out', label: 'Out', sign: -1, negativeIsBad: true }]
    const r = result([row(['salary'], [500000, 520000, -20000]), row(['rent'], [150000, 150000, 0]), row(['food'], [80000, 86215, -6215])], {
      flow: [m('salary', 'Salary', 'in'), m('rent', 'Rent', 'out'), m('food', 'Food', 'out')]
    })
    const plan = spec({
      source: 'test.flows',
      query: { rows: { dimension: 'flow', depth: 'all', sort: 'natural', subtotals: 'below' }, measures: [{ measure: 'budget' }, { measure: 'actual' }, { measure: 'remaining' }, { measure: 'actual', show: 'percentOf', of: 'budget' }] },
      presentation: { table: { totals: null, nets: [{ label: 'Net', negate: ['remaining'] }] }, chart: { kind: 'groupedBar', measure: 1, series: 'measures', measures: [0, 1], under: 'out' } }
    })
    expect(specProblems(plan, budgetSource)).toEqual([])
    const s = shape({ spec: plan, source: budgetSource, result: r, dimensions: ['flow'], measures: ['budget', 'actual', 'remaining'] })
    expect(s.columns.map(c => [c.label, c.unit, c.drill])).toEqual([
      ['Budget', 'money', undefined], ['Actual', 'money', { measure: 'actual' }], ['Remaining', 'money', undefined], ['Actual as % of Budget', 'percent', undefined]
    ])
    const byLabel = Object.fromEntries(s.rows.map(x => [x.label, x]))
    expect(byLabel['Food'].values).toEqual([80000, 86215, -6215, 10776])
    expect(byLabel['Total out'].values).toEqual([230000, 236215, -6215, 10270])
    // The net: Σ sign × value, its Remaining read the other way (how far ahead of the plan), and no per cent
    expect(byLabel['Net'].values).toEqual([270000, 283785, 13785, null])
    // Under Out, a negative figure is bad; under In, it isn't
    expect([byLabel['Food'].negativeIsBad, byLabel['Total out'].negativeIsBad, byLabel['Salary'].negativeIsBad, byLabel['Total in'].negativeIsBad]).toEqual([true, true, undefined, undefined])
    // Budget beside actual for what is under Out
    expect(s.chart).toEqual({
      kind: 'groupedBar', categories: ['Rent', 'Food'], unit: 'money',
      series: [{ key: 'm0', label: 'Budget', values: [150000, 80000], as: 'bar' }, { key: 'm1', label: 'Actual', values: [150000, 86215], as: 'bar' }]
    })
  })

  it('refuses a per cent of nothing, a net reading a measure the source hasn\'t, and bars under no top member (1.3)', () => {
    expect(paths(specProblems(spec({ query: { measures: [{ measure: 'amount', show: 'percentOf' }] } }), SOURCE))).toEqual(['query.measures[0].of'])
    expect(paths(specProblems(spec({ query: { measures: [{ measure: 'amount', show: 'percentOf', of: 'amount' }] } }), SOURCE))).toEqual(['query.measures[0].of'])
    expect(paths(specProblems(spec({ query: { measures: [{ measure: 'amount', of: 'count' }] } }), SOURCE))).toEqual(['query.measures[0].of'])
    expect(paths(specProblems(spec({ query: { rows: { dimension: 'flow' } }, presentation: { table: { nets: [{ label: 'Net', negate: ['weather'] }] } } }), SOURCE))).toEqual(['presentation.table.nets[0].negate'])
    expect(paths(specProblems(spec({ query: { rows: { dimension: 'flow' } }, presentation: { chart: { kind: 'bar', measure: 0, series: 'measures', measures: [0], under: 'sideways' } } }), SOURCE))).toEqual(['presentation.chart.under'])
    expect(paths(specProblems(spec({ presentation: { chart: { kind: 'bar', measure: 0, measures: [0] } } }), SOURCE))).toEqual(['presentation.chart.measures'])
  })

  it('says a net row is signed, and a heading has nothing to drill (1.1)', () => {
    const flows = result([row(['salary'], [5000]), row(['rent'], [1500])], { flow: [m('salary', 'Salary', 'in'), m('rent', 'Rent', 'out')] })
    const s = shaped(spec({
      query: { rows: { dimension: 'flow', depth: 2, subtotals: 'below' } },
      presentation: { table: { totals: null, nets: [{ label: 'Net income', of: ['in', 'out'] }] }, chart: null }
    }), flows, { source: { ...SOURCE, drillDown: true } })
    expect(s.rows.map(r => [r.label, r.drill])).toEqual([
      ['In', undefined], ['Salary', { keys: ['salary'] }], ['Total in', { keys: ['in'] }],
      ['Out', undefined], ['Rent', { keys: ['rent'] }], ['Total out', { keys: ['out'] }],
      ['Net income', { keys: ['in', 'out'], signed: true }]
    ])
  })

  it('adds net rows over a signed dimension\'s top members, after a block, and leaves out one that would repeat the last', () => {
    const flows = result([row(['salary'], [5000]), row(['rent'], [1500]), row(['out:Savings'], [300])], {
      flow: [m('salary', 'Salary', 'in'), m('rent', 'Rent', 'out'), m('out:Savings', 'Savings', 'out')]
    })
    const s = shaped(spec({
      query: { rows: { dimension: 'flow', depth: 2, subtotals: 'below' } },
      presentation: { table: { totals: null, nets: [{ label: 'Net income', of: ['in', 'out'], after: 'out' }, { label: 'Net after transfers' }] }, chart: null }
    }), flows)
    expect(lines(s)).toEqual([
      ['In', 'heading', 1, null], ['Salary', 'member', 2, 5000], ['Total in', 'subtotal', 1, 5000],
      ['Out', 'heading', 1, null], ['Rent', 'member', 2, 1500], ['Savings', 'member', 2, 300], ['Total out', 'subtotal', 1, 1800],
      ['Net income', 'net', 1, 3200]
    ])
    expect(s.rows.find(r => r.kind === 'net')?.negativeIsBad).toBe(true)
  })

  it('keeps a signed tree\'s top members in their order, whatever their size', () => {
    const flows = result([row(['salary'], [100]), row(['rent'], [1500])], { flow: [m('salary', 'Salary', 'in'), m('rent', 'Rent', 'out')] })
    const s = shaped(spec({ query: { rows: { dimension: 'flow', depth: 1, sort: 'valueDesc' } }, presentation: { chart: null } }), flows)
    expect(s.rows.map(r => r.label)).toEqual(['In', 'Out', 'Total'])
  })

  it('compares with an earlier period: by row, column for column, a member in one period only with "—" in the other', () => {
    const now = result([row(['food'], [90000]), row(['housing'], [150000])])
    const before = result([row(['food'], [80000]), row(['car'], [12000])])
    const s = shaped(spec({ query: { measures: [{ measure: 'amount' }, { measure: 'amount', show: 'compared' }, { measure: 'amount', show: 'change' }, { measure: 'amount', show: 'changePercent' }] } }), now,
      { compared: { result: before, label: '2025' } })
    expect(s.columns.map(c => c.label)).toEqual(['Amount', '2025', 'Change', 'Change %'])
    expect(lines(s)).toEqual([
      ['Housing', 'member', 1, 150000, null, 150000, null],
      ['Food', 'member', 1, 90000, 80000, 10000, 1250],
      ['Car', 'member', 1, null, 12000, -12000, -10000],
      ['Total', 'total', 1, 240000, 92000, 148000, 16086]
    ])
    // Nothing compared: those figures aren't shown at all
    expect(shaped(spec({ query: { measures: [{ measure: 'amount' }, { measure: 'amount', show: 'compared' }] } }), now).columns.map(c => c.label)).toEqual(['Amount'])
  })

  it('lays sub-ledgers side by side, one column each, from the scope of each row', () => {
    const r = result([row(['food'], [100], { scope: 0 }), row(['food'], [50], { scope: 1 }), row(['food'], [150], { scope: 2 }), row(['car'], [7], { scope: 1 }), row(['car'], [7], { scope: 2 })])
    const s = shaped(spec({ query: { columns: { dimension: 'month' } } }), r, { scopes: ['Personal', 'Business', 'Whole ledger'], dimensions: ['category'] })
    expect(s.columns.map(c => c.label)).toEqual(['Personal', 'Business', 'Whole ledger'])
    expect(lines(s)).toEqual([['Food', 'member', 1, 100, 50, 150], ['Car', 'member', 1, null, 7, 7], ['Total', 'total', 1, 100, 57, 157]])
  })

  it('keeps each currency\'s figures apart: a parent of several shows none, and the total is per currency', () => {
    const r = result([row(['groceries'], [100], { currency: 'CAD' }), row(['dining'], [30], { currency: 'USD' }), row(['housing'], [900], { currency: 'CAD' })])
    const s = shaped(spec({ query: { rows: { depth: 'all' } } }), r)
    expect(s.rows.map(x => [x.label, x.currency ?? '', x.values[0]])).toEqual([
      ['Housing', 'CAD', 900], ['Food', '', null], ['Groceries', 'CAD', 100], ['Dining', 'USD', 30], ['Total (CAD)', 'CAD', 1000], ['Total (USD)', 'USD', 30]
    ])
  })

  it('adds balance rows: opening first, accounts opened when any, closing last; across the total, first and last', () => {
    const columns = [{ key: '2026-01', label: 'Jan' }, { key: '2026-02', label: 'Feb' }]
    const r = result([row(['food', '2026-01'], [100]), row(['food', '2026-02'], [200])])
    const balances = { result: result([row(['2026-01'], [1000, 900, 0]), row(['2026-02'], [900, 1200, 500])]), dimensions: ['month'], measures: ['openingBalance', 'closingBalance', 'opened'] }
    const s = shaped(spec({ query: { columns: { dimension: 'month' } }, presentation: { table: { totals: { row: false, column: true }, balanceRows: true } } }), r, { columns, balances })
    expect(lines(s)).toEqual([
      ['Opening balance', 'balance', 1, 1000, 900, 1000], ['Food', 'member', 1, 100, 200, 300],
      ['Accounts opened', 'balance', 1, 0, 500, 500], ['Closing balance', 'balance', 1, 900, 1200, 1200]
    ])
  })

  it('draws a donut of the largest slices and Other, and bars of the first rows', () => {
    const many = result(Array.from({ length: 10 }, (_, i) => row([`p${i}`], [(10 - i) * 100])), { payee: Array.from({ length: 10 }, (_, i) => m(`p${i}`, `P${i}`)) })
    const donut = shaped(spec({ query: { rows: { dimension: 'payee', depth: null } }, presentation: { chart: { kind: 'donut', measure: 0, slices: 4 } } }), many).chart!
    expect([donut.categories, donut.series[0].values]).toEqual([['P0', 'P1', 'P2', 'Other (7)'], [1000, 900, 800, 2800]])
    const bars = shaped(spec({ query: { rows: { dimension: 'payee', depth: null } }, presentation: { chart: { kind: 'bar', measure: 0, horizontal: true, limit: 2 } } }), many).chart!
    expect(bars).toEqual({ kind: 'bar', horizontal: true, categories: ['P0', 'P1'], series: [{ key: 'value', label: 'Spending', values: [1000, 900] }], unit: 'money' })
  })

  it('draws at most the series limit, the smallest as Other, with the total as a line over the bars', () => {
    const columns = [{ key: '2026-01', label: 'Jan' }]
    const many = result(Array.from({ length: 5 }, (_, i) => row([`p${i}`, '2026-01'], [(i + 1) * 10])), { payee: Array.from({ length: 5 }, (_, i) => m(`p${i}`, `P${i}`)) })
    const chart = shaped(spec({
      query: { rows: { dimension: 'payee', depth: null }, columns: { dimension: 'month' } },
      presentation: { table: { totals: { row: true } }, chart: { kind: 'stackedBar', measure: 0, limit: 3, line: { row: 'total' } } }
    }), many, { columns }).chart!
    expect(chart.series.map(s => [s.label, s.values[0], s.as, s.stack ?? ''])).toEqual([
      ['P4', 50, 'bar', 'all'], ['P3', 40, 'bar', 'all'], ['Other (3)', 60, 'bar', 'all'], ['Total', 150, 'line', '']
    ])
  })

  it('keeps the first rows that fit past the cell limit, the totals with them, and says so', () => {
    const rows = Array.from({ length: 6000 }, (_, i) => row([`p${i}`], [1]))
    const s = shaped(spec({ query: { rows: { dimension: 'payee', depth: null, sort: 'natural' } }, presentation: { chart: null } }),
      result(rows, { payee: rows.map((_, i) => m(`p${i}`, `P${i}`)) }))
    expect(s.rows).toHaveLength(Math.min(5000, REPORT_CELLS_MAX))
    expect(s.rows[s.rows.length - 1]).toMatchObject({ kind: 'total', values: [6000] })
    expect(s.notes.at(-1)?.text).toBe('This report is too large to show whole: showing the first 4999 of 6000 rows. Choose a shorter period, fewer columns or fewer rows.')
  })

  it('filters again, a tree\'s member with its descendants; members with nothing are hidden unless asked for', () => {
    const s = shaped(spec({ query: { rows: { depth: 'all' } } }), food, { filters: [{ dimension: 'category', in: ['food'] }] })
    expect(s.rows.map(r => r.label)).toEqual(['Food', 'Groceries', 'Dining', 'Food (other)', 'Total'])
    const shown = shaped(spec({ query: { rows: { empty: 'show' } } }), result([row(['food'], [1])]))
    expect(shown.rows.map(r => [r.label, r.values[0]])).toEqual([['Food', 1], ['Car', null], ['Housing', null], ['Total', 1]])
  })
})
