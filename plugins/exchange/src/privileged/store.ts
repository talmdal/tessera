// How the exchange plugin keeps its data: the stored shapes, the collections, and the errors and events around
// them. The same shape as the accounts and recurring stores, for the same reason — plugins can't share code.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isBookError } from '@tessera/book-api'
import { isAccountsError } from '@tessera/accounts-api'
import {
  EXCHANGE_COLLECTIONS, ExchangeError, isExchangeError,
  type AccountLink, type ExchangeChange, type FormatProfile, type ImportBatch, type PayeeRule,
  type PendingStatement
} from '@tessera/exchange-api'

export type StoredBatch = Omit<ImportBatch, 'id' | 'rev'>
export type StoredLink = Omit<AccountLink, 'id' | 'rev'>
export type StoredRule = Omit<PayeeRule, 'id' | 'rev'>
export type StoredProfile = Omit<FormatProfile, 'id' | 'rev'>
export type StoredPending = Omit<PendingStatement, 'id' | 'rev'>

export interface Collections {
  batches: Collection<StoredBatch>
  links: Collection<StoredLink>
  rules: Collection<StoredRule>
  profiles: Collection<StoredProfile>
  pending: Collection<StoredPending>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return {
    batches: source.collection<StoredBatch>(EXCHANGE_COLLECTIONS.batches),
    links: source.collection<StoredLink>(EXCHANGE_COLLECTIONS.links),
    rules: source.collection<StoredRule>(EXCHANGE_COLLECTIONS.rules),
    profiles: source.collection<StoredProfile>(EXCHANGE_COLLECTIONS.profiles),
    pending: source.collection<StoredPending>(EXCHANGE_COLLECTIONS.pending)
  }
}

export const toBatch = (doc: Doc<StoredBatch>): ImportBatch => ({ ...doc })
export const toLink = (doc: Doc<StoredLink>): AccountLink => ({ ...doc })
export const toRule = (doc: Doc<StoredRule>): PayeeRule => ({ ...doc })
export const toProfile = (doc: Doc<StoredProfile>): FormatProfile => ({ ...doc })
export const toPending = (doc: Doc<StoredPending>): PendingStatement => ({ ...doc })

export const invalid = (field: string, message: string) => new ExchangeError('INVALID', message, field)

export const notFound = (what: string) => new ExchangeError('NOT_FOUND', what)

/**
 * Storage, book and accounts errors that mean something to the user, as exchange errors; anything else as it
 * was. An `AccountsError` keeps its message: the account manager has already worded it for the user.
 */
export function translate(err: unknown): unknown {
  if (isExchangeError(err)) return err
  if (isBookError(err)) {
    if (err.code === 'NO_BOOK') return new ExchangeError('NO_BOOK', 'No book is open.')
    if (err.code === 'READ_ONLY') return new ExchangeError('READ_ONLY', 'This book is open read-only.')
    return err
  }
  if (isAccountsError(err)) {
    switch (err.code) {
      case 'NO_BOOK': return new ExchangeError('NO_BOOK', err.message)
      case 'READ_ONLY': return new ExchangeError('READ_ONLY', err.message)
      case 'CURRENCY_MISMATCH': return new ExchangeError('CURRENCY_MISMATCH', err.message, err.field)
      case 'NOT_FOUND': return new ExchangeError('NOT_FOUND', err.message, err.field)
      case 'CONFIRMATION_REQUIRED':
        // The account manager asks about reconciled rows in the same words; its reasons map onto ours one to one
        return new ExchangeError('CONFIRMATION_REQUIRED', err.message, err.field,
          err.reasons?.includes('reconciled') ? ['reconciled'] : undefined)
      default: return new ExchangeError('INVALID', err.message, err.field)
    }
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION') return new ExchangeError('INVALID', 'That has already been saved.')
  if (code === 'CONFLICT') return new ExchangeError('INVALID', 'This was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new ExchangeError('READ_ONLY', 'This book is open read-only.')
  if (code === 'NOT_OPEN') return new ExchangeError('NO_BOOK', 'No book is open.')
  return err
}

/** Optional text: trimmed, empty as absent, length- and control-character-checked. */
export function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(field, 'Enter text.')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw invalid(field, `Use at most ${max} characters.`)
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw invalid(field, 'Remove the control characters.')
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
      try { listener(value) } catch (err) { this.log.error('[exchange] A change listener failed', err) }
    }
  }
}

/** A change event, from what an operation touched. */
export function change(partial: Partial<ExchangeChange>): ExchangeChange {
  const unique = (ids: string[] = []) => [...new Set(ids)]
  return {
    batches: unique(partial.batches),
    accounts: unique(partial.accounts),
    pending: unique(partial.pending),
    rules: partial.rules ?? false,
    links: partial.links ?? false,
    profiles: partial.profiles ?? false
  }
}
