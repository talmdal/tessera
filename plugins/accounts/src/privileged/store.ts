// How the accounts plugin keeps its data: the stored shapes, the collections, and the errors and events around them.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isBookError } from '@tessera/book-api'
import {
  ACCOUNTS_COLLECTIONS, AccountsError, isAccountsError,
  type Account, type AccountsChange, type Category, type ClearingStatus, type Payee, type Reconciliation, type Transaction
} from '@tessera/accounts-api'

/** An account as stored: the public fields, plus the keys it is looked up by. */
export type StoredAccount = Omit<Account, 'id' | 'rev'> & { nameKey: string, numberKey?: string }
export type StoredTransaction = Omit<Transaction, 'id' | 'rev'>
export type StoredPayee = Omit<Payee, 'id' | 'rev'> & { nameKey: string }
export type StoredCategory = Omit<Category, 'id' | 'rev'> & { nameKey: string }

/** A reconciliation, in progress or finished. */
export type StoredReconciliation = Omit<Reconciliation, 'id' | 'rev' | 'addedIds'> & {
  /** Absent in one paused before charges could be added. */
  addedIds?: string[]
  status: 'inProgress' | 'finished'
  /** The account id while in progress, absent once finished: a unique index, so one per account at a time. */
  activeFor?: string
  /** The status of each transaction it changed, before it changed it, so Cancel can put them back. */
  original: Record<string, ClearingStatus>
  finishedAt?: string
  reconciledIds?: string[]
  adjustmentId?: string
}

export interface Collections {
  accounts: Collection<StoredAccount>
  transactions: Collection<StoredTransaction>
  payees: Collection<StoredPayee>
  categories: Collection<StoredCategory>
  reconciliations: Collection<StoredReconciliation>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return {
    accounts: source.collection<StoredAccount>(ACCOUNTS_COLLECTIONS.accounts),
    transactions: source.collection<StoredTransaction>(ACCOUNTS_COLLECTIONS.transactions),
    payees: source.collection<StoredPayee>(ACCOUNTS_COLLECTIONS.payees),
    categories: source.collection<StoredCategory>(ACCOUNTS_COLLECTIONS.categories),
    reconciliations: source.collection<StoredReconciliation>(ACCOUNTS_COLLECTIONS.reconciliations)
  }
}

export const toAccount = (doc: Doc<StoredAccount>): Account => {
  const { nameKey: _name, numberKey: _number, ...account } = doc
  return account
}
export const toTransaction = (doc: Doc<StoredTransaction>): Transaction => ({ ...doc })
export const toPayee = ({ id, name, rev }: Doc<StoredPayee>): Payee => ({ id, name, rev })
export const toCategory = ({ id, parentId, name, kind, rev }: Doc<StoredCategory>): Category => ({ id, parentId, name, kind, rev })

export const invalid = (field: string, message: string) => new AccountsError('INVALID', message, field)

/** Storage and book errors that mean something to the user, as accounts errors; anything else as it was. */
export function translate(err: unknown): unknown {
  if (isAccountsError(err)) return err
  if (isBookError(err)) {
    if (err.code === 'NO_BOOK') return new AccountsError('NO_BOOK', 'No book is open.')
    if (err.code === 'READ_ONLY') return new AccountsError('READ_ONLY', 'This book is open read-only.')
    return err
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') return new AccountsError('DUPLICATE_NAME', 'There is already one with this name.', 'name')
  if (code === 'CONFLICT') return new AccountsError('CONFLICT', 'This was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new AccountsError('READ_ONLY', 'This book is open read-only.')
  if (code === 'NOT_OPEN') return new AccountsError('NO_BOOK', 'No book is open.')
  return err
}

/** Optional text: trimmed, empty as absent, length- and control-character-checked. */
export function optionalText(value: unknown, field: string, max: number, multiline = false): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(field, 'Enter text.')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw invalid(field, `Use at most ${max} characters.`)
  if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(trimmed)) {
    throw invalid(field, 'Remove the control characters.')
  }
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
      try { listener(value) } catch (err) { this.log.error('[accounts] A change listener failed', err) }
    }
  }
}

/** A change event, from what an operation touched. Accounts whose transactions changed also changed balances. */
export function change(partial: Partial<AccountsChange>): AccountsChange {
  const unique = (ids: string[] = []) => [...new Set(ids)]
  return {
    created: unique(partial.created), updated: unique(partial.updated), deleted: unique(partial.deleted),
    transactions: unique(partial.transactions), balances: unique(partial.balances),
    categories: partial.categories ?? false, reconciliations: unique(partial.reconciliations), chart: partial.chart ?? true
  }
}
