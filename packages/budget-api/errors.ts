// Error codes for `budget.service`. Replies use `Result` from @tessera/ledger-api.
import type { Result } from '@tessera/ledger-api'

export type BudgetErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** The ledger was opened read-only (an archive file). */
  | 'READ_ONLY'
  /** A budget, line, sub-ledger, category or account doesn't exist. */
  | 'NOT_FOUND'
  /** A field is missing or malformed; `field` names it. */
  | 'INVALID'
  /** A budget with this name exists, ignoring case. */
  | 'DUPLICATE_NAME'
  /** The category, or the account of a transfer line, already has a line in this budget. */
  | 'DUPLICATE_LINE'
  /** `expectedRev` didn't match: it was changed elsewhere. */
  | 'CONFLICT'

/**
 * What `budget.service` throws for something the user caused. Each plugin bundles its own copy of this package, so
 * test with `isBudgetError`, never `instanceof`.
 */
export class BudgetError extends Error {
  override readonly name = 'BudgetError'

  constructor(readonly code: BudgetErrorCode, message: string, readonly field?: string) {
    super(message)
  }
}

/** True for a `BudgetError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isBudgetError(err: unknown): err is BudgetError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'BudgetError' && typeof code === 'string' && typeof message === 'string'
}

/** A budget reply, for a view: the value, or what went wrong. */
export type BudgetResult<T> = Result<T, BudgetErrorCode>

/** Runs `work`, turning a `BudgetError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toBudgetResult<T>(work: () => Promise<T>): Promise<BudgetResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isBudgetError(err)) throw err
    return { ok: false, error: { code: err.code, message: err.message, ...(err.field !== undefined && { field: err.field }) } }
  }
}
