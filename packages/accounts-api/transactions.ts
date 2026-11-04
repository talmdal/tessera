// The transactions half of `accounts.service`: each account's transactions, and the payees and categories they use.
import type { AccountBalances, Category, ClearingStatus, PayeeSuggestion, RegisterSnapshot, Transaction } from './model'
import type { WriteOptions } from './service'

/** A new transaction, in the user's terms: the service creates the payee and the other side of a transfer. */
export interface TransactionDraft {
  /** YYYY-MM-DD. */
  date: string
  /** A cheque number or a code such as 'ATM'. */
  number?: string
  /** Minor units, signed from this account's point of view: positive raises its balance. */
  amount: number
  /** A payee name; created if new (matched ignoring case). */
  payee?: string
  memo?: string
  /** A category, or… */
  categoryId?: string
  /** …the other account of a transfer (not both). */
  transferAccountId?: string
  /** Default 'uncleared'. Setting 'reconciled' needs `confirm: ['reconciled']`. */
  status?: ClearingStatus
}

/** An edit: only the fields given change. `null` clears an optional field (`categoryId: null` leaves it uncategorised). */
export type TransactionPatch = {
  [K in keyof TransactionDraft]?: undefined extends TransactionDraft[K] ? TransactionDraft[K] | null : TransactionDraft[K]
}

/**
 * The transactions of one account. Rules it enforces:
 * - the account (and a transfer's other account) must be open, not closed;
 * - a transfer is two transactions, one per account, kept consistent: amount (opposite), date, payee, memo and void
 *   are mirrored; number and status are each side's own, as each side is reconciled against its own statement;
 * - changing the amount, date or void state of a reconciled transaction, its status, or deleting it, needs
 *   `confirm: ['reconciled']`, and so does a change that reaches a reconciled other side of a transfer.
 */
export interface TransactionManager {
  readonly accountId: string
  /** In register order: by date, then the order they were entered. */
  list(range?: { from?: string, to?: string }): Promise<Transaction[]>
  /** Rows in register order with running balances, plus the account's balances. */
  register(): Promise<RegisterSnapshot>
  get(id: string): Promise<Transaction | undefined>
  create(draft: TransactionDraft): Promise<Transaction>
  update(id: string, patch: TransactionPatch, options?: WriteOptions): Promise<Transaction>
  delete(ids: string[], options?: WriteOptions): Promise<void>
  setStatus(ids: string[], status: ClearingStatus, options?: WriteOptions): Promise<void>
  setVoided(ids: string[], voided: boolean, options?: WriteOptions): Promise<void>
  balances(): Promise<AccountBalances>
  /** One more than the highest numeric transaction number, if there is one. */
  nextNumber(): Promise<string | undefined>
}

export interface PayeeDirectory {
  /** Payees whose name starts with `prefix` (ignoring case), with what each was last used for. Empty prefix: all. */
  search(prefix: string, limit?: number): Promise<PayeeSuggestion[]>
}

export interface CategoryDirectory {
  list(): Promise<Category[]>
  /** Creates `Parent : Child` (and the parent, if new); returns the leaf. Existing ones are returned as they are. */
  create(path: string, kind: Category['kind']): Promise<Category>
}
