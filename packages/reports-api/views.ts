// The reports plugin's UI (phase R3): its commands, context keys, views, dialog, IPC channels and events, and what the
// views and the dialog send and receive. Other plugins use the commands (`reports.show`, to open a report from
// elsewhere); the rest is for the plugin's own views. See docs/reporting-design.md, "The Reports tab and the report
// view", "The Reports menu, commands and context keys" and "IPC and events".
import { channelFor } from '@tessera/types'
import type { AccountType } from '@tessera/accounts-api'
import type { YearStart } from '@tessera/ledger-api'
import { REPORTS_PLUGIN_ID } from './protocol'
import type { ColumnDrill, RowDrill } from './result'
import type { ReportParameters, ReportRef } from './service'
import type { DrillResult, ScopeKind, SourceParameter, SourceTime } from './source'
import type { CompareOption, OptionValues } from './spec'

export const REPORTS_COMMANDS = {
  /** Reports › Show Reports: the Reports tab. */
  showList: 'reports.showList',
  /**
   * Shows a report in the report view, and reveals it. Argument: `ShowArgs`. Resolves true once shown, false when there
   * is no such report. Other plugins open a report with it (the budget view's *Budget vs Actual*).
   */
  show: 'reports.show',
  /** Reports › Refresh Report (F5 in the view): the report shown, worked out again. */
  refresh: 'reports.refresh',
  /** The transactions behind a figure, in a dialog. Argument: `TransactionsArgs`. */
  transactions: 'reports.transactions',
  /** Reports › Customise Report…: the report shown's options, *Show the top* and *Open on*. Nothing is saved. (R4.) */
  customise: 'reports.customise',
  /** Reports › Save Report: the saved report shown, as it is shown now. (R4.) */
  save: 'reports.save',
  /** Reports › Save Report As…: the report shown, under a new name, in the ledger; then shown. (R4.) */
  saveAs: 'reports.saveAs',
  /** Rename… a saved report. Argument (optional): `{ id }`; else the saved report shown. (R4.) */
  rename: 'reports.saved.rename',
  /** Duplicate… a saved report, under a new name; then shown. Argument (optional): `{ id }`. (R4.) */
  duplicate: 'reports.saved.duplicate',
  /** Delete… a saved report, after a confirmation. Argument (optional): `{ id }`. (R4.) */
  deleteSaved: 'reports.saved.delete',
  /** Reports › Export Report…: the table shown, to a CSV file the user names. Resolves true once written. (R6.) */
  exportCsv: 'reports.exportCsv',
  /** Reports › Print Report… (Ctrl+P): the report shown, through the system's print dialog. Resolves true once printed. (R6.) */
  print: 'reports.print',
  /** Reports › Save Report as PDF…: the report shown, printed to a PDF file the user names. Resolves true once written. (R6.) */
  savePdf: 'reports.savePdf'
} as const

/** The command a definition is mirrored into, for its item in the Reports menu: `reports.show.<definition id>`. */
export const showCommandOf = (definitionId: string) => `${REPORTS_COMMANDS.show}.${definitionId}`

/** Argument of `reports.show`: which report, and (optionally) parameters over what it would start with. */
export type ShowArgs = ReportRef & { parameters?: ReportParameters }

export const REPORTS_CONTEXT_KEYS = {
  /** The id of the definition or saved report the view shows, or unset. */
  shown: 'reports.shown',
  /** A saved report is shown. */
  shownSaved: 'reports.shownSaved',
  /** The open ledger has saved reports. */
  hasSaved: 'reports.hasSaved',
  /** The saved report shown differs from what was saved: its parameters, options or what it shows. (R4.) */
  changed: 'reports.changed'
} as const

export const REPORTS_VIEWS = {
  /** The left bar: the reports offered, by group, and the ledger's saved reports. */
  list: 'reports.list',
  /** The main area: one report. */
  view: 'reports.view'
} as const

export const REPORTS_DIALOGS = {
  /** The transactions behind a figure. Input `TransactionsDialogInput`; no result. */
  transactions: 'reports.dialog.transactions',
  /** Customise Report…. Input `CustomiseDialogInput`, result `CustomiseResult`. (R4.) */
  customise: 'reports.dialog.customise',
  /** Save Report As…, Rename… and Duplicate…: a name. Input `SaveDialogInput`, result `{ id }`. (R4.) */
  save: 'reports.dialog.save'
} as const

/** The Reports menu, on the menu bar after Budget. Each group of reports is a submenu of it. */
export const REPORTS_MENU = 'reports.menu'

/** The Reports tab's icon: a standard icon. */
export const REPORTS_ICON = 'ShowChart'

