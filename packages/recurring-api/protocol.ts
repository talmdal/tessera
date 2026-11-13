// Every name the recurring plugin publishes: ids, collections, commands, context keys, IPC channels, events, views
// and dialogs. Both halves of the plugin, other plugins and the tests use these constants, never the strings.
import { channelFor } from '@tessera/types'
import type { Account, Category, Chart } from '@tessera/accounts-api'
import type { Holiday, RecurringRow, Series, SeriesTemplate } from './model'
import type { EnterRequest, SeriesInput, SeriesPatch } from './service'
import type { Schedule } from './schedule'

export const RECURRING_PLUGIN_ID = 'recurring'

/** The service other plugins require: `RecurringService`. */
export const RECURRING_SERVICE = 'recurring.service'

/** The `Migrator` for the recurring schema, named by its `book.schema` contribution. */
export const RECURRING_MIGRATOR_SERVICE = 'recurring.migrator'

/** Current version of the recurring schema in a book. */
export const RECURRING_SCHEMA_VERSION = 1

/** The collections in a book, all in schema version 1. */
export const RECURRING_COLLECTIONS = {
  series: 'recurring.series',
  postings: 'recurring.postings',
  holidays: 'recurring.holidays'
} as const

export const RECURRING_COMMANDS = {
  /** Reveals the Recurring view. */
  open: 'recurring.open',
  /** Argument (optional): `NewSeriesArgs`. Opens the series dialog. */
  new: 'recurring.series.new',
  /** Argument: `SeriesArgs`. */
  edit: 'recurring.series.edit',
  /** Argument: `SeriesArgs`. */
  delete: 'recurring.series.delete',
  /** Argument: `EnterArgs`. Opens the enter dialog, then writes what it returns. */
  enter: 'recurring.enter',
  /** Reveals the view and asks it to enter every overdue and due-today occurrence. */
  enterDue: 'recurring.enterDue',
  /** Argument: `SkipArgs`. */
  skip: 'recurring.skip',
  /** Argument: `SeriesArgs`. */
  pause: 'recurring.pause',
  /** Argument: `SeriesArgs`. */
  resume: 'recurring.resume',
  /** Argument: `TransactionActionArgs` (from @tessera/accounts-api). The register's row menu. */
  fromTransaction: 'recurring.fromTransaction',
  /** Opens the holidays dialog. */
  holidays: 'recurring.holidays',
  /**
   * Argument: `RegisterFigureArgs` (from @tessera/accounts-api). Returns a `RegisterFigure`: the account's balance
   * after everything due in the next `DEFAULT_HORIZON_DAYS` days, or undefined when nothing is scheduled for it.
   * The register shows it through `accounts.register.figures`.
   */
  projectBalance: 'recurring.projectBalance'
} as const

/** Optional argument of `recurring.series.new`: the account to start the dialog on. */
export interface NewSeriesArgs {
  accountId?: string
}

/** Argument of the commands that act on series. */
export interface SeriesArgs {
  ids: string[]
}

/** Argument of `recurring.enter`: which occurrences, or already-filled requests from the dialog. */
export interface EnterArgs {
  ids?: string[]
  requests?: EnterRequest[]
}

export interface SkipArgs {
  ids: string[]
  /** How many occurrences to pass over; default 1. `row.dueCount` clears everything due to today. */
  count?: number
}

export const RECURRING_CONTEXT_KEYS = {
  /** Number of overdue series. Falsy at 0, which is how `when` tests it (the grammar has no `>`). */
  overdueCount: 'recurring.overdue.count',
  /** The finished phrase, e.g. "3 transactions overdue": a bar item interpolates but can't pluralise. */
  overdueSummary: 'recurring.overdue.summary',
  /** Overdue plus due today. */
  dueCount: 'recurring.due.count',
  /** The book has at least one series. */
  hasSeries: 'recurring.hasSeries'
} as const

