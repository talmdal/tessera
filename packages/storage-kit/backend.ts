import type { DatabaseTarget, Doc, Json, SnapshotOptions, StorageCapabilities } from '@tessera/types'
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
  /**
   * Write a consistent copy of everything committed to a new file at `file`, which must not exist (StorageError
   * INVALID_ARGUMENT if it does), with `options.meta` merged into the copy's meta only. Commits may arrive meanwhile;
   * the copy is one committed state. Check the copy before resolving. On any failure leave nothing at `file`; when
   * `options.signal` aborts, reject with StorageError ABORTED. Call `onProgress` with 1 at the end.
   */
  snapshot(file: string, options: SnapshotOptions): Promise<void>
  /**
   * Make the stored file as small as its contents allow, without changing them. Called under the commit lock, with no
   * snapshot running. Throw (a StorageError IO, with a reason) if it can't be done; nothing may change then.
   */
  compact(): Promise<void>
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
  /**
   * A closed database's meta, without loading its documents or writing anything; `{}` for a readable file with no
   * meta. StorageError NOT_FOUND when there is no such database.
   */
  readMeta(target: DatabaseTarget): Promise<Record<string, Json>>
  /** Deletes a closed database's files. No error if it doesn't exist. */
  drop(target: DatabaseTarget): Promise<void>
}
