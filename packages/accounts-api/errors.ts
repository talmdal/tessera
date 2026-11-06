// Error codes for `accounts.service` and the accounts IPC. Replies use `Result` from @tessera/ledger-api.
import type { Result } from '@tessera/ledger-api'

export type AccountsErrorCode =
  /** No ledger is open. */
  | 'NO_LEDGER'
  /** The ledger was opened read-only. */
  | 'READ_ONLY'
  /** An account (or the sub-ledger named for it) doesn't exist. */
  | 'NOT_FOUND'
  /** A field is missing or malformed; `field` names it. */
  | 'INVALID'
  /** An account with this name exists, ignoring case. */
  | 'DUPLICATE_NAME'
  /** The account is closed, so it is read-only. */
  | 'ACCOUNT_CLOSED'
  /** A transfer between accounts in different currencies (transactions, later). */
  | 'CURRENCY_MISMATCH'
  /** `expectedRev` didn't match: it was changed elsewhere. */
  | 'CONFLICT'
  /** The change needs the user's confirmation first; `reasons` says which, and the caller resends with `confirm`. */
  | 'CONFIRMATION_REQUIRED'

/** Confirmations a caller obtains from the user and passes back in `WriteOptions.confirm`. */
export type Confirmation =
  /** Changing or deleting a reconciled transaction, or one whose transfer counterpart is reconciled (later). */
  | 'reconciled'
  /** Closing an account whose balance isn't zero. */
  | 'closeWithBalance'
  /** Finishing a reconciliation with a difference, by adding a balance adjustment. */
  | 'adjustBalance'

/**
 * What `accounts.service` throws for something the user caused. Each plugin bundles its own copy of this package, so
 * test with `isAccountsError`, never `instanceof`.
 */
export class AccountsError extends Error {
  override readonly name = 'AccountsError'

  constructor(
    readonly code: AccountsErrorCode,
    message: string,
    readonly field?: string,
    readonly reasons?: Confirmation[]
  ) {
    super(message)
  }
}

/** True for an `AccountsError` from any plugin's copy of this package: it checks the shape, not the class. */
export function isAccountsError(err: unknown): err is AccountsError {
  if (typeof err !== 'object' || err === null) return false
  const { name, code, message } = err as Record<string, unknown>
  return name === 'AccountsError' && typeof code === 'string' && typeof message === 'string'
}

/** An accounts reply: as `Result`, and for CONFIRMATION_REQUIRED, the confirmations needed. */
export type AccountsResult<T> =
  | Extract<Result<T, AccountsErrorCode>, { ok: true }>
  | { ok: false, error: { code: AccountsErrorCode, message: string, field?: string, reasons?: Confirmation[] } }

/** Runs `work`, turning an `AccountsError` into a failed result for a view; anything else (a bug) is rethrown. */
export async function toAccountsResult<T>(work: () => Promise<T>): Promise<AccountsResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (!isAccountsError(err)) throw err
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
