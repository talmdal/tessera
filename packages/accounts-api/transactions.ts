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
  /**
   * For importers: the bank line's identity (the bank's id, or a fingerprint), at most `EXTERNAL_ID_MAX_LENGTH`
   * characters. Unique in the account (DUPLICATE_EXTERNAL_ID), so a line can't be added twice. Not mirrored to the
   * other side of a transfer, which is another account's line. In a patch, `null` clears it and leaving it out keeps it.
   */
  externalId?: string
}

/** An edit: only the fields given change. `null` clears an optional field (`categoryId: null` leaves it uncategorised). */
export type TransactionPatch = {
  [K in keyof TransactionDraft]?: undefined extends TransactionDraft[K] ? TransactionDraft[K] | null : TransactionDraft[K]
}

/** `TransactionManager.match`: what a bank line brings to the transaction it is matched to. */
export interface BankMatch {
  /** The bank line's identity: becomes the transaction's `externalId`. */
  externalId: string
  /** The bank's date, when it differs. A transfer's other side follows, as for any date change. */
  date?: string
  /** The bank's amount (minor units, signed), when it differs. A transfer's other side follows. */
  amount?: number
  /** Default: 'electronic', unless the transaction is already cleared, which it keeps. */
  status?: ClearingStatus
  /**
   * A transaction added earlier for the same bank line (a line first imported as new, then matched by the user). It is
   * deleted in the same storage transaction, before the match takes its `externalId`.
   */
  replaces?: string
}

/** `TransactionManager.unmatch`: taking a bank line off the transaction it was matched to. */
export interface BankUnmatch {
  /**
   * Fields to put back as they were before the match was accepted. Give only those that still hold the bank's
   * values, so a change the user made since is kept.
   */
  restore?: { date?: string, amount?: number, status?: ClearingStatus }
  /**
   * The bank line as a transaction of its own, created in the same storage transaction. It takes over the matched
   * transaction's `externalId`; giving a different one is refused.
   */
  add?: TransactionDraft
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

  // ---- For importers

  /**
   * Creates every draft, or none: one storage transaction, and one change event. A problem names the draft it is in:
   * `field` is `drafts[3].date`, say. Two drafts with the same `externalId` are refused like a line imported before.
   */
  createMany(drafts: TransactionDraft[]): Promise<Transaction[]>
  /** This account's transactions whose `externalId` is one of `ids`, in register order. */
  findByExternalIds(ids: string[]): Promise<Transaction[]>
  /**
   * Links a bank line to a transaction already in the account, atomically: deletes `replaces` if given, then gives the
   * transaction the line's `externalId`, date, amount and status. The usual rules apply: a closed account is read-only,
   * `expectedRev` must match, and a change reaching a reconciled transaction (or a reconciled other side of a
   * transfer) needs `confirm: ['reconciled']`. A void transaction, or one matched to another line, is refused.
   */
  match(id: string, match: BankMatch, options?: WriteOptions): Promise<Transaction>
  /**
   * Takes the bank line off a transaction, atomically: clears its `externalId`, puts back `restore`, and creates `add`,
   * which takes over the `externalId`. The same rules as `match`.
   */
  unmatch(id: string, unmatch: BankUnmatch, options?: WriteOptions): Promise<{ transaction: Transaction, added?: Transaction }>
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
