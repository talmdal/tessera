// Every name the accounts plugin publishes: ids, collections, commands, context keys, IPC channels, events, views,
// dialogs and the reconciliation extension point.
import { channelFor } from '@tessera/types'
import type { Confirmation } from './errors'
import type { Account, AccountType, Category, Chart, ClearingStatus } from './model'
import type { StatementFigures } from './reconciliation'
import type { AccountInput } from './service'
import type { TransactionDraft, TransactionPatch } from './transactions'

export const ACCOUNTS_PLUGIN_ID = 'accounts'

/** The service other plugins require: `AccountsService`. */
export const ACCOUNTS_SERVICE = 'accounts.service'

/** The `Migrator` for the accounts schema, named by its `book.schema` contribution. */
export const ACCOUNTS_MIGRATOR_SERVICE = 'accounts.migrator'

/** Current version of the accounts schema in a book. */
export const ACCOUNTS_SCHEMA_VERSION = 1

/** The collections in a book, all in schema version 1 (declaring a new collection needs no migration). */
export const ACCOUNTS_COLLECTIONS = {
  accounts: 'accounts.accounts',
  transactions: 'accounts.transactions',
  payees: 'accounts.payees',
  categories: 'accounts.categories',
  reconciliations: 'accounts.reconciliations'
} as const

export const ACCOUNTS_COMMANDS = {
  newAccount: 'accounts.account.new',
  editAccount: 'accounts.account.edit',
  closeAccount: 'accounts.account.close',
  reopenAccount: 'accounts.account.reopen',
  deleteAccount: 'accounts.account.delete',
  /** Opens the New Book dialog (`book.new`) with the selection as parent. */
  newSubBook: 'accounts.subBook.new',
  renameSubBook: 'accounts.subBook.rename',
  deleteSubBook: 'accounts.subBook.delete',
  /** Moves the selected account or sub-book. */
  move: 'accounts.move',
  newTransaction: 'accounts.transaction.new',
  /** Reveals the home view. */
  open: 'accounts.open',
  /** Argument (optional): `ReconcileActionArgs`; else the register's account. Reconciles against a statement. */
  reconcileStatement: 'accounts.reconcile.statement',
  /** Argument (optional): `{ id }` of an account, else the selected account. Shows that account's register. */
  showRegister: 'accounts.register.show'
} as const

/**
 * Optional argument of the account and sub-book commands: the item to act on. The commands are user actions: they
 * are enabled only while the navigator's selection makes them applicable (so the Accounts menu greys out to match),
 * and the navigator selects a row before running one on it. To change accounts from code, use `accounts.service`.
 */
export interface ItemArgs {
  id?: string
}

/** Optional argument of `accounts.account.new`: the sub-book to create it in (null: the book itself). */
export interface NewAccountArgs {
  subBookId?: string | null
}

/**
 * The Accounts menu and its groups, published so another finance plugin can add an item to it without copying the
 * strings. Contribute to `shell.menus` with `parent: ACCOUNTS_MENU.id` and `group: ACCOUNTS_MENU.groups.<name>`;
 * the groups are declared by `accounts` itself, so the separators are drawn whether or not you are installed.
 */
export const ACCOUNTS_MENU = {
  id: 'accounts.menu',
  groups: {
    /** New, Edit, Close, Reopen, Delete Account. */
    account: 'accounts.menu.account',
    subBook: 'accounts.menu.subBook',
    move: 'accounts.menu.move',
    /** Open Register, New Transaction, Reconcile. */
    register: 'accounts.menu.register',
    /** Reserved for the `recurring` plugin's items; declared here so the separator exists without it. */
    recurring: 'accounts.menu.recurring'
  }
} as const

export type SelectionKind = 'book' | 'subBook' | 'account'

/** What the navigator has selected. The book itself has no id. */
export type Selection = { kind: 'book' } | { kind: 'subBook' | 'account', id: string }

export const ACCOUNTS_CONTEXT_KEYS = {
  /** `SelectionKind`, or unset. */
  selectionKind: 'accounts.selection.kind',
  /** The selected sub-book or account (unset for the book). */
  selectionId: 'accounts.selection.id',
  /** The selected account is closed. */
  selectionIsClosed: 'accounts.selection.isClosed',
  /** Id of the account the register shows. */
  registerAccount: 'accounts.register.account',
  /** That account is open, and the book writable. */
  registerEditable: 'accounts.register.editable',
  /** Id of the register's account while it is being reconciled (not paused). */
  reconciling: 'accounts.reconciling',
  /** Id of the reconcile action that started it. */
  reconciler: 'accounts.reconciler'
} as const

