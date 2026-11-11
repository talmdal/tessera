// The `ledger.session` service and the `ledger.schema` extension point: what other plugins build on.
import type { CollectionSchema, Database, Disposable, Event, Transaction as StorageTransaction } from '@tessera/types'
import type { LedgerArchived, LedgerChange, LedgerInfo, LedgerTree, SubLedger } from './model'

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
   * Registers a plugin whose data an archive removes (File › Archive Ledger…). Participants run in the order they
   * joined, which follows activation, so a plugin runs after the plugins it requires. Dispose to stop participating.
   */
  participateInArchive(contributor: string, participant: ArchiveParticipant): Disposable
  /** After an archive has been committed: the archive date and the archive file. */
  readonly onDidArchive: Event<LedgerArchived>

  /**
   * Says that `contributor` shows the ledger tree in a view of its own (with its items in it), so the ledger's own
   * Ledger panel hides while any registration is held (context key `ledger.hasNavigator`). Push the disposable onto
   * your subscriptions: if your plugin goes away, the panel comes back.
   */
  registerNavigator(contributor: string): Disposable

  // ---- One long operation at a time

  /**
   * Marks the ledger busy with a long operation (an import, a backup, a restore) until the returned handle is
   * disposed. Throws BUSY while another operation runs, so only one runs at a time. While one runs, the file commands
   * (New, Open, Close, Delete) are disabled and their methods throw BUSY; reading and editing the ledger carry on.
   * `label` is for the user: "Importing statements". Session-wide: it works with no ledger open.
   */
  beginOperation(label: string): Disposable
  /** The running operation's label, or undefined. */
  readonly operation: string | undefined

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

/**
 * A plugin whose data an archive can remove. The ledger knows nothing about what is archived: it makes the archive
 * file, then runs every participant's `archive` in one storage transaction, so the archive happens whole or not at
 * all. See docs/ledger-compaction-design.md, "The participant contract".
 */
export interface ArchiveParticipant {
  /**
   * What archiving before `before` would remove from this plugin's data, for the Archive dialog. Reads only, and may
   * leave out what depends on other participants' choices. Undefined when there is nothing to say.
   */
  describe(before: string, options: Readonly<Record<string, boolean>>): Promise<ArchiveDescription | undefined>
  /**
   * Inside the archiving storage transaction, after the archive file has been made: removes what is no longer needed
   * from before `request.before`, and adjusts what stays so nothing the user sees changes. `tx` is limited to the
   * participant's own collections. Throwing rolls the whole archive back, for every participant. What it returns in
   * `shared` is given to the participants after it, in `request.earlier`.
   */
  archive(tx: StorageTransaction, request: ArchiveRequest): Promise<ArchiveResult>
  /** After the archive has been committed: announce changes, refresh views. Not called if it rolled back. */
  committed?(): void
}

export interface ArchiveRequest {
  /** YYYY-MM-DD: what occurred before this date may be archived. */
  before: string
  /** The user's choice for every option the participants offered (`ArchiveDescription.options`), by option id. */
  options: Readonly<Record<string, boolean>>
  /** What the participants before this one shared, by contributor id, in the order they ran. */
  earlier: ReadonlyMap<string, unknown>
}

export interface ArchiveDescription {
  /** How many records this removes, or would remove. An archive needs at least one, among all the participants. */
  count: number
  /** One line for the user: "1,204 transactions from 6 accounts". */
  summary: string
  /** Why something stays: "“Old Visa” is closed, but stays: its balance isn’t zero." Shown under the summary. */
  notes?: string[]
  /** What the user may want to deal with before archiving, shown as a warning. It doesn't stop the archive. */
  warnings?: ArchiveWarning[]
  /** Choices the participant offers, shown as check boxes; their values come back in `ArchiveRequest.options`. */
  options?: ArchiveOption[]
}

export interface ArchiveWarning {
  message: string
  /** Short lines under the message: "Chequing 9 · Visa 4". */
  details?: string[]
}

export interface ArchiveOption {
  /** `<contributor>.<name>`, like every contribution id. */
  id: string
  /** "Remove closed accounts with nothing left: “Old Visa”, “ING Savings”". */
  label: string
  default: boolean
}

/** What a participant's `archive` did, and what it passes to the participants after it. */
export interface ArchiveResult extends ArchiveDescription {
  shared?: unknown
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
