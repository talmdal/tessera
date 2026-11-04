// The `book.session` service and the `book.schema` extension point: what other plugins build on.
import type { CollectionSchema, Database, Disposable, Event, Transaction as StorageTransaction } from '@tessera/types'
import type { BookChange, BookInfo, BookTree, SubBook } from './model'

/**
 * The `book.session` service: the open book file and its sub-book tree. One book is open at a time.
 *
 * Methods that can fail because of what the user did throw an error whose `code` is a `BookErrorCode`.
 */
export interface BookSession {
  readonly current: BookInfo | undefined

  /**
   * The open book's database, limited to collections named `<contributor>.*`: any other name is rejected, so a
   * plugin can't read or write another plugin's data by accident. Throws NO_BOOK when none is open.
   */
  database(contributor: string): Database

  // ---- Files

  /**
   * Creates a book file. Asks to close the open book first, and prompts for a location when `path` is
   * omitted, suggesting `options.name` as the file name. A file already at the path is sent to the trash (the save
   * dialog has asked). Resolves undefined if the user cancels at any step.
   */
  create(path?: string, options?: { name?: string }): Promise<BookInfo | undefined>
  /** Prompts when `path` is omitted. Closes the current book first. Resolves undefined if the user cancels. */
  open(path?: string): Promise<BookInfo | undefined>
  close(): Promise<void>
  /**
   * Confirms, closes the book if it is the one open, and sends the file to the OS trash (never deletes it).
   * Defaults to the open book. Resolves false if the user cancels.
   */
  delete(path?: string): Promise<boolean>

  // ---- The tree of the open book

  tree(): Promise<BookTree>
  createSubBook(input: { name: string, parentId: string | null, notes?: string }): Promise<SubBook>
  renameSubBook(id: string, name: string, options?: { expectedRev?: number }): Promise<SubBook>
  /** `to` is a sub-book id, or null for the book itself. `index` is the position among the new siblings. */
  moveSubBook(id: string, to: string | null, index?: number): Promise<void>
  /**
   * Moves everything in the sub-book to its parent (its sub-books, and every participant's items), then
   * deletes it, all in one storage transaction. Nothing in it is lost.
   */
  deleteSubBook(id: string): Promise<void>

  /** Registers a plugin that places items in sub-books. Dispose to stop participating. */
  participate(contributor: string, participant: SubBookParticipant): Disposable

  /**
   * Says that `contributor` shows the book tree in a view of its own (with its items in it), so the book's own
   * Book panel hides while any registration is held (context key `book.hasNavigator`). Push the disposable onto
   * your subscriptions: if your plugin goes away, the panel comes back.
   */
  registerNavigator(contributor: string): Disposable

  /** Runs, awaited, before the database closes, while it is still writable. */
  onWillClose(listener: (book: BookInfo) => void | Promise<void>): Disposable
  readonly onDidChange: Event<BookChange>
  /** After any sub-book is created, renamed, moved or deleted, and when a book opens. */
  readonly onDidChangeTree: Event<BookTree>
}

/** A plugin that keeps items in sub-books, and so must take part when one is deleted. */
export interface SubBookParticipant {
  /** For the delete confirmation: what this plugin keeps directly in the sub-book, e.g. "4 accounts". */
  describe(subBookId: string): Promise<string | undefined>
  /**
   * Inside the deleting transaction: move everything kept directly in `from` to `to` (null = the book itself).
   * `tx` is scoped to the participant's own collections. Throwing rolls the whole delete back.
   */
  reparent(tx: StorageTransaction, from: string, to: string | null): Promise<void>
}

/** A `book.schema` contribution: what a domain plugin stores in every book. */
export interface SchemaContribution {
  /** The contributing plugin id. Every collection name must start with `<id>.`. */
  id: string
  /** The contributor's current schema version, at least 1. */
  version: number
  collections: CollectionSchema[]
  /** Id of the service implementing `Migrator`, looked up when a book opens. */
  migrator: string
}

export interface Migrator {
  /**
   * Brings this contributor's data from `from` to `from + 1`. `from === 0` means the contributor has no data in
   * this book yet: a new book, or a plugin installed after the book was created. It seeds defaults. A backup
   * is taken first, and the version is recorded only after it returns, so it must be safe to run again.
   */
  migrate(db: Database, from: number): Promise<void>
}
