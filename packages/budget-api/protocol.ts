// Every name the budget plugin publishes, and its limits: ids, collections, commands, context keys, views, dialogs, IPC
// channels and events, and what the views and dialogs send and receive.
import { channelFor } from '@tessera/types'
import type { TreeNode } from '@tessera/ledger-api'
import type {
  Budget, BudgetInput, BudgetLine, BudgetPeriod, LineGroup, LineInput, LineTarget, MonthRange, PlanChange, StatusRowKind
} from './model'

export const BUDGET_PLUGIN_ID = 'budget'

/** The service other plugins require: `BudgetService`. */
export const BUDGET_SERVICE = 'budget.service'

/** The `Migrator` for the budget schema, named by its `ledger.schema` contribution. */
export const BUDGET_MIGRATOR_SERVICE = 'budget.migrator'

/** Current version of the budget schema in a ledger. */
export const BUDGET_SCHEMA_VERSION = 1

/** The collections in a ledger. */
export const BUDGET_COLLECTIONS = {
  budgets: 'budget.budgets',
  lines: 'budget.lines',
  /** One document per account and month: what archives removed, totalled, so past actuals don't change. */
  archivedMonths: 'budget.archivedMonths'
} as const

/**
 * The largest amount a plan may have, in minor units (a billion at two digits), so every total stays a safe integer:
 * 500 lines × 106 times due in 24 months × 10¹¹ = 5.3 × 10¹⁵ (docs/budget-design.md, "Lines and plans").
 */
export const BUDGET_AMOUNT_MAX = 10 ** 11

/** The most lines a budget may have. */
export const BUDGET_LINES_MAX = 500

/** The most months one status covers. */
export const STATUS_MONTHS_MAX = 24

/** The most characters of a budget's or a line's notes. */
export const BUDGET_NOTES_MAX_LENGTH = 2000

/** An expense line warns once its spending reaches this share of its budget, unless the caller says otherwise. */
export const DEFAULT_WARN_AT_PERCENT = 90

// ---- The budget's UI (phase B3): commands, context keys, views, dialogs, channels and events

export const BUDGET_COMMANDS = {
  /** Budget › New Budget…. */
  newBudget: 'budget.new',
  /** Budget › Show Budget. Argument (optional): `{ id }`; else the budget shown last. Reveals the budget view. */
  show: 'budget.show',
  /** Budget › Budget Properties…. Argument (optional): `{ id }`; else the budget shown. */
  properties: 'budget.properties',
  /** Budget › Delete Budget…, after a confirmation. Argument (optional): `{ id }`; else the budget shown. */
  deleteBudget: 'budget.delete',
  /** Budget › Duplicate Budget…: a copy under a new name, then shown. Argument (optional): `{ id }`; else the budget shown. */
  duplicate: 'budget.duplicate',
  /** Budget › Fill from History…: lines from the months before. Argument (optional): `{ id }`; else the budget shown. */
  fillFromHistory: 'budget.fillFromHistory',
  /** Budget › New Line…. Argument (optional): `NewLineArgs`. */
  newLine: 'budget.line.new',
  /** Budget › Edit Line…. Argument (optional): `{ id }` of a line; else the line selected in the view. */
  editLine: 'budget.line.edit',
  /** Budget › Delete Line, after a confirmation. Argument (optional): `{ id }`; else the line selected. */
  deleteLine: 'budget.line.delete',
  /** The transactions behind a row's actual, in a dialog. Argument: `TransactionsArgs`. */
  transactions: 'budget.transactions',
  /**
   * The budget shown, over the months shown, as the Budget vs Actual report, in the report view (R5). Argument
   * (optional): `{ id }`; else the budget shown. Does nothing (false) without the reports plugin.
   */
  showReport: 'budget.showReport'
} as const

/**
 * What the budget plugin adds to the reports (reporting-design.md, "7. Budget vs Actual"): its source over
 * `budget.service.status`, the service behind it, the Budgets group, and the Budget vs Actual report. Contributed to
 * the reports plugin's points; nothing of the budget needs the reports plugin to be there.
 */
export const BUDGET_REPORTS = {
  /** The source: budgets' lines and their budget, actual and remaining, by month. */
  source: 'budget.status',
  /** The `ReportSource` service behind it. */
  service: 'budget.reportSource',
  /** The Budgets group: a heading in the Reports tab, a submenu of the Reports menu. */
  group: 'budget.group',
  /** Budget vs Actual. */
  vsActual: 'budget.vsActual'
} as const

