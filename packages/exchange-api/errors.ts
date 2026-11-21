// Error codes for `exchange.service` and the exchange IPC. The same shape as @tessera/accounts-api's, for the
// same reason: each plugin bundles its own copy of this package, so `instanceof` can't work across them.
import type { Result } from '@tessera/book-api'

export type ExchangeErrorCode =
  /** No book is open. */
  | 'NO_BOOK'
  /** The book was opened read-only. */
  | 'READ_ONLY'
  /** No installed format claimed the file. */
  | 'UNKNOWN_FORMAT'
  /** The file is that format but is malformed beyond recovery; the message names the line. */
  | 'UNREADABLE'
  /** The file parsed but held no transactions. */
  | 'EMPTY'
  /** A field is missing or malformed; `field` names it. */
  | 'INVALID'
  /** The plan, batch or row named is not there — or the plan expired when another was made. */
  | 'NOT_FOUND'
  /** `apply` was called with a statement whose account is unresolved. */
  | 'ACCOUNT_UNRESOLVED'
  /** The statement's currency is not the account's, and nothing converts. */
  | 'CURRENCY_MISMATCH'
  /** `apply` was called with one of the plan's questions unanswered. */
  | 'ANSWER_REQUIRED'
  /** That batch has already been taken back out. */
  | 'ALREADY_UNDONE'
  /**
   * These exact bytes have been imported into this account before and the batch is still in the history. A
   * question rather than a refusal — a bank re-issuing a corrected file is real — so the caller asks and
   * retries with `force`.
   */
  | 'ALREADY_IMPORTED'
  /** The statement predates the account's opening date and needs an explicit override. */
  | 'ARCHIVED_PERIOD'
  /** The chosen format has no writer. */
  | 'NOT_WRITABLE'
  /** Beyond the row limit (`maxRows`). */
  | 'TOO_LARGE'
  /** The change needs the user's confirmation first; `reasons` says which, and the caller resends with `confirm`. */
  | 'CONFIRMATION_REQUIRED'

/** Confirmations a caller obtains from the user and passes back. */
export type ExchangeConfirmation =
  /** An undo would touch a transaction reconciled since the import, or one edited since. */
  | 'reconciled'
  | 'editedSince'
  /** Accepting the row may count an already-archived transaction twice. */
  | 'archivedPeriod'

/** What `exchange.service` throws for something the user caused. Test with `isExchangeError`, never `instanceof`. */
export class ExchangeError extends Error {
  override readonly name = 'ExchangeError'

  constructor(
    readonly code: ExchangeErrorCode,
    message: string,
    readonly field?: string,
    readonly reasons?: ExchangeConfirmation[]
  ) {
    super(message)
  }
}

/** True for an `ExchangeError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isExchangeError(err: unknown): err is ExchangeError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'ExchangeError' && typeof code === 'string' && typeof message === 'string'
}

/** An exchange reply: as `Result`, and for CONFIRMATION_REQUIRED, the confirmations needed. */
export type ExchangeResult<T> =
  | Extract<Result<T, ExchangeErrorCode>, { ok: true }>
  | { ok: false, error: { code: ExchangeErrorCode, message: string, field?: string, reasons?: ExchangeConfirmation[] } }

/** Runs `work`, turning an `ExchangeError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toExchangeResult<T>(work: () => Promise<T>): Promise<ExchangeResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isExchangeError(err)) throw err
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
