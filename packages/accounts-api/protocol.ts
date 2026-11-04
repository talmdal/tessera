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

/** The `Migrator` for the accounts schema, named by its `ledger.schema` contribution. */
export const ACCOUNTS_MIGRATOR_SERVICE = 'accounts.migrator'

/** Current version of the accounts schema in a ledger. */
export const ACCOUNTS_SCHEMA_VERSION = 1

/** The collections in a ledger, all in schema version 1 (declaring a new collection needs no migration). */
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
  /** Opens the New Ledger dialog (`ledger.new`) with the selection as parent. */
  newSubLedger: 'accounts.subLedger.new',
  renameSubLedger: 'accounts.subLedger.rename',
  deleteSubLedger: 'accounts.subLedger.delete',
  /** Moves the selected account or sub-ledger. */
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
 * Optional argument of the account and sub-ledger commands: the item to act on. The commands are user actions: they
 * are enabled only while the navigator's selection makes them applicable (so the Accounts menu greys out to match),
 * and the navigator selects a row before running one on it. To change accounts from code, use `accounts.service`.
 */
export interface ItemArgs {
  id?: string
}

/** Optional argument of `accounts.account.new`: the sub-ledger to create it in (null: the ledger itself). */
export interface NewAccountArgs {
  subLedgerId?: string | null
}

export type SelectionKind = 'ledger' | 'subLedger' | 'account'

/** What the navigator has selected. The ledger itself has no id. */
export type Selection = { kind: 'ledger' } | { kind: 'subLedger' | 'account', id: string }

export const ACCOUNTS_CONTEXT_KEYS = {
  /** `SelectionKind`, or unset. */
  selectionKind: 'accounts.selection.kind',
  /** The selected sub-ledger or account (unset for the ledger). */
  selectionId: 'accounts.selection.id',
  /** The selected account is closed. */
  selectionIsClosed: 'accounts.selection.isClosed',
  /** Id of the account the register shows. */
  registerAccount: 'accounts.register.account',
  /** That account is open, and the ledger writable. */
  registerEditable: 'accounts.register.editable',
  /** Id of the register's account while it is being reconciled (not paused). */
  reconciling: 'accounts.reconciling',
  /** Id of the reconcile action that started it. */
  reconciler: 'accounts.reconciler'
} as const

const channel = (event: string) => channelFor(ACCOUNTS_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `AccountsResult`s. */
export const ACCOUNTS_CHANNELS = {
  /** `{ includeClosed? }` → `Chart`, or null when no ledger is open. */
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
  patchTransaction: channel('transaction.patch')
} as const

/** Push events, main → renderer. */
export const ACCOUNTS_EVENTS = {
  /** The whole `Chart`, or null when the ledger closed. */
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
  categories: channel('categories.changed')
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
  /** The ledger's reconciled balance, and when that was: the statement's starting balance, by default. */
  lastReconciled: { balance: number, date?: string }
  /** A reconciliation in progress, being resumed. */
  current?: StatementFigures
  /** For the service charge's and interest's category fields. */
  categories: Category[]
  /** The categories they start with (Bank fees; Interest, or Interest paid on a liability), when the ledger has them. */
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

/** `accounts:move`: moves an account or a sub-ledger to `to` (a sub-ledger id, or null for the ledger itself). */
export interface MoveRequest {
  kind: 'account' | 'subLedger'
  id: string
  to: string | null
}

/** The account dialog: a new account in `subLedgerId`, or the `account` to edit. */
export type AccountDialogInput = {
  /** The sub-ledgers it can go in. */
  subLedgers: Chart['subLedgers']
  ledgerName: string
  /** Suggested for a new account: the currency most accounts in the ledger use. */
  defaultCurrency: string
} & ({ mode: 'create', subLedgerId: string | null } | { mode: 'edit', account: Account })

/** The move dialog: what moves, and the sub-ledgers it can move to. */
export interface MoveDialogInput {
  item: { kind: 'account' | 'subLedger', id: string, name: string, parentId: string | null }
  subLedgers: Chart['subLedgers']
  ledgerName: string
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