/** Optional argument of the budget and line commands: what to act on. */
export interface BudgetItemArgs {
  id?: string
}

/** Optional argument of `budget.line.new`: what the line is for (the view's *Other* rows and categories with no line). */
export interface NewLineArgs {
  target?: LineTarget
}

/** What a status row is, to find it again: the row's kind and group, and its line, category or account. */
export interface RowRef {
  kind: StatusRowKind
  group: LineGroup
  lineId?: string
  categoryId?: string
  accountId?: string
}

/** Argument of `budget.transactions`. */
export interface TransactionsArgs {
  budgetId: string
  row: RowRef
  months: MonthRange
  /** For the dialog: the row's label, and the period as the view names it. */
  label: string
  period: string
}

export const BUDGET_CONTEXT_KEYS = {
  /** The open ledger has at least one budget. */
  hasBudgets: 'budget.hasBudgets',
  /** The id of the budget the view shows, or unset. */
  shown: 'budget.shown',
  /** The id of the line selected in the view (not a subtotal, Other or Uncategorised row), or unset. */
  lineSelected: 'budget.line.selected',
  /**
   * "Budget: 2 lines over" (or "1 line over") while the budget shown has expense lines over budget in the current month,
   * and the Budget page's *Show lines over budget in the status bar* is on; unset otherwise. For the status bar.
   */
  statusText: 'budget.statusText',
  /** Which lines, and by how much: "Household, March 2027: Food (other) 113.85 over, …". The status item's tooltip. */
  statusDetail: 'budget.statusDetail'
} as const

export const BUDGET_VIEWS = {
  /** The main area: one budget, month by month. */
  view: 'budget.view',
  /** The left bar: the ledger's budgets. */
  list: 'budget.list'
} as const

export const BUDGET_DIALOGS = {
  /** New Budget… and Budget Properties…. Input `BudgetDialogInput`, result `{ id }`. */
  budget: 'budget.dialog.budget',
  /** New Line… and Edit Line…. Input `LineDialogInput`, result `{ id }`. */
  line: 'budget.dialog.line',
  /** The transactions behind an actual. Input `TransactionsDialogInput`; no result. */
  transactions: 'budget.dialog.transactions',
  /** Fill from History. Input `HistoryDialogInput`, result `{ count }`: the lines filled. */
  history: 'budget.dialog.history',
  /** Duplicate Budget…: the copy's name. Input `DuplicateDialogInput`, result `{ id }` of the copy. */
  duplicate: 'budget.dialog.duplicate'
} as const

/** The Budgets tab's icon, registered through `shell.icons`. */
export const BUDGET_ICON = 'budget.pie'

