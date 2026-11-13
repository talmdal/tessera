// Error codes for `recurring.service` and the recurring IPC. The same shape as @tessera/accounts-api's, for the
// same reason: each plugin bundles its own copy of this package, so `instanceof` can't work across them.
import type { Result } from '@tessera/book-api'

export type RecurringErrorCode =
  /** No book is open. */
  | 'NO_BOOK'
  /** The book was opened read-only. */
  | 'READ_ONLY'
  /** A series doesn't exist. */
  | 'NOT_FOUND'
  /** A field is missing or malformed; `field` names it. */
  | 'INVALID'
  /** The series' account is closed, so nothing can be entered into it. */
  | 'ACCOUNT_CLOSED'
  /** The series is paused. */
  | 'SERIES_PAUSED'
  /** The series has reached its end rule: there is nothing left to enter. */
  | 'SERIES_ENDED'
  /** A transfer's other account is gone, closed, or in another currency; the message is the accounts service's. */
  | 'TRANSFER_UNAVAILABLE'
  /** `expectedRev` didn't match: it was changed elsewhere. */
  | 'CONFLICT'
  /** The change needs the user's confirmation first; `reasons` says which, and the caller resends with `confirm`. */
  | 'CONFIRMATION_REQUIRED'

/** Confirmations a caller obtains from the user and passes back in `WriteOptions.confirm`. */
export type RecurringConfirmation =
  /** Entering an occurrence dated more than a year in the past, or more than a year ahead. */
  | 'unusualDate'
  /** A transaction with the same account, date and amount is already there: possibly a double entry. */
  | 'possibleDuplicate'

/** What `recurring.service` throws for something the user caused. Test with `isRecurringError`, never `instanceof`. */
export class RecurringError extends Error {
  override readonly name = 'RecurringError'

  constructor(
    readonly code: RecurringErrorCode,
    message: string,
    readonly field?: string,
    readonly reasons?: RecurringConfirmation[]
  ) {
    super(message)
  }
}

/** True for a `RecurringError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isRecurringError(err: unknown): err is RecurringError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'RecurringError' && typeof code === 'string' && typeof message === 'string'
}

/** A recurring reply: as `Result`, and for CONFIRMATION_REQUIRED, the confirmations needed. */
export type RecurringResult<T> =
  | Extract<Result<T, RecurringErrorCode>, { ok: true }>
  | { ok: false, error: { code: RecurringErrorCode, message: string, field?: string, reasons?: RecurringConfirmation[] } }

/** Runs `work`, turning a `RecurringError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toRecurringResult<T>(work: () => Promise<T>): Promise<RecurringResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isRecurringError(err)) throw err
    return {
      ok: false,
      error: {
        code: err.code, message: err.message,
        ...(err.field !== undefined && { field: err.field }),
        ...(err.reasons !== undefined && { reasons: err.reasons })
      }
    }
  }
}