const channel = (event: string) => channelFor(ACCOUNTS_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `AccountsResult`s. */
export const ACCOUNTS_CHANNELS = {
  /** `{ includeClosed? }` → `Chart`, or null when no book is open. */
  chart: channel('chart'),
  /** → `Selection`. */
  selection: channel('selection'),
  /** `Selection` → void. The navigator reports what the user selected. */
  select: channel('select'),
  /** `SaveAccountRequest` → `AccountsResult<Account>`. */
  saveAccount: channel('account.save'),
  /** `MoveRequest` → `AccountsResult<void>`. */
  move: channel('move'),
  loadRegister: channel('register.load'),
  saveTransaction: channel('transaction.save'),
  deleteTransactions: channel('transaction.delete'),
  setStatus: channel('transaction.setStatus'),
  setVoided: channel('transaction.setVoided'),
  searchPayees: channel('payees.search'),
  categories: channel('categories.list'),
  /** `{ path, kind }` → `AccountsResult<Category>`. */
  createCategory: channel('categories.create'),
  /** → `{ accountId }`: the account the register shows, or null (the same shape as `register.changed`). */
  registerAccount: channel('register.account'),
  /** `{ accountId, scope }` → `ResolvedReconcileAction[]`, for the register's Reconcile menu and row menu. */
  reconcileActions: channel('reconcile.actions'),
  /** `{ accountId }` → `ReconcileState`, or null when none is in progress. */
  reconcileState: channel('reconcile.state'),
  /** `{ accountId, ids, marked }` → `AccountsResult<ReconcileState>`. */
  reconcileMark: channel('reconcile.mark'),
  /** `{ accountId, confirm? }` → `AccountsResult<ReconcileResult>`. */
  reconcileFinish: channel('reconcile.finish'),
  /** `{ accountId }` → `AccountsResult<void>`. */
  reconcilePause: channel('reconcile.pause'),
  /** `{ accountId }` → `AccountsResult<void>`. */
  reconcileCancel: channel('reconcile.cancel'),
  /** `{ accountId, id, patch, expectedRev?, confirm? }` → `AccountsResult<Transaction>`: changes only the fields given. */
  patchTransaction: channel('transaction.patch'),
  /** `{ accountId, count }` → `ResolvedTransactionAction[]`, for a register row's context menu. */
  transactionActions: channel('transaction.actions'),
  /** → `ResolvedNavigatorItem[]`: the rows other plugins add to the navigator. */
  navigatorItems: channel('navigator.items'),
  /** `{ accountId }` → `ResolvedRegisterFigure[]`: the figures other plugins add above the register. */
  registerFigures: channel('register.figures')
} as const

/** Push events, main → renderer. */
export const ACCOUNTS_EVENTS = {
  /** The whole `Chart`, or null when the book closed. */
  chart: channel('chart.changed'),
  /** `Selection`: what is selected, when a command changed it (a new account, say). */
  selection: channel('selection.changed'),
  /** `{ accounts: string[] }`: reload these registers. */
  transactions: channel('transactions.changed'),
  /** `{ accountId }`: the register should show this account. */
  register: channel('register.changed'),
  /** `{ accountId, state }`: the account's `ReconcileState`, or null when it has none in progress. */
  reconcile: channel('reconcile.changed'),
  /** `{}`: New Transaction from the menu; the register focuses its entry row. */
  newTransaction: channel('transaction.new'),
  /** `Category[]`: categories were added. */
  categories: channel('categories.changed'),
  /**
   * `ResolvedNavigatorItem[]`: the whole list again. Emitted when the value of a context key a contribution named
   * in `badgeKey` changes, so a badge stays live without the contributing plugin pushing anything of its own.
   */
  navigatorItems: channel('navigator.items.changed')
} as const

export const ACCOUNTS_VIEWS = {
  navigator: 'accounts.navigator',
  home: 'accounts.home',
  register: 'accounts.register',
  /** The left-bar panel while reconciling: the difference, and Pause, Cancel and Complete. */
  reconcile: 'accounts.reconcile'
} as const

export const ACCOUNTS_DIALOGS = {
  /** Input `AccountDialogInput`, result `{ id }`. */
  account: 'accounts.dialog.account',
  /** Input `MoveDialogInput`, result `{ to }`. */
  move: 'accounts.dialog.move',
  /** The statement's figures, service charge and interest. Input `ReconcileDialogInput`, result `StatementInput`. */
  reconcile: 'accounts.dialog.reconcile'
} as const

/** The statement dialog: the account, where its last reconciliation left it, and figures already entered. */
export interface ReconcileDialogInput {
  account: Account
  /** The book's reconciled balance, and when that was: the statement's starting balance, by default. */
  lastReconciled: { balance: number, date?: string }
  /** A reconciliation in progress, being resumed. */
  current?: StatementFigures
  /** For the service charge's and interest's category fields. */
  categories: Category[]
  /** The categories they start with (Bank fees; Interest, or Interest paid on a liability), when the book has them. */
  defaultCategories: { serviceCharge?: string, interest?: string }
}

/** The built-in reconciler's id in `accounts.reconcile.actions`. */
export const STATEMENT_RECONCILER = 'accounts.reconcile.statement'

/** A contribution as the register receives it: applicable to the account, with its command's enabled state. */
export interface ResolvedReconcileAction {
  id: string
  label: string
  scope: 'account' | 'transaction'
  command: string
  icon?: string
  description?: string
  enabled: boolean
}

/**
 * `accounts:account.save`: creates an account, or with `id`, edits it. `input` is the whole form: when editing, an
 * optional field it leaves out is cleared.
 */
export interface SaveAccountRequest {
  id?: string
  input: AccountInput
  expectedRev?: number
}

/** `accounts:transaction.save`: creates a transaction in `accountId`, or with `id`, edits it (the whole row). */
export interface SaveTransactionRequest {
  accountId: string
  id?: string
  draft: TransactionDraft
  expectedRev?: number
  confirm?: Confirmation[]
}

/** `accounts:transaction.delete`, `.setStatus` and `.setVoided`. */
export interface TransactionsRequest {
  accountId: string
  ids: string[]
  confirm?: Confirmation[]
  /** For `.setStatus`. */
  status?: ClearingStatus
  /** For `.setVoided`. */
  voided?: boolean
}

/** `accounts:transaction.patch`: changes only the fields `patch` gives (an amount corrected while reconciling, say). */
export interface PatchTransactionRequest {
  accountId: string
  id: string
  patch: TransactionPatch
  expectedRev?: number
  confirm?: Confirmation[]
}

/** `accounts:reconcile.*`. */
export interface ReconcileRequest {
  accountId: string
  /** For `.mark`. */
  ids?: string[]
  marked?: boolean
  /** For `.finish`. */
  confirm?: Confirmation[]
}

/** `accounts:move`: moves an account or a sub-book to `to` (a sub-book id, or null for the book itself). */
export interface MoveRequest {
  kind: 'account' | 'subBook'
  id: string
  to: string | null
}

/** The account dialog: a new account in `subBookId`, or the `account` to edit. */
export type AccountDialogInput = {
  /** The sub-books it can go in. */
  subBooks: Chart['subBooks']
  bookName: string
  /** Suggested for a new account: the currency most accounts in the book use. */
  defaultCurrency: string
} & ({ mode: 'create', subBookId: string | null } | { mode: 'edit', account: Account })

/** The move dialog: what moves, and the sub-books it can move to. */
export interface MoveDialogInput {
  item: { kind: 'account' | 'subBook', id: string, name: string, parentId: string | null }
  subBooks: Chart['subBooks']
  bookName: string
}

/** Extension point for `ReconcileActionContribution`s. */
export const RECONCILE_ACTIONS_POINT = 'accounts.reconcile.actions'

/**
 * A reconciliation option in the register. Plain data: behaviour lives in the command it names. Contributed with
 * `context.extensions.contribute(pluginId, RECONCILE_ACTIONS_POINT, id, contribution)`.
 */
export interface ReconcileActionContribution {
  /** `<pluginId>.<name>`. */
  id: string
  /** 'Balance Account…'. */
  label: string
  /**
   * 'account': in the register's Reconcile menu and the navigator's account context menu.
   * 'transaction': in a row's context menu, for the selected rows.
   */
  scope: 'account' | 'transaction'
  /** Run with one argument, `ReconcileActionArgs`. Its enablement decides whether the option is enabled. */
  command: string
  /** Shown only for these account types. Default: all. */
  accountTypes?: AccountType[]
  /** Tooltip. */
  description?: string
  /** A shell icon name, or a file in the plugin's renderer folder starting with `./`. */
  icon?: string
  order?: number
}

export interface ReconcileActionArgs {
  accountId: string
  /** For transaction-scope actions: the selected rows. */
  transactionIds?: string[]
}

// ---- Register row actions (`accounts.transaction.actions`)

/**
 * Extension point for `TransactionActionContribution`s: items in a register row's context menu. Prefer it to a
 * transaction-scope `ReconcileActionContribution`, which exists for reconcilers and is resolved into the same menu
 * for compatibility.
 */
export const TRANSACTION_ACTIONS_POINT = 'accounts.transaction.actions'

/**
 * An item in a register row's context menu. Plain data: behaviour lives in the command it names. Contributed with
 * `context.extensions.contribute(pluginId, TRANSACTION_ACTIONS_POINT, id, contribution)`.
 */
export interface TransactionActionContribution {
  /** `<pluginId>.<name>`. */
  id: string
  /** 'Make Recurring…'. */
  label: string
  /** Run with one argument, `TransactionActionArgs`. Its enablement decides whether the item is enabled. */
  command: string
  /** Shown only for these account types. Default: all. */
  accountTypes?: AccountType[]
  /** Shown only when exactly one row is selected. Default false. */
  singleOnly?: boolean
  /** Hidden while the account is closed, as most actions change something. Default true. */
  needsEditable?: boolean
  /** A shell icon name, or a file in the plugin's renderer folder starting with `./`. */
  icon?: string
  /** Tooltip. */
  description?: string
  order?: number
}

/** A contribution as the register receives it: applicable to the account and the selection, with its command's state. */
export interface ResolvedTransactionAction {
  id: string
  label: string
  command: string
  icon?: string
  description?: string
  enabled: boolean
}

export interface TransactionActionArgs {
  accountId: string
  /** The selected rows; at least one. */
  transactionIds: string[]
}

// ---- Register figures (`accounts.register.figures`)

/**
 * Extension point for `RegisterFigureContribution`s: figures another plugin adds beside the register's Current,
 * Cleared and Available balances — a projected balance, say.
 */
export const REGISTER_FIGURES_POINT = 'accounts.register.figures'

/**
 * A figure above the register. Plain data: the number comes from the command it names, run with
 * `RegisterFigureArgs` and returning a `RegisterFigure` (or nothing, when the figure doesn't apply to the account).
 */
export interface RegisterFigureContribution {
  /** `<pluginId>.<name>`. */
  id: string
  /** 'Projected (30 days)'. */
  label: string
  /** Run with one argument, `RegisterFigureArgs`; resolves a `RegisterFigure`, or undefined to show nothing. */
  command: string
  /** Shown only for these account types. Default: all. */
  accountTypes?: AccountType[]
  /** An event channel (`window.api.on`) after which the register asks the command again. */
  refreshOn?: string
  /** Tooltip. */
  description?: string
  order?: number
}

/** A contribution as the register receives it. */
export interface ResolvedRegisterFigure {
  id: string
  label: string
  command: string
  refreshOn?: string
  description?: string
  enabled: boolean
}

export interface RegisterFigureArgs {
  accountId: string
}

/** What a figure's command resolves with. */
export interface RegisterFigure {
  /** Minor units, signed like a balance. */
  minor: number
  currency: string
  /** A line under the figure: 'after 3 scheduled payments'. */
  detail?: string
}

// ---- Navigator rows (`accounts.navigator.items`)

/** Extension point for `NavigatorItemContribution`s: rows another plugin adds to the Accounts navigator. */
export const NAVIGATOR_ITEMS_POINT = 'accounts.navigator.items'

export type NavigatorItemPlacement = 'top' | 'bottom'
export type NavigatorBadgeTone = 'default' | 'warning' | 'error'

/**
 * A row in the Accounts navigator, above the book or below the whole tree. It runs a command and never becomes the
 * navigator's `Selection`, so the Accounts menu's enablement is unaffected by it.
 */
export interface NavigatorItemContribution {
  /** `<pluginId>.<name>`. */
  id: string
  label: string
  /** Run with no argument when the row is clicked, or Enter is pressed on it. */
  command: string
  /** A shell icon name, or a file in the plugin's renderer folder starting with `./`. */
  icon?: string
  /** Default 'bottom'. */
  placement?: NavigatorItemPlacement
  /**
   * A context key whose value is shown as a badge while it is truthy. The navigator re-reads it whenever it
   * changes, so a count stays live without the contributing plugin pushing anything.
   */
  badgeKey?: string
  /** Default 'default'. */
  badgeTone?: NavigatorBadgeTone
  /** Tooltip. */
  description?: string
  order?: number
}

/** A contribution as the navigator receives it, with its command's state and its badge resolved. */
export interface ResolvedNavigatorItem {
  id: string
  label: string
  command: string
  icon?: string
  placement: NavigatorItemPlacement
  badgeTone: NavigatorBadgeTone
  description?: string
  enabled: boolean
  /** The badge's text now, when `badgeKey` is set and its value is truthy. */
  badge?: string
}
