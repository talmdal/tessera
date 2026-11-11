// The ledger's archive settings: namespace `ledger.archive`, on the Archiving page (Tools › Options… › Ledger ›
// Archiving). They choose the date File › Archive Ledger… suggests: the start of the current year, moved to when the
// user's year starts (a tax or fiscal year), and back by the years they keep. Application settings for now; a year start
// belongs to a ledger, and moves there once settings have a per-ledger scope (docs/todo.md).
// See docs/ledger-compaction-design.md, "The Archiving page".
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import { LEDGER_ARCHIVE_SETTINGS, LEDGER_ARCHIVE_SETTINGS_PAGE, LEDGER_SETTINGS_PAGE } from '@tessera/ledger-api'

export interface ArchiveSettings {
  /** The month the year starts, 1 to 12. A calendar year starts in 1 (January). */
  yearStartMonth: number
  /** The day of that month, 1 up to the month's length; February stops at 28, so the start exists every year. */
  yearStartDay: number
  /** Whole years before the current one that the suggested date keeps in the ledger, 0 to 10. */
  keepYears: number
}

export const KEEP_YEARS_MAX = 10

/** The longest each month can be every year: February stops at 28. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

export const ARCHIVE_SETTINGS: SettingsDefinition<ArchiveSettings> = {
  id: LEDGER_ARCHIVE_SETTINGS,
  defaults: { yearStartMonth: 1, yearStartDay: 1, keepYears: 0 },
  validate: ({ yearStartMonth, yearStartDay, keepYears }) => [
    ...(whole(yearStartMonth, 1, 12) ? [] : ['The year starts in a month from 1 to 12.']),
    ...(whole(yearStartDay, 1, whole(yearStartMonth, 1, 12) ? MONTH_DAYS[yearStartMonth - 1] : 31) ? []
      : [`Month ${yearStartMonth} has days 1 to ${MONTH_DAYS[(yearStartMonth as number) - 1] ?? 31}${yearStartMonth === 2 ? ' (the 29th isn’t there every year)' : ''}.`]),
    ...(whole(keepYears, 0, KEEP_YEARS_MAX) ? [] : [`Keep from 0 to ${KEEP_YEARS_MAX} years.`])
  ]
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The date File › Archive Ledger… suggests: the most recent start of the year on or before `today` (local), moved back
 * `keepYears` years. With the defaults, 1 January of this year.
 */
export function suggestedArchiveDate(today: Date, settings: ArchiveSettings): string {
  const month = settings.yearStartMonth, day = settings.yearStartDay
  const startOf = (year: number) => `${year}-${pad(month)}-${pad(day)}`
  const now = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const year = startOf(today.getFullYear()) <= now ? today.getFullYear() : today.getFullYear() - 1
  return startOf(year - settings.keepYears)
}

/** The Archiving page, under Ledger. */
export const archiveSettingsPage: SettingsPageContribution = {
  id: LEDGER_ARCHIVE_SETTINGS_PAGE,
  parent: LEDGER_SETTINGS_PAGE,
  settings: LEDGER_ARCHIVE_SETTINGS,
  title: 'Archiving',
  description: 'The date Archive Ledger… suggests.',
  keywords: ['archive', 'archiving', 'year end', 'fiscal year', 'tax year', 'compact'],
  fields: [
    {
      kind: 'number', key: 'yearStartMonth', label: 'The year starts in month', min: 1, max: 12, integer: true,
      description: 'A calendar year starts in month 1 (January), on day 1. If you archive at the end of a tax or fiscal year, choose when it starts: month 4, day 6 for a UK tax year; month 7, day 1 for one starting in July.'
    },
    { kind: 'number', key: 'yearStartDay', label: 'On day', min: 1, max: 31, integer: true },
    {
      kind: 'number', key: 'keepYears', label: 'Also keep the last', min: 0, max: KEEP_YEARS_MAX, integer: true, unit: 'years',
      description: 'Archive Ledger… suggests archiving everything before the start of the current year. To keep the year before in the ledger too (for a tax return, say), keep 1.'
    }
  ]
}

/** The page, as a `[point, id, impl]` contribution like the ledger's others. */
export const archiveSettingsContribution = (): [string, string, unknown] =>
  [SETTINGS_PAGES_EXTENSION_POINT, LEDGER_ARCHIVE_SETTINGS_PAGE, archiveSettingsPage]
