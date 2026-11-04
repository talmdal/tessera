import type { DatabaseTarget, Doc, Json, StorageCapabilities } from '@tessera/types'
import type { IndexSpec } from './state'

/** What a backend is asked to make durable. A batch is atomic: all of it or none. */
export type StorageChange =
  /** Creates a collection or replaces its index definitions. */
  | { type: 'collection', name: string, indexes: IndexSpec[] }
  | { type: 'drop', name: string }
  | { type: 'rename', from: string, to: string }
  | { type: 'put', collection: string, doc: Doc }
  | { type: 'delete', collection: string, id: string }
  | { type: 'meta', key: string, value: Json | undefined }

export interface LoadedDatabase {
  collections: { name: string, indexes: IndexSpec[], docs: Doc[] }[]
  meta: Record<string, Json>
}

/**
 * One open database as a backend sees it. The kit keeps the live state in memory and does all the
 * querying; a backend only loads at open and persists each committed batch of changes.
 */
export interface StorageBackend {
  load(): Promise<LoadedDatabase>
  /** Persist the batch atomically (or, if buffered, accept it for the next flush). Throw if it can't be taken. */
  commit(changes: StorageChange[]): Promise<void>
  /** Make everything committed so far durable. */
  flush(): Promise<void>
  /** Flush and release the file. */
  close(): Promise<void>
}

/** A storage technology: how to open, list and drop its databases. */
export interface BackendDriver {
  readonly id: string
  readonly capabilities: StorageCapabilities
  open(target: DatabaseTarget, options: { readOnly: boolean }): Promise<StorageBackend>
  /** Names of the databases kept under the driver's own directory. */
  list(): Promise<string[]>
  /** Deletes a closed database's files. No error if it doesn't exist. */
  drop(target: DatabaseTarget): Promise<void>
}
