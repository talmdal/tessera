import type { StorageErrorCode, StorageErrorLike } from '@tessera/types'

export class StorageError extends Error implements StorageErrorLike {
  constructor(readonly code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export const isStorageError = (err: unknown): err is StorageError => err instanceof StorageError

/** Wraps anything thrown by a backend as an IO error, leaving storage errors as they are. */
export function ioError(message: string, cause: unknown): StorageError {
  if (cause instanceof StorageError) return cause
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new StorageError('IO', `${message}: ${detail}`, { cause })
}
