// How the budget plugin keeps its data: the stored shapes, the collections, and the errors and events around them.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isLedgerError } from '@tessera/ledger-api'
import { isAccountsError } from '@tessera/accounts-api'
import { BUDGET_COLLECTIONS, BudgetError, isBudgetError, type Budget, type BudgetChange, type BudgetLine, type LineTarget } from '@tessera/budget-api'
import { INDEXES } from './schema'

/** A budget as stored: the public fields, plus the key its name is unique by. */
export type StoredBudget = Omit<Budget, 'id' | 'rev'> & { nameKey: string }
export type StoredLine = Omit<BudgetLine, 'id' | 'rev'>

/** An entry of an archived month: [inflow, outflow, count]; a transfer's adds the other account's sub-ledger. */
export type ArchivedEntry = [inflow: number, outflow: number, count: number]
export type ArchivedTransferEntry = [inflow: number, outflow: number, count: number, subLedgerId: string | null]

/**
 * One account's archived actuals for one month: what archives removed from it, totalled as `transactionTotals` totals.
 * The account's own currency and sub-ledger are used while it exists; those kept here only once it doesn't.
 */
export interface ArchivedMonth {
  accountId: string
  /** YYYY-MM. */
  month: string
  /** The account's currency when it was archived. */
  currency: string
  /** The account's sub-ledger when it was archived; null for one directly in the ledger. */
  subLedgerId: string | null
  /** By category id ('' for uncategorised). */
  categories: Record<string, ArchivedEntry>
  /** By the other account's id, with that account's sub-ledger when it was archived. */
  transfers: Record<string, ArchivedTransferEntry>
}

export interface Collections {
  budgets: Collection<StoredBudget>
  lines: Collection<StoredLine>
  archivedMonths: Collection<ArchivedMonth>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return {
    budgets: source.collection<StoredBudget>(BUDGET_COLLECTIONS.budgets),
    lines: source.collection<StoredLine>(BUDGET_COLLECTIONS.lines),
    archivedMonths: source.collection<ArchivedMonth>(BUDGET_COLLECTIONS.archivedMonths)
  }
}

/** A line target's identity in a budget: its category, or the other account of its transfers (one line each). */
export const targetKey = (t: LineTarget): string => t.kind === 'category' ? `c:${t.categoryId}` : `t:${t.accountId}`

export const toBudget = (doc: Doc<StoredBudget>): Budget => {
  const { nameKey: _key, ...budget } = doc
  return budget
}
export const toLine = (doc: Doc<StoredLine>): BudgetLine => structuredClone(doc)

export const invalid = (field: string, message: string) => new BudgetError('INVALID', message, field)
export const notFound = (what: string, field?: string) => new BudgetError('NOT_FOUND', `That ${what} no longer exists.`, field)

/** Storage, ledger and accounts errors that mean something to the user, as budget errors; anything else as it was. */
export function translate(err: unknown): unknown {
  if (isBudgetError(err)) return err
  if (isLedgerError(err) || isAccountsError(err)) {
    if (err.code === 'NO_LEDGER') return new BudgetError('NO_LEDGER', 'No ledger is open.')
    if (err.code === 'READ_ONLY') return new BudgetError('READ_ONLY', 'This ledger is open read-only.')
    return err
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') {
    // Writes check these first, with better messages; this catches what a check could miss. Storage names the index
    // only in its message
    const message = String((err as Error).message)
    if (message.includes(`"${INDEXES.budgetName}"`)) return new BudgetError('DUPLICATE_NAME', 'There is already a budget with this name.', 'name')
    if (message.includes(`"${INDEXES.lineCategory}"`) || message.includes(`"${INDEXES.lineAccount}"`)) {
      return new BudgetError('DUPLICATE_LINE', 'This budget already has a line for it.', 'target')
    }
    return err
  }
  if (code === 'CONFLICT') return new BudgetError('CONFLICT', 'This was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new BudgetError('READ_ONLY', 'This ledger is open read-only.')
  if (code === 'NOT_OPEN') return new BudgetError('NO_LEDGER', 'No ledger is open.')
  return err
}

/** Optional text: trimmed, empty as absent, length- and control-character-checked (line breaks allowed). */
export function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(field, 'Enter text.')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw invalid(field, `Use at most ${max} characters.`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw invalid(field, 'Remove the control characters.')
  return trimmed
}

export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  constructor(private readonly log: Pick<Logger, 'error'>) {}
  readonly event: Event<T> = listener => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  fire(value: T) {
    for (const listener of [...this.listeners]) {
      try { listener(value) } catch (err) { this.log.error('[budget] A change listener failed', err) }
    }
  }
}

/** A change event, from what an operation touched. */
export function change(partial: Partial<BudgetChange>): BudgetChange {
  const unique = (ids: string[] = []) => [...new Set(ids)]
  return { budgets: unique(partial.budgets), deleted: unique(partial.deleted), lines: unique(partial.lines), actuals: partial.actuals ?? false }
}