const channel = (event: string) => channelFor(RECURRING_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `RecurringResult`s. */
export const RECURRING_CHANNELS = {
  /** `{ includePaused?, includeEnded? }` → `RecurringSnapshot`, or null when no book is open. */
  snapshot: channel('snapshot'),
  /** `SaveSeriesRequest` → `RecurringResult<Series>`. Creates, or with `id`, edits. */
  saveSeries: channel('series.save'),
  /** `{ ids }` → `RecurringResult<void>`. */
  deleteSeries: channel('series.delete'),
  /** `{ ids, paused }` → `RecurringResult<void>`. */
  setPaused: channel('series.setPaused'),
  /** `{ requests, confirm? }` → `RecurringResult<EnterResult>`. */
  enter: channel('enter'),
  /** `{ ids, count? }` → `RecurringResult<void>`. */
  skip: channel('skip'),
  /** `{ seriesId, limit? }` → `Posting[]`. */
  history: channel('history'),
  /** `SaveFromTransactionRequest` → `RecurringResult<Series>`: a series made from a register's transaction. */
  createFromTransaction: channel('series.fromTransaction'),
  /** `{ from, to }` → `ForecastEntry[]`, or `[]` when no book is open. For the Upcoming panel. */
  forecast: channel('forecast'),
  /** → `Holiday[]`, or `[]` when no book is open. */
  holidays: channel('holidays'),
  /** `{ date, name }` → `RecurringResult<Holiday>`. */
  addHoliday: channel('holidays.add'),
  /** `{ id }` → `RecurringResult<void>`. */
  removeHoliday: channel('holidays.remove')
} as const

/** Push events, main → renderer. Each carries the whole new value, so a repeat is harmless. */
export const RECURRING_EVENTS = {
  /** `RecurringSnapshot`, or null when the book closed. */
  snapshot: channel('snapshot.changed'),
  /**
   * `{}`: Enter Due Transactions… from the menu. The view ticks everything overdue or due today and enters it,
   * so the result is reported where the user is looking — the same way the register handles New Transaction.
   */
  enterDue: channel('enterDue')
} as const

export const RECURRING_VIEWS = {
  /** The main-area list of everything that is coming, and what is late. */
  list: 'recurring.list',
  /** The right-bar panel: what falls due over the next few weeks, across every account. */
  upcoming: 'recurring.upcoming'
} as const

export const RECURRING_DIALOGS = {
  /** Input `SeriesDialogInput`, result `{ id }`. */
  series: 'recurring.dialog.series',
  /** Input `EnterDialogInput`, result `EnterRequest[]`. Shown before every entry. */
  enter: 'recurring.dialog.enter',
  /** Input `HolidaysDialogInput`, no result: it saves as it goes. */
  holidays: 'recurring.dialog.holidays'
} as const

/** The holidays dialog: what the book has, and today, so the form starts there. */
export interface HolidaysDialogInput {
  holidays: Holiday[]
  today: string
}

/** `recurring:series.save`: creates a series, or with `id`, edits it. */
export interface SaveSeriesRequest {
  id?: string
  input: SeriesInput
  expectedRev?: number
}

/**
 * `recurring:series.fromTransaction`: creates a series from what the dialog holds, recording `source` as its last
 * entry. `input` is the series as the user confirmed it, which may differ from the transaction it started as.
 */
export interface SaveFromTransactionRequest {
  input: SeriesInput
  source: { accountId: string, transactionId: string }
}

/** The series dialog: a new series, or the one to edit, with everything it needs to offer. */
export type SeriesDialogInput = {
  /** Open accounts, grouped by sub-book, as the chart gives them. */
  chart: Chart
  categories: Category[]
  /** Today, so the dialog's default start date matches the main process's idea of it. */
  today: string
  /** The book's holidays, so the preview moves dates the way the plugin will. */
  holidays: string[]
} & (
  | { mode: 'create', accountId?: string }
  | { mode: 'edit', series: Series }
  /** From a register row: the template and schedule are filled in, and the source transaction is already dated. */
  | { mode: 'fromTransaction', accountId: string, transactionId: string, template: SeriesTemplate, schedule: Schedule, sourceDate: string }
)

/** One row of the enter dialog: an occurrence about to be written, with what the user may change. */
export interface EnterDialogRow {
  row: RecurringRow
  /** Pre-filled: the occurrence's date, the template's amount, and the account's next cheque number. */
  request: EnterRequest
  /** The account's next cheque number, when the series asks for automatic numbering. */
  suggestedNumber?: string
}

/** The enter dialog: everything about to be written, every row editable. */
export interface EnterDialogInput {
  rows: EnterDialogRow[]
  /** The accounts involved, for their currencies and amount-column labels. */
  accounts: Account[]
}

export type { SeriesPatch }