const channel = (event: string) => channelFor(REPORTS_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `ReportsResult`s. */
export const REPORTS_CHANNELS = {
  /** → `ReportsCatalog`, or null while no ledger is open. */
  catalog: channel('catalog'),
  /** `{ ref }` → `ReportsResult<OpenedView>`: what the heading needs to show a report. */
  open: channel('open'),
  /** `RunArgs` → `ReportsResult<ReportResult>`. */
  run: channel('run'),
  /** `MembersArgs` → `ReportsResult<Member[]>`: a picker's choices (Category Trends' categories). */
  members: channel('members'),
  /** `RunArgs` → void: what the view shows, for the commands and context keys. */
  select: channel('select'),
  /** `SaveArgs` → `ReportsResult<SavedReport>`: the report shown, saved under a name (Save Report As…). (R4.) */
  save: channel('saved.save'),
  /** `{ id, name, expectedRev? }` → `ReportsResult<SavedReport>`. (R4.) */
  rename: channel('saved.rename'),
  /** `{ id, name }` → `ReportsResult<SavedReport>`: the copy. (R4.) */
  duplicate: channel('saved.duplicate'),
  /**
   * `PrintReady` → `ReportsResult<boolean>`: the view has drawn the report in its print area (or says why it can't);
   * the plugin prints the window it came from, or writes the PDF, and replies once done (true) or cancelled (false).
   * The view keeps its print area until the reply. (R6.)
   */
  printReady: channel('print.ready')
} as const

/** Push events, main → renderer. */
export const REPORTS_EVENTS = {
  /** `ReportsCatalog`, or null: what is offered and saved, and what the view is to show. Sent only when it changed. */
  catalog: channel('catalog.changed'),
  /**
   * `StaleEvent`: figures from these sources may have changed; the report shown runs again if it is on one (a hidden
   * view, when next shown). Debounced: at most one every `REFRESH_DEBOUNCE_MS`.
   */
  stale: channel('stale'),
  /** `PrintRequest`: Print Report… or Save Report as PDF…; the view draws the report in its print area, then says so. (R6.) */
  print: channel('print.requested')
} as const

/** `reports:print.requested`. (R6.) */
export interface PrintRequest {
  /** Which request this is: the view's `PrintReady` names it. */
  request: number
  output: 'print' | 'pdf'
}

/** `reports:print.ready`: the report is in the print area, on a page of this orientation; or it can't be. (R6.) */
export type PrintReady =
  | { request: number, landscape: boolean }
  | { request: number, problem: string }

/** `reports:stale`. */
export interface StaleEvent {
  /** The sources whose figures may have changed; null for every one (another ledger, a new year start, Refresh). */
  sources: string[] | null
}

/** A group, as the Reports tab heads it. */
export interface CatalogGroup {
  id: string
  label: string
}

/** A report offered, as the Reports tab lists it. */
export interface CatalogDefinition {
  id: string
  label: string
  description: string
  icon?: string
  /** Its group's id. */
  group: string
  /** It can be shown now: its source's plugin is running and its `when` holds. */
  enabled: boolean
  /** Why not, when its source's plugin isn't running. */
  reason?: string
}

/** A saved report, as *My Reports* lists it. */
export interface CatalogSaved {
  id: string
  name: string
  /** What it was made from, for its tooltip: "Spending by Category". */
  basis: string
  /** False when its definition (or source) isn't offered; `reason` says which plugin it needs. */
  available: boolean
  reason?: string
}

/** What the Reports tab and the view follow. Null while no ledger is open. */
export interface ReportsCatalog {
  groups: CatalogGroup[]
  definitions: CatalogDefinition[]
  saved: CatalogSaved[]
  readOnly: boolean
  archive: boolean
  ledgerName: string
  /**
   * What the view is to show, as a command last asked: the report, and the parameters it was asked with; `request`
   * counts the requests, so asking for the report shown again (with other parameters) is seen. Null: nothing yet.
   */
  shown: {
    ref: ReportRef
    parameters?: ReportParameters
    /** Option values to show it with (Customise Report… applied, R4): over those it has. */
    options?: OptionValues
    /** What to show: chart, table or both (Customise Report…'s *Open on*, R4). */
    show?: 'chart' | 'table' | 'both'
    request: number
  } | null
  /** The saved report shown differs from what was saved, so *Save Report* has something to save (R4). */
  changed: boolean
}

/** A sub-ledger, for the heading's *Accounts*. */
export interface ChoiceSubLedger {
  id: string
  name: string
  parentId: string | null
  order: number
}

/** An account, for the heading's *Accounts*. */
export interface ChoiceAccount {
  id: string
  name: string
  type: AccountType
  subLedgerId: string | null
  currency: string
  closed: boolean
}

/** What the report view's heading needs to show a report: `reports:open`. */
export interface OpenedView {
  ref: ReportRef
  /** The definition's label, or the saved report's name. */
  title: string
  /** The definition's description; for a saved report, what it was made from. */
  description: string
  source: {
    id: string
    label: string
    time: SourceTime
    /** The scopes it takes; 'none' when it has its own. */
    scopes: ScopeKind[] | 'none'
    /** It reports in one currency, chosen by the user. */
    currency: boolean
    /** Its own parameters, offered in the heading. */
    parameters: SourceParameter[]
    drillDown: boolean
  }
  /** The option values it runs with (R4's Customise Report… changes them). */
  options: OptionValues
  /** The parameters to start with: the definition's (or saved report's), with *Accounts* carried from the last report. */
  parameters: ReportParameters
  /** What *Compare with* offers. */
  compareOptions: CompareOption[]
  /** The dimensions whose members the heading lets the user pick, with their labels. */
  choose: { dimension: string, label: string }[]
  /** The time axis's grain: what an as-of report's dates step by. */
  grain: 'month' | 'quarter' | 'year'
  /**
   * How it opens: chart, table or both (the saved report's choice, else the user's last for it, else the definition's,
   * or the table alone where the Reports page says so); and whether it has a chart at all.
   */
  show: 'chart' | 'table' | 'both'
  hasChart: boolean
  /** The rows it opens folded: the saved report's, or the user's last. (R4.) */
  collapsed: string[]
  /** What the view says when there is nothing to show. */
  emptyText?: string
  /** Said opening it (an option no longer offered). */
  notes: string[]
  /** The heading's choices: the ledger's tree and accounts, and the currencies in use. */
  choices: { ledgerName: string, subLedgers: ChoiceSubLedger[], accounts: ChoiceAccount[], currencies: string[] }
  /** Today and the ledger's year start, so the heading names periods as the run does. */
  today: string
  yearStart: YearStart
  readOnly: boolean
}

/** `reports:run` and `reports:select`. */
export interface RunArgs {
  ref: ReportRef
  parameters: ReportParameters
  options?: OptionValues
  /** With `select`: what the view shows, and the rows folded, to save or remember with the report. (R4.) */
  view?: ViewChoices
}

/** What a report's view shows: the chart, the table or both, and the rows folded. As `SavedReport.view`. (R4.) */
export interface ViewChoices {
  show?: 'chart' | 'table' | 'both'
  collapsed?: string[]
}

/** `reports:saved.save`: the report shown, as shown, saved under `name`. (R4.) */
export interface SaveArgs extends RunArgs {
  name: string
}

/** What a name dialog is for (R4): saving the report shown under a name, renaming a saved report, or copying one. */
export type SaveMode = 'saveAs' | 'rename' | 'duplicate'

export interface SaveDialogInput {
  mode: SaveMode
  /** What to save (saveAs): the report shown, as shown. */
  report?: SaveArgs
  /** The saved report renamed or copied, and its revision. */
  id?: string
  rev?: number
  /** The name to start with: the report's, or one not taken ("Spending by Category 2"). */
  name: string
  /** The names taken in the ledger, to say so as the user types. */
  taken: string[]
}

/** An option *Customise Report…* draws, with its value: the definition's own. (R4.) */
export interface CustomiseOption {
  key: string
  label: string
  description?: string
  kind: 'choice' | 'boolean'
  choices?: { value: string, label: string }[]
  default: string | boolean
  value: string | boolean
}

export interface CustomiseDialogInput {
  /** The report's title. */
  title: string
  options: CustomiseOption[]
  /** *Show the top*, when its rows keep a top: the value now, and what it would be left alone. */
  top?: { value: number | 'all', default: number | 'all' }
  /** *Open on*, when it has a chart. */
  show?: 'chart' | 'table' | 'both'
}

/** What *Customise Report…* closes with: the option values (*Show the top* among them, `TOP_OPTION`), and *Open on*. */
export interface CustomiseResult {
  options: OptionValues
  show?: 'chart' | 'table' | 'both'
}

/** `reports:members`. */
export interface MembersArgs {
  ref: ReportRef
  dimension?: string
  parameter?: string
  parameters: ReportParameters
}

/** Argument of `reports.transactions`: the report as run, and the figure's row and column. */
export interface TransactionsArgs extends RunArgs {
  row: RowDrill
  column: ColumnDrill
  /** The figure's currency: the row's, else the report's; absent when each account is in its own. */
  currency?: string
  /** For the dialog: the row's label, and the column's ("Groceries", "March 2026"). */
  label: string
  columnLabel: string
  /** The figure, as the report shows it: the dialog says how much of it is archived. */
  figure: number | null
}

export interface TransactionsDialogInput {
  /** "Groceries · March 2026". */
  title: string
  /** The report's currency, or the row's; null when each transaction is in its account's own. */
  currency: string | null
  figure: number | null
  result: DrillResult
}
