// How the accounts plugin keeps its data: the stored shapes, the collections, and the errors and events around them.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isLedgerError } from '@tessera/ledger-api'
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

/**
 * One account's archived totals for one month, packed as flat arrays of numbers against the dictionary
 * (`StoredArchivedIds`): R0 measured this packing smallest and quickest to write (docs/reporting-design.md, Phase R0
 * results, 3). Each id is its place in the dictionary; −1 is "none". See archivedMonths.ts.
 */
export interface StoredArchivedMonth {
  accountId: string
  /** YYYY-MM. */
  month: string
  /** The account's name, currency and sub-ledger when it was archived: it may be gone since. */
  name: string
  currency: string
  subLedgerId: string | null
  /** [category (−1: uncategorised), inflow, outflow, count] for each category. */
  categories: number[]
  /** [other account, inflow, outflow, count, that account's sub-ledger then (−1: the ledger itself)] for each. */
  transfers: number[]
  /** [category (−1: uncategorised), payee (−1: none), inflow, outflow, count]: the categories' totals by payee. */
  payees: number[]
}

/** The ids archived months name, numbered by their place in `ids`. One document, appended to and never reordered. */
export interface StoredArchivedIds {
  key: 'ids'
  ids: string[]
}

/** What an account an archive removed leaves for its history: its archived months hold its transactions' totals. */
export interface StoredArchivedAccount {
  accountId: string
  name: string
  type: Account['type']
  currency: string
  subLedgerId: string | null
  openingDate: string
  /** The balance it opened with, before any archive carried anything into it. */
  openingBalance: number
  closedOn?: string
  /** The archive date that removed it. */
  removedBefore: string
  /** Every archived transaction of it has its totals kept (no archive before 1.15 took any). */
  complete: boolean
}

export interface Collections {
  accounts: Collection<StoredAccount>
  transactions: Collection<StoredTransaction>
  payees: Collection<StoredPayee>
  categories: Collection<StoredCategory>
  reconciliations: Collection<StoredReconciliation>
  archivedMonths: Collection<StoredArchivedMonth>
  archivedIds: Collection<StoredArchivedIds>
  archivedAccounts: Collection<StoredArchivedAccount>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return {
    accounts: source.collection<StoredAccount>(ACCOUNTS_COLLECTIONS.accounts),
    transactions: source.collection<StoredTransaction>(ACCOUNTS_COLLECTIONS.transactions),
    payees: source.collection<StoredPayee>(ACCOUNTS_COLLECTIONS.payees),
    categories: source.collection<StoredCategory>(ACCOUNTS_COLLECTIONS.categories),
    reconciliations: source.collection<StoredReconciliation>(ACCOUNTS_COLLECTIONS.reconciliations),
    archivedMonths: source.collection<StoredArchivedMonth>(ACCOUNTS_COLLECTIONS.archivedMonths),
    archivedIds: source.collection<StoredArchivedIds>(ACCOUNTS_COLLECTIONS.archivedIds),
    archivedAccounts: source.collection<StoredArchivedAccount>(ACCOUNTS_COLLECTIONS.archivedAccounts)
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

/** The unique index on `[accountId, externalId]` in the transactions collection (see schema.ts). */
export const TRANSACTIONS_EXTERNAL_ID_INDEX = 'uniqueExternalId'

/** Storage and ledger errors that mean something to the user, as accounts errors; anything else as it was. */
export function translate(err: unknown): unknown {
  if (isAccountsError(err)) return err
  if (isLedgerError(err)) {
    if (err.code === 'NO_LEDGER') return new AccountsError('NO_LEDGER', 'No ledger is open.')
    if (err.code === 'READ_ONLY') return new AccountsError('READ_ONLY', 'This ledger is open read-only.')
    return err
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') {
    // Writes check these first, with better messages; this catches what a check could miss. Storage names the index
    // only in its message, and the transactions' one is about bank lines, not names.
    if (String((err as Error).message).includes(`"${TRANSACTIONS_EXTERNAL_ID_INDEX}"`)) {
      return new AccountsError('DUPLICATE_EXTERNAL_ID', 'That bank line is already in this account.', 'externalId')
    }
    return new AccountsError('DUPLICATE_NAME', 'There is already one with this name.', 'name')
  }
  if (code === 'CONFLICT') return new AccountsError('CONFLICT', 'This was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new AccountsError('READ_ONLY', 'This ledger is open read-only.')
  if (code === 'NOT_OPEN') return new AccountsError('NO_LEDGER', 'No ledger is open.')
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
