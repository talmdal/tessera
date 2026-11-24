// Error codes for `reports.service` and the run. Replies use `Result` from @tessera/ledger-api.
import type { Result } from '@tessera/ledger-api'

export type ReportsErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** The ledger was opened read-only (an archive file): saved reports can't change. */
  | 'READ_ONLY'
  /** A definition, saved report, sub-ledger or account doesn't exist. */
  | 'NOT_FOUND'
  /** The source a report needs isn't there: its plugin isn't running, or doesn't provide its service. */
  | 'NO_SOURCE'
  /** A spec, an option or a parameter is malformed; `field` is the path at fault (`query.rows.dimension`). */
  | 'INVALID'
  /** A limit was passed (columns, dates), or a figure couldn't be exact. */
  | 'TOO_LARGE'
  /** The source took longer than `SOURCE_TIMEOUT_MS`. */
  | 'TIMEOUT'
  /** The source failed, or gave figures that can't be used. */
  | 'SOURCE_FAILED'
  /** A saved report with this name exists, ignoring case. */
  | 'DUPLICATE_NAME'
  /** `expectedRev` didn't match: it was changed elsewhere. */
  | 'CONFLICT'

/**
 * What `reports.service` throws for something the user (or a contribution) caused. Each plugin bundles its own copy of
 * this package, so test with `isReportsError`, never `instanceof`.
 */
export class ReportsError extends Error {
  override readonly name = 'ReportsError'

  constructor(readonly code: ReportsErrorCode, message: string, readonly field?: string) {
    super(message)
  }
}

/** True for a `ReportsError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isReportsError(err: unknown): err is ReportsError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'ReportsError' && typeof code === 'string' && typeof message === 'string'
}

/** A reports reply, for a view: the value, or what went wrong. */
export type ReportsResult<T> = Result<T, ReportsErrorCode>

/** Runs `work`, turning a `ReportsError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toReportsResult<T>(work: () => Promise<T>): Promise<ReportsResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isReportsError(err)) throw err
    return { ok: false, error: { code: err.code, message: err.message, ...(err.field !== undefined && { field: err.field }) } }
  }
}
