// Every name the reports plugin publishes, and its limits: ids, services, extension points, collections, the shipped
// sources' ids, and the limits every run is held to. See docs/reporting-design.md, "The contract".
import type { AccountType } from '@tessera/accounts-api'

export const REPORTS_PLUGIN_ID = 'reports'

/** The service other plugins require: `ReportsService`. */
export const REPORTS_SERVICE = 'reports.service'

/** The `Migrator` for the reports schema, named by its `ledger.schema` contribution. */
export const REPORTS_MIGRATOR_SERVICE = 'reports.migrator'

/** Where plugins contribute data sources (`ReportSourceContribution`), each naming a `ReportSource` service. */
export const REPORT_SOURCES_POINT = 'reports.sources'

/** Where plugins contribute report definitions (`ReportDefinitionContribution`): plain data. */
export const REPORT_DEFINITIONS_POINT = 'reports.definitions'

/** Where plugins contribute groups (`ReportGroupContribution`): headings in the Reports tab, submenus of the menu. */
export const REPORT_GROUPS_POINT = 'reports.groups'

/** Current version of the reports schema in a ledger. */
export const REPORTS_SCHEMA_VERSION = 1

/** Current version of `ReportSpec`. A saved spec of an earlier version is brought up to date by `migrateSpec`. */
export const REPORT_SPEC_VERSION = 1

/** The collections in a ledger. */
export const REPORTS_COLLECTIONS = {
  /** The user's saved reports (`SavedReport`). */
  saved: 'reports.saved'
} as const

/** The reports plugin's own sources and groups, which its seven definitions use. Other plugins may use them too. */
export const FLOWS_SOURCE = 'reports.flows'
export const BALANCES_SOURCE = 'reports.balances'
export const REPORT_GROUPS = {
  /** Income and Spending. */
  spending: 'reports.group.spending',
  /** Net Worth and Balances. */
  balances: 'reports.group.balances'
} as const

/**
 * The everyday accounts: where money arrives and bills are paid. Cash Flow's default scope. Cash isn't one (review, Q6):
 * a withdrawal into a wallet is money out of the everyday accounts.
 */
export const EVERYDAY_ACCOUNT_TYPES: readonly AccountType[] = ['chequing', 'savings', 'creditCard', 'lineOfCredit']

// ---- Limits (R-22): a report says it reached one, rather than hanging

/** Rows a result keeps; past it, the first that fit and a note. */
export const REPORT_ROWS_MAX = 5_000
/** Series a chart draws; past it, the smallest gathered as Other. */
export const REPORT_SERIES_MAX = 12
/** Slices a donut draws, Other included. */
export const REPORT_SLICES_MAX = 8
/** Columns of a time axis: ten years of months, or quarters, or years. */
export const REPORT_COLUMNS_MAX = 120
/** Rows × figures: past it, the top rows that fit, and a note (R0: every payee by month took 5 to 6 s to draw). */
export const REPORT_CELLS_MAX = 25_000
/** Dates one balances report takes: twenty years of month ends, as `accounts-api`'s `BALANCE_DATES_MAX`. */
export const REPORT_DATES_MAX = 240
/** Transactions Show Transactions lists behind one figure. */
export const DRILL_ROWS_MAX = 1_000
/** How long a source has to answer one query. */
export const SOURCE_TIMEOUT_MS = 10_000
/** How long changes are gathered before a shown report runs again. */
export const REFRESH_DEBOUNCE_MS = 250
/** Sub-ledgers side by side: at most this many columns, the scope's own included. */
export const SUB_LEDGER_COLUMNS_MAX = 12
/** A row axis keeps at most this many rows before *Other* (`Axis.top`). */
export const TOP_MAX = 5_000
/** The most characters of a saved report's notes. */
export const SAVED_NOTES_MAX_LENGTH = 2000
