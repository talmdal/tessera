// The Reports page (Tools › Options… › Reports, phase R4): the user's preferences, application-wide, in the `reports`
// namespace. What belongs to one saved report is in the ledger with it; the year start is the ledger's. Other plugins
// read these with `context.settings.read<ReportsSettings>(REPORTS_SETTINGS_ID)`. See docs/reporting-design.md,
// "The Reports page".

/** The settings namespace. */
export const REPORTS_SETTINGS_ID = 'reports'

/** Tools › Options… › Reports. */
export const REPORTS_SETTINGS_PAGE = 'reports.settings'

export interface ReportsSettings {
  /**
   * What a report opens on when the user hasn't chosen for it before: its definition's choice, or the table alone
   * ('table') where the definition would show the chart and the table.
   */
  openOn: 'both' | 'table'
  /** The rows kept before *Other*, where a definition's axis takes `top` from the user (`top: 'user'`). */
  topRows: number
}

export const REPORTS_SETTINGS_DEFAULTS: ReportsSettings = { openOn: 'both', topRows: 25 }

/** *Rows before "Other"*: the range the page takes. */
export const TOP_ROWS_MIN = 5
export const TOP_ROWS_MAX = 500

/**
 * *Show the top*, the customisation every report with a row axis keeping a top has (*Customise Report…*): kept with the
 * report's option values under this key, which no definition's option can have (theirs start with a letter). Its
 * value is a whole number as text ('12'), from 1 to `TOP_ROWS_MAX`, or 'all'.
 */
export const TOP_OPTION = '@top'
