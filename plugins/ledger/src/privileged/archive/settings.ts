// The ledger's archive settings: namespace `ledger.archive`, on the Archiving page (Tools › Options… › Ledger ›
// Archiving). With the ledger's year start (File › Ledger Properties…), they choose the date File › Archive Ledger…
// suggests: the start of the ledger's current year, moved back by the years the user keeps.
// See docs/ledger-compaction-design.md, "The Archiving page", and docs/reporting-design.md, "The ledger's year start".
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import { LEDGER_ARCHIVE_SETTINGS, LEDGER_ARCHIVE_SETTINGS_PAGE, LEDGER_SETTINGS_PAGE, type YearStart } from '@tessera/ledger-api'

export interface ArchiveSettings {
  /**
   * The year start the Archiving page kept before each ledger had its own (ledger-api 1.5). No longer on the page: it
   * is now only what a ledger without a year start is given, when it is created or first opened, so upgrading changes
   * nothing anyone sees. The month, 1 to 12.
   */
  yearStartMonth: number
  /** That year start's day, 1 up to the month's length; February stops at 28, so the start exists every year. */
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
 * The date File › Archive Ledger… suggests: the most recent start of the ledger's year on or before `today` (local),
 * moved back `keepYears` years. For a calendar year, keeping none, 1 January of this year.
 */
export function suggestedArchiveDate(today: Date, yearStart: YearStart, keepYears: number): string {
  const { month, day } = yearStart
  const startOf = (year: number) => `${year}-${pad(month)}-${pad(day)}`
  const now = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const year = startOf(today.getFullYear()) <= now ? today.getFullYear() : today.getFullYear() - 1
  return startOf(year - keepYears)
}

/** The Archiving page, under Ledger. */
export const archiveSettingsPage: SettingsPageContribution = {
  id: LEDGER_ARCHIVE_SETTINGS_PAGE,
  parent: LEDGER_SETTINGS_PAGE,
  settings: LEDGER_ARCHIVE_SETTINGS,
  title: 'Archiving',
  description: 'The date Archive Ledger… suggests. It is the start of the ledger’s year, which each ledger keeps: set it in File › Ledger Properties… (a tax or fiscal year, say).',
  keywords: ['archive', 'archiving', 'year end', 'fiscal year', 'tax year', 'compact'],
  fields: [
    {
      kind: 'number', key: 'keepYears', label: 'Also keep the last', min: 0, max: KEEP_YEARS_MAX, integer: true, unit: 'years',
      description: 'Archive Ledger… suggests archiving everything before the start of the ledger’s current year. To keep the year before in the ledger too (for a tax return, say), keep 1.'
    }
  ]
}

/** The page, as a `[point, id, impl]` contribution like the ledger's others. */
export const archiveSettingsContribution = (): [string, string, unknown] =>
  [SETTINGS_PAGES_EXTENSION_POINT, LEDGER_ARCHIVE_SETTINGS_PAGE, archiveSettingsPage]
