// How the reports plugin keeps its saved reports, and the errors and events around them.
import type { Collection, Database, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import { isLedgerError } from '@tessera/ledger-api'
import { isAccountsError } from '@tessera/accounts-api'
import { REPORTS_COLLECTIONS, ReportsError, isReportsError, type SavedReport } from '@tessera/reports-api'
import { INDEXES } from './schema'

/** A saved report as stored: the public fields, plus the key its name is unique by. */
export type StoredSaved = Omit<SavedReport, 'id' | 'rev'> & { nameKey: string }

export interface Collections {
  saved: Collection<StoredSaved>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | StorageTransaction): Collections {
  return { saved: source.collection<StoredSaved>(REPORTS_COLLECTIONS.saved) }
}

export const toSaved = (doc: Doc<StoredSaved>): SavedReport => {
  const { nameKey: _key, ...saved } = structuredClone(doc)
  return saved
}

export const invalid = (field: string, message: string) => new ReportsError('INVALID', message, field)

/** Storage, ledger and accounts errors that mean something to the user, as reports errors; anything else as it was. */
export function translate(err: unknown): unknown {
  if (isReportsError(err)) return err
  if (isLedgerError(err) || isAccountsError(err)) {
    if (err.code === 'NO_LEDGER') return new ReportsError('NO_LEDGER', 'No ledger is open.')
    if (err.code === 'READ_ONLY') return new ReportsError('READ_ONLY', 'This ledger is open read-only.')
    return err
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'UNIQUE_VIOLATION' && String((err as Error).message).includes(`"${INDEXES.savedName}"`)) {
    return new ReportsError('DUPLICATE_NAME', 'There is already a saved report with this name.', 'name')
  }
  if (code === 'CONFLICT') return new ReportsError('CONFLICT', 'This report was changed elsewhere. Try again.')
  if (code === 'READ_ONLY') return new ReportsError('READ_ONLY', 'This ledger is open read-only.')
  if (code === 'NOT_OPEN') return new ReportsError('NO_LEDGER', 'No ledger is open.')
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

/** A listener list, for the plugin's events. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  constructor(private readonly log: Pick<Logger, 'error'>, private readonly name = 'change') {}
  readonly event: Event<T> = listener => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  fire(value: T) {
    for (const listener of [...this.listeners]) {
      try { listener(value) } catch (err) { this.log.error(`[reports] A ${this.name} listener failed`, err) }
    }
  }
}
