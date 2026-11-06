// Errors of the import manager and of format plugins. Outcomes the user can cause (an unreadable file, a file too
// large) are `ImportError`s with a code; replies to views are `Result`s, as for the ledger and accounts.
import type { Result } from '@tessera/ledger-api'

export type ImportErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** The ledger was opened read-only. */
  | 'READ_ONLY'
  /** No installed format can read the file. */
  | 'NO_FORMAT'
  /** The format can't read the file: it is damaged, or not what its name says. Thrown by format plugins. */
  | 'UNREADABLE'
  /** The file is larger than `IMPORT_LIMITS.maxFileSize`. */
  | 'TOO_LARGE'
  /** The file holds no transactions. */
  | 'EMPTY'
  /** The statement's currency isn't the account's. */
  | 'CURRENCY_MISMATCH'
  /** The account is closed, so nothing can be imported into it. */
  | 'ACCOUNT_CLOSED'
  /** The user cancelled. */
  | 'CANCELLED'
  /** Another import is running. */
  | 'BUSY'
  /** A bank line, transaction or import the request names no longer exists. */
  | 'NOT_FOUND'
  /**
   * The change can't be made as asked: the transaction chosen for a bank line is taken, or `accounts` refused it
   * (it was changed elsewhere, say). The message says why.
   */
  | 'REFUSED'

/**
 * What the import manager and format plugins throw for something the user should see. Each plugin bundles its own
 * copy of this package, so test with `isImportError`, never `instanceof`.
 */
export class ImportError extends Error {
  override readonly name = 'ImportError'

  constructor(readonly code: ImportErrorCode, message: string) {
    super(message)
  }
}

/** True for an `ImportError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isImportError(err: unknown): err is ImportError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'ImportError' && typeof code === 'string' && typeof message === 'string'
}

/** A reply to a view whose failure the user should see. */
export type ImportResult<T> = Result<T, ImportErrorCode>

/** Runs `work`, turning an `ImportError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toImportResult<T>(work: () => Promise<T>): Promise<ImportResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isImportError(err)) throw err
    return { ok: false, error: { code: err.code, message: err.message } }
  }
}
