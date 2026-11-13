// Errors of the export manager and of file-type plugins' writers. Outcomes the user can cause (a file that can't be
// written, an account that has gone) are `ExportError`s with a code; replies to views are `Result`s, as for the
// ledger, accounts and import.
import type { Result } from '@tessera/ledger-api'

export type ExportErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** Another export, or another long operation (an import, a backup), is running. */
  | 'BUSY'
  /** The format asked for isn't installed, or its plugin didn't start. */
  | 'NO_FORMAT'
  /** An account asked for no longer exists. */
  | 'NOT_FOUND'
  /** The export can't be written as asked: the format's check found a problem, or the request doesn't make sense. */
  | 'INVALID'
  /** The file couldn't be written: the disk is full, the folder can't be written to, the file is held open. */
  | 'WRITE_FAILED'
  /** The user cancelled. */
  | 'CANCELLED'

/**
 * What the export manager and writers throw for something the user should see. Each plugin bundles its own copy of
 * this package, so test with `isExportError`, never `instanceof`.
 */
export class ExportError extends Error {
  override readonly name = 'ExportError'

  constructor(readonly code: ExportErrorCode, message: string) {
    super(message)
  }
}

/** True for an `ExportError` from any plugin's copy of this package: checks the shape, not the class. */
export function isExportError(err: unknown): err is ExportError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'ExportError' && typeof code === 'string' && typeof message === 'string'
}

/** A reply to a view whose failure the user should see. */
export type ExportResult<T> = Result<T, ExportErrorCode>

/** Runs `work`, turning an `ExportError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toExportResult<T>(work: () => Promise<T>): Promise<ExportResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isExportError(err)) throw err
    return { ok: false, error: { code: err.code, message: err.message } }
  }
}
