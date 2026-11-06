// The `ledger.session` service and the `ledger.schema` extension point: what other plugins build on.
import type { CollectionSchema, Database, Disposable, Event, Transaction as StorageTransaction } from '@tessera/types'
import type { LedgerChange, LedgerInfo, LedgerTree, SubLedger } from './model'

/**
 * The `ledger.session` service: the open ledger file and its sub-ledger tree. One ledger is open at a time.
 *
 * Methods that can fail because of what the user did throw an error whose `code` is a `LedgerErrorCode`.
 */
export interface LedgerSession {
  readonly current: LedgerInfo | undefined

  /**
   * The open ledger's database, limited to collections named `<contributor>.*`: any other name is rejected, so a
   * plugin can't read or write another plugin's data by accident. Throws NO_LEDGER when none is open.
   */
  database(contributor: string): Database

  // ---- Files

  /**
   * Creates a ledger file. Asks to close the open ledger first, and prompts for a location when `path` is
   * omitted, suggesting `options.name` as the file name. A file already at the path is sent to the trash (the save
   * dialog has asked). Resolves undefined if the user cancels at any step.
   */
  create(path?: string, options?: { name?: string }): Promise<LedgerInfo | undefined>
  /** Prompts when `path` is omitted. Closes the current ledger first. Resolves undefined if the user cancels. */
  open(path?: string): Promise<LedgerInfo | undefined>
  close(): Promise<void>
  /**
   * Confirms, closes the ledger if it is the one open, and sends the file to the OS trash (never deletes it).
   * Defaults to the open ledger. Resolves false if the user cancels.
   */
  delete(path?: string): Promise<boolean>

  // ---- The tree of the open ledger

  tree(): Promise<LedgerTree>
  createSubLedger(input: { name: string, parentId: string | null, notes?: string }): Promise<SubLedger>
  renameSubLedger(id: string, name: string, options?: { expectedRev?: number }): Promise<SubLedger>
  /** `to` is a sub-ledger id, or null for the ledger itself. `index` is the position among the new siblings. */
  moveSubLedger(id: string, to: string | null, index?: number): Promise<void>
  /**
   * Moves everything in the sub-ledger to its parent (its sub-ledgers, and every participant's items), then
   * deletes it, all in one storage transaction. Nothing in it is lost.
   */
  deleteSubLedger(id: string): Promise<void>

  /** Registers a plugin that places items in sub-ledgers. Dispose to stop participating. */
  participate(contributor: string, participant: SubLedgerParticipant): Disposable

  /**
   * Says that `contributor` shows the ledger tree in a view of its own (with its items in it), so the ledger's own
   * Ledger panel hides while any registration is held (context key `ledger.hasNavigator`). Push the disposable onto
   * your subscriptions: if your plugin goes away, the panel comes back.
   */
  registerNavigator(contributor: string): Disposable

  /** Runs, awaited, before the database closes, while it is still writable. */
  onWillClose(listener: (ledger: LedgerInfo) => void | Promise<void>): Disposable
  readonly onDidChange: Event<LedgerChange>
  /** After any sub-ledger is created, renamed, moved or deleted, and when a ledger opens. */
  readonly onDidChangeTree: Event<LedgerTree>
}

/** A plugin that keeps items in sub-ledgers, and so must take part when one is deleted. */
export interface SubLedgerParticipant {
  /** For the delete confirmation: what this plugin keeps directly in the sub-ledger, e.g. "4 accounts". */
  describe(subLedgerId: string): Promise<string | undefined>
  /**
   * Inside the deleting transaction: move everything kept directly in `from` to `to` (null = the ledger itself).
   * `tx` is scoped to the participant's own collections. Throwing rolls the whole delete back.
   */
  reparent(tx: StorageTransaction, from: string, to: string | null): Promise<void>
}

/** A `ledger.schema` contribution: what a domain plugin stores in every ledger. */
export interface SchemaContribution {
  /** The contributing plugin id. Every collection name must start with `<id>.`. */
  id: string
  /** The contributor's current schema version, at least 1. */
  version: number
  collections: CollectionSchema[]
  /** Id of the service implementing `Migrator`, looked up when a ledger opens. */
  migrator: string
}

export interface Migrator {
  /**
   * Brings this contributor's data from `from` to `from + 1`. `from === 0` means the contributor has no data in
   * this ledger yet: a new ledger, or a plugin installed after the ledger was created. It seeds defaults. A backup
   * is taken first, and the version is recorded only after it returns, so it must be safe to run again.
   */
  migrate(db: Database, from: number): Promise<void>
}