const channel = (event: string) => channelFor(BUDGET_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `BudgetResult`s. */
export const BUDGET_CHANNELS = {
  /** → `BudgetsView`, or null when no ledger is open. */
  budgets: channel('budgets'),
  /** `StatusRequest` → `BudgetResult<BudgetStatus>`. */
  status: channel('status'),
  /** `SaveBudgetRequest` → `BudgetResult<Budget>`. */
  saveBudget: channel('budget.save'),
  /** `AddLineRequest` → `BudgetResult<BudgetLine>`. */
  addLine: channel('line.add'),
  /** `ChangeLineRequest` → `BudgetResult<BudgetLine>`: a plan, one month's amount, the notes, or several at once. */
  changeLine: channel('line.change'),
  /** `{ lineId }` → `BudgetResult<BudgetLine>`: the line as it is now (the Budget Line dialog, after a conflict). */
  line: channel('line'),
  /** `ViewReport` → void. The view reports what it shows and what is selected, for the commands and context keys. */
  select: channel('select'),
  /** `{ path, kind }` → `BudgetResult<Category>`: a category made from the Budget Line dialog. */
  createCategory: channel('category.create'),
  /** `SuggestRequest` → `BudgetResult<LineSuggestion[]>`: Fill from History's list. Reads only. */
  suggest: channel('suggest'),
  /** `FillRequest` → `BudgetResult<BudgetLine[]>`: every line ticked, or none. */
  fill: channel('fill'),
  /** `DuplicateRequest` → `BudgetResult<Budget>`: the copy. */
  duplicate: channel('budget.duplicate'),
  /** `Partial<ViewOptions>` → void: the view's *More* menu changes the Budget page's view settings. */
  viewOptions: channel('view.options')
} as const

/** Push events, main → renderer. */
export const BUDGET_EVENTS = {
  /** `BudgetsView`, or null when the ledger closed: the budgets, and which one the view shows. */
  budgets: channel('budgets.changed'),
  /**
   * `{ budgetId }`: reload this budget's status; `budgetId: null`, every budget's (transactions changed). Debounced:
   * at most one every `STATUS_DEBOUNCE_MS`.
   */
  status: channel('status.changed'),
  /** `{ budgetId, lineId }`: a command added or changed this line; the view selects it. */
  line: channel('line.selected')
} as const

/** How long the plugin gathers changes to actuals before telling the views (an import is one refresh, not 300). */
export const STATUS_DEBOUNCE_MS = 250

/** A budget as the Budgets tab and the view's heading show it. */
export interface BudgetSummary extends Budget {
  /** What it covers, for people: 'Personal and its sub-ledgers', 'The whole ledger'. */
  covers: string
}

/** What the view and the tab show: the budgets, and which one. Null while no ledger is open. */
export interface BudgetsView {
  budgets: BudgetSummary[]
  /** The budget the view shows: the one shown last in this ledger, else the first; null when there is none. */
  shown: string | null
  /** 'YYYY-MM': the month the view shows (the current month, until the user moves). */
  month: string
  /** One month, the year to date, or the whole budget year month by month. */
  period: BudgetPeriod
  /** The ledger is open read-only (an archive file): nothing offers to change it. */
  readOnly: boolean
  /** The ledger is an archive file. */
  archive: boolean
  ledgerName: string
  /** How the view draws, from the Budget page. */
  options: ViewOptions
  /** The reports plugin is there, so the budget can be shown as a report (R5). */
  reports: boolean
}

/** The Budget page's settings the view draws by. */
export interface ViewOptions {
  /** The bars beside each line. */
  showBars: boolean
  /** Rows with neither budget nor actual in the period. */
  showEmptyLines: boolean
}

/** `budget:status`. */
export interface StatusRequest {
  budgetId: string
  months: MonthRange
  /** Each row's figures month by month as well: the year grid. */
  byMonth?: boolean
}

/** `budget:select`: what the view shows, and the line selected (none for a subtotal, Other or Uncategorised). */
export interface ViewReport {
  budgetId: string
  month: string
  period: BudgetPeriod
  lineId?: string
}

/** `budget:budget.save`: creates a budget, or with `id`, changes it (the whole form). */
export interface SaveBudgetRequest {
  id?: string
  input: BudgetInput
  expectedRev?: number
}

/** `budget:line.add`. */
export interface AddLineRequest {
  budgetId: string
  input: LineInput
}

/** `budget:line.change`: a change to the plan (or one month), and the notes (null clears them), each when given. */
export interface ChangeLineRequest {
  lineId: string
  change?: PlanChange
  notes?: string | null
  expectedRev?: number
}

/** An account in a budget's dialogs: enough to work out what a scope covers and in which currency. */
export interface ScopeAccount {
  id: string
  name: string
  subLedgerId: string | null
  currency: string
  closed: boolean
}

/** New Budget… (no `budget`) and Budget Properties…. */
export interface BudgetDialogInput {
  budget?: Budget
  ledgerName: string
  subLedgers: TreeNode[]
  accounts: ScopeAccount[]
  /** What the tab had selected, for a new budget's *Covers*: a sub-ledger, or null for the whole ledger. */
  subLedgerId: string | null
  /** A new budget's year start: the Archiving page's. */
  yearStartMonth: number
  /** When no account suggests one. */
  defaultCurrency: string
  /** Budget Properties…: how many lines the budget has (a currency with other decimals is refused while it has any). */
  lineCount?: number
  /** Budget Properties…: its transfer lines, whose account a new scope or currency could leave counting nothing. */
  transferLines?: { accountId: string, label: string }[]
}

/** Something a new line can be for, as the *For* field lists it. */
export interface TargetChoice {
  target: LineTarget
  group: LineGroup
  /** 'Food : Groceries', 'Transfers from: Business Chequing'. */
  label: string
}

/** New Line… (no `line`) and Edit Line…. */
export interface LineDialogInput {
  budget: Budget
  /** 'YYYY-MM': the month the view shows: a new line's first month, and an edit's *From* and *only*. */
  month: string
  /** The line being changed, with what it is for. */
  line?: BudgetLine
  /** The line's, or the chosen target's, name and group. */
  label?: string
  group?: LineGroup
  /** For a new line: what it can be for (categories and accounts with no line yet), and what to start with. */
  choices?: TargetChoice[]
  target?: LineTarget
  /** The ledger can take a new category (it is writable). */
  canCreateCategory?: boolean
}

/** One transaction behind an actual, as the Transactions dialog lists it. */
export interface TransactionRow {
  transactionId: string
  accountId: string
  accountName: string
  date: string
  payee?: string
  /** 'Food : Groceries', 'Transfer from: Business Chequing'. */
  label?: string
  /** As it counts toward the row: spending for an expense row, money in for an income row (negative for a refund). */
  amount: number
}

export interface TransactionsDialogInput {
  /** The row's label: 'Groceries', 'Other expenses'. */
  row: string
  /** 'March 2027', 'Year to date, January to March 2027'. */
  period: string
  currency: string
  rows: TransactionRow[]
  /** Their total, and the row's actual: the actual less the total is what the archive holds. */
  total: number
  actual: number
  /** Of the actual, what came from archived months; with the last archive date, before which transactions were archived. */
  archived?: { amount: number, before?: string }
}

// ---- Fill from History and Duplicate Budget… (phase B4)

/** Fill from History's defaults until the Budget page sets them (phase B5): the months looked at, and the step. */
export const DEFAULT_HISTORY_MONTHS = 12
/** In whole units of the budget's currency: 10 is 10.00 in dollars, 10 in yen. */
export const DEFAULT_ROUND_TO = 10
/** The steps Fill from History rounds to, in whole units of the currency. */
export const ROUND_TO_CHOICES = [1, 5, 10, 50, 100] as const

/** `budget:suggest`: as `BudgetService.suggest`'s options, for a budget. `step` is in minor units. */
export interface SuggestRequest {
  budgetId: string
  months: number
  start: string
  step: number
}

/** `budget:fill`. */
export interface FillRequest {
  budgetId: string
  lines: LineInput[]
}

/** `budget:budget.duplicate`. */
export interface DuplicateRequest {
  id: string
  name: string
}

/** Fill from History: the budget, and where the list starts. */
export interface HistoryDialogInput {
  budget: Budget
  /** 'YYYY-MM': the month the lines start (the month the view shows); the history is the months before it. */
  start: string
  /** How many whole months to look at, 1 to `STATUS_MONTHS_MAX`. */
  months: number
  /** The step, in whole units of the budget's currency. */
  roundTo: number
}

/** Duplicate Budget…: the budget copied, and a name for the copy that isn't taken. */
export interface DuplicateDialogInput {
  budget: Budget
  name: string
}

/** What New Budget… closes with: the budget, and whether to fill it from history next. */
export interface BudgetDialogResult {
  id: string
  fill?: boolean
}

// ---- The Budget page (phase B5)

/** The settings namespace: the user's preferences, application-wide. What belongs to a budget is in the ledger with it. */
export const BUDGET_SETTINGS_ID = 'budget'

/** Tools › Options… › Budget. */
export const BUDGET_SETTINGS_PAGE = 'budget.settings'

/** The `budget` settings. Other plugins read them with `context.settings.read<BudgetSettings>(BUDGET_SETTINGS_ID)`. */
export interface BudgetSettings {
  /** *Warn at*: an expense line turns amber once its spending reaches this share of its budget, 50 to 100. */
  warnAtPercent: number
  /** Show the bars beside each line. */
  showBars: boolean
  /** Show lines with neither budget nor actual in the period. */
  showEmptyLines: boolean
  /** The months Fill from History looks at, 3 to 24. */
  historyMonths: number
  /** The step Fill from History rounds to, in whole units of the budget's currency: one of `ROUND_TO_CHOICES`. */
  roundTo: number
  /** Show "Budget: 2 lines over" in the status bar while the budget shown has lines over this month. */
  statusBar: boolean
}

export const BUDGET_SETTINGS_DEFAULTS: Readonly<BudgetSettings> = {
  warnAtPercent: DEFAULT_WARN_AT_PERCENT,
  showBars: true,
  showEmptyLines: false,
  historyMonths: DEFAULT_HISTORY_MONTHS,
  roundTo: DEFAULT_ROUND_TO,
  statusBar: true
}

/** The ranges the page allows. */
export const WARN_AT_PERCENT_MIN = 50
export const HISTORY_MONTHS_MIN = 3
