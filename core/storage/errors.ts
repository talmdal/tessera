// core/storage/errors.ts
import type { JsonObject, StorageErrorCode, StorageErrorLike } from '@tessera/types'

export class StorageError extends Error implements StorageErrorLike {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly details?: JsonObject,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export function isStorageError(err: unknown, code?: StorageErrorCode): err is StorageError {
  return err instanceof StorageError && (code === undefined || err.code === code)
}

export const unsupported = (what: string, details?: JsonObject) =>
  new StorageError('UNSUPPORTED_QUERY', `Unsupported query: ${what}`, details)

export const invalidDocument = (why: string, details?: JsonObject) =>
  new StorageError('INVALID_DOCUMENT', `Invalid document: ${why}`, details)

export const invalidUpdate = (why: string, details?: JsonObject) =>
  new StorageError('INVALID_UPDATE', `Invalid update: ${why}`, details)

export const invalidArgument = (why: string, details?: JsonObject) =>
  new StorageError('INVALID_ARGUMENT', why, details)
