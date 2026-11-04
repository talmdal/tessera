// The `accounts.service` service: the accounts of the open book, and the integrity boundary for them. Other
// plugins (reports, importers, budgets) read and change accounts through it, never through the collections.
//
// Methods that fail because of what the user did throw an `AccountsError` (test with `isAccountsError`) whose `code`
// says why, whose `field` names the input at fault, and, for CONFIRMATION_REQUIRED, whose `reasons` list what to
// confirm before calling again with `confirm`.
//
import type { Event } from '@tessera/types'
import type { Confirmation } from './errors'
import type { Account, AccountBalances, AccountClass, AccountType, Chart } from './model'
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
  /** The sub-book to put it in; null for the book itself. */
  subBookId: string | null
  /** ISO 4217, e.g. 'CAD'. */
  currency: string
  institution?: string
  accountNumber?: string
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
 * An edit: only the fields given change, and `null` clears an optional one. Changing `subBookId` moves the account
 * to the end of that sub-book (use `moveAccount` to choose the position).
 */
export type AccountPatch = {
  [K in keyof AccountInput]?: undefined extends AccountInput[K] ? AccountInput[K] | null : AccountInput[K]
}

/** Which accounts `list` returns. Every condition given must hold. */
export interface AccountFilter {
  /** Accounts directly in this sub-book; null for those directly in the book. */
  subBookId?: string | null
  /** With `subBookId`: include the accounts of every sub-book beneath it too. */
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
  /** Anything the chart shows changed: any of the above, or the book tree, or which book is open. */
  chart: boolean
}

/** The `accounts.service` service. Every method fails with NO_BOOK while no book is open. */
export interface AccountsService {
  /** An account by id, or undefined. */
  get(id: string): Promise<Account | undefined>
  /** Accounts matching `filter`, in the order the navigator shows them. */
  list(filter?: AccountFilter): Promise<Account[]>
  /** The book tree with accounts and balances, and totals per currency. */
  chart(options?: { includeClosed?: boolean }): Promise<Chart>
  /** An account's balances, from its opening balance and its (non-voided) transactions. */
  balances(id: string): Promise<AccountBalances>

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
  /** Moves an account to `to` (a sub-book id, or null for the book itself), at `index` (default: last). */
  moveAccount(id: string, to: string | null, index?: number): Promise<void>

  /** The account's transactions. Fails with NOT_FOUND, when used, for an account that doesn't exist. */
  transactions(accountId: string): TransactionManager
  readonly payees: PayeeDirectory
  readonly categories: CategoryDirectory
  readonly reconciliation: ReconciliationService

  readonly onDidChange: Event<AccountsChange>
}
