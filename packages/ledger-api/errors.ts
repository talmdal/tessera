// Outcomes the user can cause (a duplicate name, no ledger open) are results with a code, not exceptions:
// the preload keeps only an Error's message, so a view could not tell them apart otherwise.

export type LedgerErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** The ledger was opened read-only. */
  | 'READ_ONLY'
  /** The sub-ledger (or parent) doesn't exist. */
  | 'NOT_FOUND'
  /** A sibling already has this name, ignoring case. */
  | 'DUPLICATE_NAME'
  /** A sub-ledger would be moved into itself or one of its descendants. */
  | 'CYCLE'
  /** A field is missing or malformed (an empty name, say); `field` names it. */
  | 'INVALID'
  /** `expectedRev` didn't match: someone else changed it first. */
  | 'CONFLICT'
  /** The file is not a ledger, is from a newer version, or needs a different storage engine. */
  | 'UNSUPPORTED_FILE'
  /** A file the user named doesn't exist. */
  | 'FILE_NOT_FOUND'
  /** A `ledger.schema` contributor's data could not be brought up to date; nothing was changed, or a backup was taken. */
  | 'MIGRATION_FAILED'

export interface ResultError<C extends string = string> {
  code: C
  message: string
  /** The input field the error is about, so a form can show it there. */
  field?: string
}

/** The reply to a request whose failure the user should see. Shared by every Finance plugin's IPC. */
export type Result<T, C extends string = string> =
  | { ok: true, value: T }
  | { ok: false, error: ResultError<C> }

/**
 * What `ledger.session` throws for something the user caused. Each plugin bundles its own copy of this package, so
 * `instanceof LedgerError` is false for an error thrown by another plugin's copy: test with `isLedgerError`.
 */
export class LedgerError extends Error {
  override readonly name = 'LedgerError'

  constructor(readonly code: LedgerErrorCode, message: string, readonly field?: string) {
    super(message)
  }
}

/** True for a `LedgerError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isLedgerError(err: unknown): err is LedgerError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'LedgerError' && typeof code === 'string' && typeof message === 'string'
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const fail = <C extends string>(code: C, message: string, field?: string): Result<never, C> =>
  ({ ok: false, error: field === undefined ? { code, message } : { code, message, field } })

/**
 * Runs `work` and turns a `LedgerError` into a failed `Result`, for IPC handlers whose view shows the error.
 * Anything else is rethrown: it is a bug, not something to show in a form.
 */
export async function toResult<T>(work: () => Promise<T>): Promise<Result<T, LedgerErrorCode>> {
  try {
    return ok(await work())
  } catch (err) {
    if (isLedgerError(err)) return fail(err.code, err.message, err.field)
    throw err
  }
}
