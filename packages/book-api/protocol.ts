// Every name the book plugin publishes: ids, commands, context keys, IPC channels, events, views and dialogs.
// Both halves of the plugin, other plugins and the tests use these constants, never the strings.
import { channelFor } from '@tessera/types'
import type { BookTree } from './model'

export const BOOK_PLUGIN_ID = 'book'

/** The service other plugins require: `BookSession`. */
export const BOOK_SESSION_SERVICE = 'book.session'

/** Extension point for `SchemaContribution`s. */
export const BOOK_SCHEMA_POINT = 'book.schema'

/** A book file's extension, with its dot. */
export const BOOK_FILE_EXTENSION = '.tessera'

/** The filter for open and save dialogs. */
export const BOOK_FILE_FILTER = { name: 'Tessera book', extensions: [BOOK_FILE_EXTENSION.slice(1)] }

/** Version of the book's own format (its meta keys and sub-book collection). */
export const BOOK_FORMAT_VERSION = 1

/** Stable format-v1 metadata keys; keep their original names for existing .tessera files. */
export const BOOK_META = {
  /** `BOOK_FORMAT_VERSION`. A file without it is not a book. */
  format: 'ledger.format',
  createdAt: 'ledger.createdAt',
  /** The application version that created the file. */
  createdWith: 'ledger.createdWith',
  /** The schema version of a `book.schema` contributor. */
  schemaVersion: (contributor: string) => `ledger.schema.${contributor}`
} as const

/** The book's own collections, part of the book format rather than a schema contribution. */
export const BOOK_COLLECTIONS = {
  subBooks: 'ledger.subledgers'
} as const

export const BOOK_COMMANDS = {
  /** File › New Book…. Argument (optional): `NewBookArgs`. */
  new: 'book.new',
  /** File › Open Book…. */
  open: 'book.open',
  /** File › Close Book. */
  close: 'book.close',
  /** File › Delete Book…: sends the open book's file to the trash. */
  delete: 'book.delete',
  /** Argument: `{ id }`. No menu item of its own; the accounts navigator and menu run it. */
  renameSubBook: 'book.subBook.rename',
  /** Argument: `{ id }`. Moves the sub-book's contents up to its parent, then deletes it. */
  deleteSubBook: 'book.subBook.delete'
} as const

/** Argument of `book.new`. With `parentId` (null = the book itself), the dialog starts with that parent chosen. */
export interface NewBookArgs {
  parentId?: string | null
}

/** Argument of the sub-book commands. */
export interface SubBookArgs {
  id: string
}

export const BOOK_CONTEXT_KEYS = {
  isOpen: 'book.isOpen',
  isReadOnly: 'book.isReadOnly',
  /** The open book's name, for status text such as `Book: {book.name}`. */
  name: 'book.name',
  /** Another plugin's view shows the book tree (`registerNavigator`), so the Book panel is hidden. */
  hasNavigator: 'book.hasNavigator'
} as const

const channel = (event: string) => channelFor(BOOK_PLUGIN_ID, event)

/** Requests, renderer → main. */
export const BOOK_CHANNELS = {
  /** → `BookState`. */
  state: channel('state'),
  /** → `RecentBook[]`, with `exists` filled in. */
  recent: channel('recent'),
  /** `{ path }` → void. Removes an entry from the recent list; the file is untouched. */
  recentRemove: channel('recent.remove'),
  /** `{ path }` → `Result<BookInfo | undefined, BookErrorCode>`. Opens a recent book, as the command does. */
  open: channel('open'),
  /** `{ path }` → boolean. Sends a recent book's file to the trash, after confirming. */
  delete: channel('delete'),
  /** → `BookTree`, or null when no book is open. */
  tree: channel('tree'),
  /** `{ name, parentId }` → `Result<SubBook, BookErrorCode>`. Used by the New Book dialog. */
  createSubBook: channel('subBook.create'),
  /** `{ id, name, expectedRev? }` → `Result<SubBook, BookErrorCode>`. Used by the rename dialog. */
  renameSubBook: channel('subBook.rename')
} as const

/** Push events, main → renderer. Each carries the whole new value, so a repeat is harmless. */
export const BOOK_EVENTS = {
  /** `BookState`. */
  state: channel('state.changed'),
  /** `BookTree`, or null when the book closed. */
  tree: channel('tree.changed'),
  /** `RecentBook[]`, with `exists` filled in. */
  recent: channel('recent.changed')
} as const

// Layout preferences persist active view IDs, so keep these stable across the rename.
export const BOOK_VIEWS = {
  /** The main-area page shown while no book is open: New, Open, recent books. */
  start: 'ledger.start',
  /** The left-bar tree of the open book and its sub-books, hidden while another plugin's navigator shows it. */
  tree: 'ledger.tree'
} as const

/** `shell.dialogs` contributions, shown with `shell.prompts.show`. */
export const BOOK_DIALOGS = {
  /** Input `NewBookDialogInput`, result `NewBookDialogResult`. */
  newBook: 'book.dialog.new',
  /** Input `RenameSubBookDialogInput`, result `{ id }`. */
  renameSubBook: 'book.dialog.rename'
} as const

export interface NewBookDialogInput {
  tree: BookTree
  /** The parent chosen when the dialog opens: a sub-book id, null for the book, or undefined for None. */
  parentId?: string | null
}

/**
 * What the New Book dialog closed with. A sub-book has already been created by the dialog (so a duplicate name
 * could be shown inline); a file is created by the command afterwards, after asking to close the open book.
 */
export type NewBookDialogResult =
  | { kind: 'subBook', id: string }
  | { kind: 'file', name: string }

export interface RenameSubBookDialogInput {
  id: string
  name: string
  rev: number
}
