// Reconciling an account against a statement. The session belongs to `accounts.service`, so every reconciler (the
// built-in statement reconciler, or a plugin's, offered through `accounts.reconcile.actions`) finishes the same way.
import type { Confirmation } from './errors'
import { isLiability } from './rules'
import type { Account, AccountType, Transaction } from './model'

/** What a statement says: its date, and the balances it starts and ends with (minor units, signed). */
export interface StatementFigures {
  /** YYYY-MM-DD. */
  statementDate: string
  /** The balance at the last reconciliation, as the statement shows it. */
  startingBalance: number
  /** The balance at the statement date. */
  statementBalance: number
}

/**
 * A service charge or interest the statement shows and the register doesn't have yet. Beginning a reconciliation adds
 * it to the account as a transaction, marked as on the statement.
 */
export interface StatementCharge {
  /** Minor units, positive, as the statement prints it. Its direction comes from `chargeAmount`. */
  amount: number
  /** YYYY-MM-DD; usually the statement date. */
  date: string
  categoryId?: string
}

/** What the statement dialog gives: the figures, and optionally a service charge and interest to add. */
export interface StatementInput extends StatementFigures {
  serviceCharge?: StatementCharge
  /** Interest earned on an asset account; interest charged on a credit card, loan or other liability. */
  interest?: StatementCharge
}

export type ChargeKind = 'serviceCharge' | 'interest'

/**
 * The signed amount a charge adds to an account: a service charge always lowers the balance; interest raises an
 * asset's and, on a liability, adds to what is owed (so it is negative, like the balance).
 */
export function chargeAmount(kind: ChargeKind, type: AccountType, amount: number): number {
  const magnitude = Math.abs(amount)
  return kind === 'interest' && !isLiability(type) ? magnitude : -magnitude
}

/** What each charge is called, by account type: credit cards and loans charge interest rather than pay it. */
export function chargeLabel(kind: ChargeKind, type: AccountType): string {
  if (kind === 'serviceCharge') return 'Service charge'
  return isLiability(type) ? 'Interest charged' : 'Interest earned'
}

/** A reconciliation in progress (or paused). One per account at a time. */
export interface Reconciliation extends StatementFigures {
  id: string
  accountId: string
  /** The `accounts.reconcile.actions` contribution that started it. */
  reconcilerId: string
  /** Paused: the marks are kept, and the account is reconciled later. */
  paused: boolean
  /** The transactions it added from the statement (service charges, interest); Cancel deletes them. */
  addedIds: string[]
  startedAt: string
  rev: number
}

/** A transaction the statement may include: not voided, not yet reconciled. */
export interface ReconcileCandidate {
  transaction: Transaction
  payeeName?: string
  categoryLabel?: string
  /** Marked as on the statement (cleared or electronically cleared). */
  marked: boolean
  /** Dated after the statement: usually not on it. */
  afterStatement: boolean
}

export interface ReconcileSummary {
  /** The statement's starting balance. */
  starting: number
  /** The sum of the marked transactions. */
  marked: number
  markedCount: number
  /** What is left to account for: statement balance − (starting balance + marked). Zero when it balances. */
  difference: number
  /** The reconciled balance in the book before this statement (opening balance plus reconciled transactions). */
  lastReconciledBalance: number
  /**
   * What completing would add so the book agrees with the statement: statement balance − (last reconciled balance +
   * marked). It equals `difference` unless the statement's starting balance differs from the book's.
   */
  adjustment: number
}

/** Everything a view shows while reconciling an account. */
export interface ReconcileState {
  account: Account
  reconciliation: Reconciliation
  summary: ReconcileSummary
  /** In register order: every transaction not yet reconciled, voided ones excepted. */
  candidates: ReconcileCandidate[]
}

export interface ReconcileResult {
  reconciledCount: number
  /** The balance adjustment added, when one was needed and confirmed. */
  adjustment?: Transaction
}

/**
 * Reconciliation, in `accounts.service`. Marks are saved at once, so a paused reconciliation survives a restart.
 * Every method fails with NOT_FOUND when the account has no reconciliation in progress (except `begin` and `get`).
 */
export interface ReconciliationService {
  /** The reconciliation in progress for an account, paused or not; undefined if there is none. */
  get(accountId: string): Promise<ReconcileState | undefined>
  /**
   * Starts one, or, when one is in progress, updates its figures and resumes it. A service charge or interest given
   * is added as a transaction, marked, in the same storage transaction (on resuming, as another one).
   */
  begin(accountId: string, statement: StatementInput & { reconcilerId: string }): Promise<ReconcileState>
  /** Marks transactions as on the statement (cleared), or not (uncleared). */
  mark(accountId: string, ids: string[], marked: boolean): Promise<ReconcileState>
  /** Keeps the marks, and leaves reconciling for later. */
  pause(accountId: string): Promise<void>
  /**
   * Makes every marked transaction reconciled and records the statement as the account's last reconciliation, in one
   * storage transaction. When the book and the statement still differ (`summary.adjustment` isn't zero) it needs
   * `confirm: ['adjustBalance']`, and then adds a reconciled "Balance adjustment" transaction for the difference.
   */
  finish(accountId: string, options?: { confirm?: Confirmation[] }): Promise<ReconcileResult>
  /** Ends it: puts back the status of every transaction it marked or unmarked, and deletes the ones it added. */
  cancel(accountId: string): Promise<void>
}
