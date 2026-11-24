// The `accounts.service` service: the accounts of the open ledger, and the integrity boundary for them. Other
// plugins (reports, importers, budgets) read and change accounts through it, never through the collections.
//
// Methods that fail because of what the user did throw an `AccountsError` (test with `isAccountsError`) whose `code`
// says why, whose `field` names the input at fault, and, for CONFIRMATION_REQUIRED, whose `reasons` list what to
// confirm before calling again with `confirm`.
//
import type { Event } from '@tessera/types'
import type { Confirmation } from './errors'
import type {
  Account, AccountBalances, AccountClass, AccountType, ArchivedTotal, BalancePoint, BalanceQuery, Chart, RemovedAccount, TotalsQuery, TransactionTotal
} from './model'
import type { ReconciliationService } from './reconciliation'
import type { CategoryDirectory, PayeeDirectory, TransactionManager } from './transactions'

export interface WriteOptions {
  /** The write fails with CONFLICT unless the account is still at this revision. */
  expectedRev?: number
  /** Confirmations the caller has obtained from the user. */
  confirm?: Confirmation[]
}

/** What a form (or an importer) sends to create an account. */
export interface AccountInput {
  name: string
  type: AccountType
  /** The sub-ledger to put it in; null for the ledger itself. */
  subLedgerId: string | null
  /** ISO 4217, e.g. 'CAD'. */
  currency: string
  institution?: string
  accountNumber?: string
  /** OFX `BANKID`: letters and digits, at most `BANK_ID_MAX_LENGTH`. */
  bankId?: string
  /** QFX and QBO `INTU.BID`: at most `INTUIT_BANK_ID_MAX_LENGTH`. */
  intuitBankId?: string
  /** YYYY-MM-DD. */
  openingDate: string
  /** Signed, minor units: a liability's amount owed is negative. */
  openingBalance: number
  /** Minor units, not negative; credit cards and lines of credit only. */
  creditLimit?: number
  /** Minor units, not negative; asset accounts only. */
  minimumBalance?: number
  /** Show the balance less the minimum; needs a minimum balance. */
  showAvailableBalance?: boolean
  notes?: string
}

/**
 * An edit: only the fields given change, and `null` clears an optional one. Changing `subLedgerId` moves the account
 * to the end of that sub-ledger (use `moveAccount` to choose the position).
 */
export type AccountPatch = {
  [K in keyof AccountInput]?: undefined extends AccountInput[K] ? AccountInput[K] | null : AccountInput[K]
}

/** Which accounts `list` returns. Every condition given must hold. */
export interface AccountFilter {
  /** Accounts directly in this sub-ledger; null for those directly in the ledger. */
  subLedgerId?: string | null
  /** With `subLedgerId`: include the accounts of every sub-ledger beneath it too. */
  includeDescendants?: boolean
  types?: AccountType[]
  classes?: AccountClass[]
  /** ISO 4217 code. */
  currency?: string
  /** Default true: closed accounts are still accounts (reports need their history). */
  includeClosed?: boolean
  /**
   * Matches the account number ignoring spaces, dashes and case. `{ endsWith }` matches its last characters, as an
   * importer needs when a statement shows only the last four digits.
   */
  accountNumber?: string | { endsWith: string }
  /** The institution, ignoring case and surrounding spaces. */
  institution?: string
}

/** What a committed change touched. Events follow every change, after it is stored. */
export interface AccountsChange {
  created: string[]
  /** Changed, moved, closed or reopened. */
  updated: string[]
  deleted: string[]
  /** Accounts whose transactions changed (added, edited, deleted, cleared, voided). */
  transactions: string[]
  /** Accounts whose balances changed. */
  balances: string[]
  /** Categories were added. */
  categories: boolean
  /** Accounts whose reconciliation started, changed, paused, finished or was cancelled. */
  reconciliations: string[]
  /** Anything the chart shows changed: any of the above, or the ledger tree, or which ledger is open. */
  chart: boolean
}

