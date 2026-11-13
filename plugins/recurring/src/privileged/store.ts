// How the recurring plugin keeps its data: the stored shapes, the collections, and the errors and events around
// them. The same shape as the accounts plugin's store, for the same reasons — plugins can't share code.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isBookError } from '@tessera/book-api'
import { isAccountsError } from '@tessera/accounts-api'
import {
  RECURRING_COLLECTIONS, RecurringError, isRecurringError,
  type Holiday, type Posting, type RecurringChange, type Series
} from '@tessera/recurring-api'

/** A series as stored. `id` and `rev` are the document's. */
export type StoredSeries = Omit<Series, 'id' | 'rev'>

/** A posting as stored. It has no revision of its own: history is written once and never edited. */
export type StoredPosting = Omit<Posting, 'id'>

export type StoredHoliday = Omit<Holiday, 'id' | 'rev'>

export interface Collections {
  series: Collection<StoredSeries>
  postings: Collection<StoredPosting>
  holidays: Collection<StoredHoliday>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return {
    series: source.collection<StoredSeries>(RECURRING_COLLECTIONS.series),
    postings: source.collection<StoredPosting>(RECURRING_COLLECTIONS.postings),
    holidays: source.collection<StoredHoliday>(RECURRING_COLLECTIONS.holidays)
  }
}

export const toHoliday = ({ id, date, name, rev }: Doc<StoredHoliday>): Holiday => ({ id, date, name, rev })

export const toSeries = (doc: Doc<StoredSeries>): Series => ({ ...doc })

export const toPosting = (doc: Doc<StoredPosting>): Posting => {
  const { rev: _rev, ...posting } = doc
  return posting
}

export const invalid = (field: string, message: string) => new RecurringError('INVALID', message, field)

export const notFound = () => new RecurringError('NOT_FOUND', 'That recurring transaction no longer exists.')

/**
 * Storage, book and accounts errors that mean something to the user, as recurring errors; anything else as it was.
 * An `AccountsError` keeps its message: the account manager has already worded it for the user.
 */
export function translate(err: unknown): unknown {
  if (isRecurringError(err)) return err
  if (isBookError(err)) {
    if (err.code === 'NO_BOOK') return new RecurringError('NO_BOOK', 'No book is open.')
    if (err.code === 'READ_ONLY') return new RecurringError('READ_ONLY', 'This book is open read-only.')
    return err
  }
  if (isAccountsError(err)) {
    switch (err.code) {
      case 'NO_BOOK': return new RecurringError('NO_BOOK', err.message)
      case 'READ_ONLY': return new RecurringError('READ_ONLY', err.message)
      case 'ACCOUNT_CLOSED': return new RecurringError('ACCOUNT_CLOSED', err.message, err.field)
      case 'CURRENCY_MISMATCH': return new RecurringError('TRANSFER_UNAVAILABLE', err.message, err.field)
      case 'NOT_FOUND': return new RecurringError('NOT_FOUND', err.message, err.field)
      case 'CONFLICT': return new RecurringError('CONFLICT', err.message, err.field)
      default: return new RecurringError('INVALID', err.message, err.field)
    }
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') return new RecurringError('INVALID', 'That date is already a holiday.', 'date')
  if (code === 'CONFLICT') return new RecurringError('CONFLICT', 'This was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new RecurringError('READ_ONLY', 'This book is open read-only.')
  if (code === 'NOT_OPEN') return new RecurringError('NO_BOOK', 'No book is open.')
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
      try { listener(value) } catch (err) { this.log.error('[recurring] A change listener failed', err) }
    }
  }
}

/** A change event, from what an operation touched. Anything that touches a series changes the snapshot. */
export function change(partial: Partial<RecurringChange>): RecurringChange {
  const unique = (ids: string[] = []) => [...new Set(ids)]
  return {
    created: unique(partial.created), updated: unique(partial.updated), deleted: unique(partial.deleted),
    accounts: unique(partial.accounts), snapshot: partial.snapshot ?? true,
    ...(partial.holidays && { holidays: true })
  }
}
