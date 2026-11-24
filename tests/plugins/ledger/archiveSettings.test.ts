// @vitest-environment node
// The Archiving page's settings, and the date File › Archive Ledger… suggests: the most recent start of the ledger's
// year (File › Ledger Properties…), moved back by the years the page keeps. See docs/ledger-compaction-design.md,
// "The Archiving page", and docs/reporting-design.md, "The ledger's year start".
// (The suggestion from an open ledger's own year start is in yearStart.test.ts.)
import { describe, expect, it } from 'vitest'
import { LEDGER_ARCHIVE_SETTINGS, LEDGER_ARCHIVE_SETTINGS_PAGE, LEDGER_SETTINGS_PAGE, type YearStart } from '@tessera/ledger-api'
import {
  ARCHIVE_SETTINGS, archiveSettingsPage, suggestedArchiveDate, type ArchiveSettings
} from '../../../plugins/ledger/src/privileged/archive/settings'

const DEFAULTS: ArchiveSettings = { yearStartMonth: 1, yearStartDay: 1, keepYears: 0 }
const CALENDAR: YearStart = { month: 1, day: 1 }
const UK_TAX: YearStart = { month: 4, day: 6 }
/** Noon, local time, on a day: the suggestion is about the user's own calendar. */
const on = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12)

describe('the suggested archive date', () => {
  it('is the start of this calendar year, for a calendar year keeping none', () => {
    expect(suggestedArchiveDate(on(2026, 11, 10), CALENDAR, 0)).toBe('2026-01-01')
    expect(suggestedArchiveDate(on(2027, 1, 15), CALENDAR, 0)).toBe('2027-01-01')
    // On the day itself: archiving before today is allowed, and archives the whole of last year
    expect(suggestedArchiveDate(on(2027, 1, 1), CALENDAR, 0)).toBe('2027-01-01')
    expect(suggestedArchiveDate(on(2026, 12, 31), CALENDAR, 0)).toBe('2026-01-01')
  })

  it('keeps whole years before it in the ledger when asked', () => {
    expect(suggestedArchiveDate(on(2026, 11, 10), CALENDAR, 1)).toBe('2025-01-01')
    expect(suggestedArchiveDate(on(2026, 11, 10), CALENDAR, 10)).toBe('2016-01-01')
  })

  it('follows a year that starts on another day: the most recent start on or before today', () => {
    expect(suggestedArchiveDate(on(2026, 11, 10), UK_TAX, 0)).toBe('2026-04-06')
    expect(suggestedArchiveDate(on(2027, 2, 10), UK_TAX, 0)).toBe('2026-04-06')
    expect(suggestedArchiveDate(on(2027, 4, 5), UK_TAX, 0)).toBe('2026-04-06')
    expect(suggestedArchiveDate(on(2027, 4, 6), UK_TAX, 0)).toBe('2027-04-06')
    expect(suggestedArchiveDate(on(2027, 2, 10), UK_TAX, 1)).toBe('2025-04-06')
    expect(suggestedArchiveDate(on(2026, 11, 10), { month: 7, day: 1 }, 0)).toBe('2026-07-01')
    expect(suggestedArchiveDate(on(2026, 6, 30), { month: 7, day: 1 }, 0)).toBe('2025-07-01')
  })

  it('uses the local date, not UTC: just after midnight on 1 January is the new year, wherever the user is', () => {
    const zone = process.env.TZ
    try {
      // UTC+14 and UTC-11: in UTC, one is still 31 December and the other already 1 January
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        process.env.TZ = tz
        expect(suggestedArchiveDate(new Date(2027, 0, 1, 0, 1), CALENDAR, 0), tz).toBe('2027-01-01')
        expect(suggestedArchiveDate(new Date(2026, 11, 31, 23, 59), CALENDAR, 0), tz).toBe('2026-01-01')
      }
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })
})

describe('the archive settings', () => {
  const problems = (over: Partial<Record<keyof ArchiveSettings, unknown>>) => ARCHIVE_SETTINGS.validate!({ ...DEFAULTS, ...over } as ArchiveSettings)

  it('default to a calendar year, keeping no years before it', () => {
    expect(ARCHIVE_SETTINGS.id).toBe(LEDGER_ARCHIVE_SETTINGS)
    expect(ARCHIVE_SETTINGS.defaults).toEqual(DEFAULTS)
    expect(problems({})).toEqual([])
  })

  // The year start stays in the settings, off the page, as what a ledger without one is given (yearStart.test.ts)
  it('accept a start that exists every year, and refuse one that doesn\'t', () => {
    expect(problems({ yearStartMonth: 2, yearStartDay: 28 })).toEqual([])
    expect(problems({ yearStartMonth: 2, yearStartDay: 29 })).toEqual(['Month 2 has days 1 to 28 (the 29th isn’t there every year).'])
    expect(problems({ yearStartMonth: 4, yearStartDay: 31 })).toEqual(['Month 4 has days 1 to 30.'])
    expect(problems({ yearStartMonth: 12, yearStartDay: 31 })).toEqual([])
    expect(problems({ yearStartDay: 0 })).toEqual(['Month 1 has days 1 to 31.'])
  })

  it('refuse a month, a day or a number of years out of range or not whole', () => {
    expect(problems({ yearStartMonth: 13 })).toEqual(['The year starts in a month from 1 to 12.'])
    expect(problems({ yearStartMonth: 0 })).toEqual(['The year starts in a month from 1 to 12.'])
    expect(problems({ yearStartDay: 1.5 })).toEqual(['Month 1 has days 1 to 31.'])
    expect(problems({ keepYears: 11 })).toEqual(['Keep from 0 to 10 years.'])
    expect(problems({ keepYears: -1 })).toEqual(['Keep from 0 to 10 years.'])
    expect(problems({ keepYears: '1' })).toEqual(['Keep from 0 to 10 years.'])
  })

  it('show only the years to keep on the Archiving page, under Ledger, pointing to where the year start is set', () => {
    expect(archiveSettingsPage).toMatchObject({ id: LEDGER_ARCHIVE_SETTINGS_PAGE, parent: LEDGER_SETTINGS_PAGE, settings: LEDGER_ARCHIVE_SETTINGS, title: 'Archiving' })
    expect(archiveSettingsPage.fields?.map(f => [f.kind, f.key, (f as { min?: number }).min, (f as { max?: number }).max, (f as { integer?: boolean }).integer])).toEqual([
      ['number', 'keepYears', 0, 10, true]
    ])
    expect(archiveSettingsPage.description).toContain('File › Ledger Properties…')
  })
})