/** The `accounts.service` service. Every method fails with NO_LEDGER while no ledger is open. */
export interface AccountsService {
  /** An account by id, or undefined. */
  get(id: string): Promise<Account | undefined>
  /** Accounts matching `filter`, in the order the navigator shows them. */
  list(filter?: AccountFilter): Promise<Account[]>
  /** The ledger tree with accounts and balances, and totals per currency. */
  chart(options?: { includeClosed?: boolean }): Promise<Chart>
  /** An account's balances, from its opening balance and its (non-voided) transactions. */
  balances(id: string): Promise<AccountBalances>
  /**
   * Totals of the transactions dated from `from` to `to`, inclusive, for reports and budgets: one row per account,
   * month, and category (or none), with money in and money out apart. Voided transactions are left out, every clearing
   * status is counted, and transfers are left out unless `includeTransfers`, when they are totalled by their other
   * account (`categoryId` null), both sides if both accounts are asked for. Only accounts that exist are counted,
   * closed ones included. Rows come in order of month, then account, then category or transfer account. (When there
   * are splits, each part will count by its own category.) Fails with INVALID, naming the field, for a date that isn't
   * YYYY-MM-DD, `from` after `to`, or `accountIds` that isn't a list of ids. (Since accounts-api 1.13.)
   */
  transactionTotals(query: TotalsQuery): Promise<TransactionTotal[]>
  /**
   * What archives removed, kept as totals since accounts-api 1.15, for the months from `from`'s to `to`'s, inclusive
   * (archived totals are kept by month): totalled as `transactionTotals` totals them, with the same filters, and with
   * where each account was (`currency`, `subLedgerId`, `transferSubLedgerId`) and its name (`accountName`) when it was
   * archived, since an archive may remove the account. With `byPayee`, categorised and uncategorised rows are by payee;
   * transfers aren't kept by payee (their `payeeId` is null). Never overlaps `transactionTotals`: a transaction is
   * either still in the ledger or archived. Empty for a ledger never archived, or archived only before 1.15 (see
   * `AccountArchived.countWithTotals`). Fails with INVALID as `transactionTotals` does. (Since 1.15.)
   */
  archivedTotals(query: TotalsQuery): Promise<ArchivedTotal[]>
  /**
   * Each account's balance at the end of each date, by the navigator's rule: its opening balance plus every non-voided
   * transaction dated on or before it, whatever its status, archived ones included (from their kept totals). An account
   * has no point before its opening date; and none before its last archival date when an archive before 1.15 left that
   * history incomplete. Accounts an archive removed are included (`removed: true`), so past totals stay what they were.
   * Points come in the order of the accounts, then the dates. Fails with INVALID for a date that isn't YYYY-MM-DD, none
   * or more than `BALANCE_DATES_MAX`. (Since 1.15.)
   */
  balanceHistory(query: BalanceQuery): Promise<BalancePoint[]>
  /**
   * The accounts archives removed, as each archive kept them, by name: for placing their archived totals and past
   * balances (an account scope of types needs the type; a report by sub-ledger, where it was). Empty for a ledger never
   * archived, or archived only before 1.15. (Since 1.15.)
   */
  removedAccounts(): Promise<RemovedAccount[]>

  createAccount(input: AccountInput): Promise<Account>
  /** Refused with ACCOUNT_CLOSED for a closed account: reopen it first. */
  updateAccount(id: string, patch: AccountPatch, options?: WriteOptions): Promise<Account>
  /**
   * Marks the account closed at the bank: read-only, hidden by default, still in totals. Needs
   * `confirm: ['closeWithBalance']` when its balance isn't zero.
   */
  closeAccount(id: string, options?: WriteOptions & { closedOn?: string }): Promise<Account>
  reopenAccount(id: string, options?: WriteOptions): Promise<Account>
  /**
   * Deletes the account and its transactions. Can't be undone. The other sides of its transfers are kept, in their
   * accounts, as ordinary uncategorised transactions noting the deleted account, so no other balance changes.
   */
  deleteAccount(id: string, options?: WriteOptions): Promise<void>
  /** Moves an account to `to` (a sub-ledger id, or null for the ledger itself), at `index` (default: last). */
  moveAccount(id: string, to: string | null, index?: number): Promise<void>

  /** The account's transactions. Fails with NOT_FOUND, when used, for an account that doesn't exist. */
  transactions(accountId: string): TransactionManager
  readonly payees: PayeeDirectory
  readonly categories: CategoryDirectory
  readonly reconciliation: ReconciliationService

  readonly onDidChange: Event<AccountsChange>
}
