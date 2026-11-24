// The Reports page (Tools › Options… › Reports, phase R4): the user's preferences, application-wide, in the `reports`
// namespace, on a page the shell draws. Small on purpose: what belongs to one saved report is in the ledger with it,
// and a report's period, accounts and options are in its heading and *Customise Report…*. See docs/reporting-design.md,
// "The Reports page".
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import {
  REPORTS_SETTINGS_DEFAULTS, REPORTS_SETTINGS_PAGE, TOP_ROWS_MAX, TOP_ROWS_MIN, type ReportsSettings
} from '@tessera/reports-api'

const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

export const REPORTS_SETTINGS: SettingsDefinition<ReportsSettings> = {
  defaults: { ...REPORTS_SETTINGS_DEFAULTS },
  validate: s => [
    ...(s.openOn === 'both' || s.openOn === 'table' ? [] : ['Open reports on the chart and table, or the table only.']),
    ...(whole(s.topRows, TOP_ROWS_MIN, TOP_ROWS_MAX) ? [] : [`Show ${TOP_ROWS_MIN} to ${TOP_ROWS_MAX} rows before Other.`])
  ]
}

export const SETTINGS_PAGE: SettingsPageContribution = {
  id: REPORTS_SETTINGS_PAGE,
  title: 'Reports',
  description: 'What reports open on, and how many rows a report by size shows before the rest as Other.',
  keywords: ['reports', 'chart', 'table', 'other', 'top', 'rows', 'payees', 'categories'],
  fields: [
    {
      kind: 'choice', key: 'openOn', label: 'Open reports on',
      description: 'A report you have opened before opens as you left it.',
      options: [{ value: 'both', label: 'Chart and table' }, { value: 'table', label: 'Table only' }]
    },
    {
      kind: 'number', key: 'topRows', label: 'Rows before “Other”', min: TOP_ROWS_MIN, max: TOP_ROWS_MAX, integer: true, unit: 'rows',
      description: 'Reports that list payees or categories by size show this many, then the rest together as Other. Customise a report to change it for that report.'
    }
  ]
}

export const settingsContribution = (): [string, string, unknown] => [SETTINGS_PAGES_EXTENSION_POINT, SETTINGS_PAGE.id, SETTINGS_PAGE]
