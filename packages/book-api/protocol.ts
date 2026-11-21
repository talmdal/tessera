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

/** A book backup: one file holding a whole book. See docs/backup-restore-design.md, "The backup file". */
export const BACKUP_FILE_EXTENSION = '.tessera-backup'

/** The filter for dialogs that pick a backup. */
export const BACKUP_FILE_FILTER = { name: 'Tessera backup', extensions: [BACKUP_FILE_EXTENSION.slice(1)] }

/** The filter for dialogs that browse for archive books. */
export const ARCHIVE_FILE_FILTER = { name: 'Tessera archives', extensions: [BOOK_FILE_EXTENSION.slice(1)] }

/** Version of the book's own format (its meta keys and sub-book collection). */
export const BOOK_FORMAT_VERSION = 1

/** Stable format-v1 metadata keys; keep their original names for existing .tessera files. */
export const BOOK_META = {
  /** `BOOK_FORMAT_VERSION`. A file without it is not a book. */
  format: 'ledger.format',
  createdAt: 'ledger.createdAt',
  /** The application version that created the file. */
  createdWith: 'ledger.createdWith',
  /**
   * The book's stable id (a ULID): the same however the file is renamed or moved. Written at create; a book from
   * before ids existed is given one the first time it is opened writable. Backups are grouped by it.
   */
  id: 'ledger.bookId',
  /** On a book restored as a new book: `{ bookId, takenAt }` of the backup it came from. */
  restoredFrom: 'ledger.restoredFrom',
  /**
   * `true` on a book that can never be written — an archive. A property of the file, not of the volume it is on,
   * so it survives copies and moves. Honoured at open; never written by anything but the archive writer.
   */
  readOnly: 'ledger.readOnly',
  /** On an archive: an `ArchiveMarker` saying which book it was cut from, when, and through what date. */
  archive: 'ledger.archive',
  /** On a working book that has been archived: the latest cut-off. The next archive must be after it. */
  lastArchivedThrough: 'ledger.lastArchivedThrough',
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
  /** File › Back Up Now: a manual backup of the open book into the backup folder. Resolves the file written. */
  backupNow: 'book.backupNow',
  /** File › Back Up To…: a manual backup of the open book to a file chosen in a save dialog. */
  backupTo: 'book.backupTo',
  /** File › Restore from Backup…: the Restore dialog, then the restore it asks for. Resolves the restored book. */
  restore: 'book.restore',
  /** Opens Tools › Options at the Backups page: where the failed-backup warnings lead. */
  backupSettings: 'book.backupSettings',
  /** Opens Tools › Options at the Archive page. */
  archiveSettings: 'book.archiveSettings',
  /**
   * File › Archive… (phase 5; headless until then). Argument: `ArchiveArgs`. Writes a complete frozen copy of the
   * open book, then removes the settled transactions from before the cut-off. Resolves the `ArchiveOutcome`.
   */
  archive: 'book.archive',
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

/** Argument of `book.archive`. The removal options come from the book options (phase 8); until then, both on. */
export interface ArchiveArgs {
  /** The cut-off, `YYYY-MM-DD`: data before it is archived. */
  before: string
}

export const BOOK_CONTEXT_KEYS = {
  isOpen: 'book.isOpen',
  isReadOnly: 'book.isReadOnly',
  /** The open book is an archive (`BookInfo.archive` is set): shows the archive status text. */
  isArchive: 'book.isArchive',
  /** The archive's cut-off as a person reads it, e.g. `1 Jan 2026`, for status text. */
  archiveThrough: 'book.archiveThrough',
  /** The open book's name, for status text such as `Book: {book.name}`. */
  name: 'book.name',
  /** Another plugin's view shows the book tree (`registerNavigator`), so the Book panel is hidden. */
  hasNavigator: 'book.hasNavigator',
  /** The open (or last opened) book's last automatic backup failed or was cut short: shows the warning. */
  backupFailed: 'book.backup.failed'
} as const

/** The Backups options page's id, for opening the options dialog at it. */
export const BOOK_BACKUPS_OPTIONS_PAGE = 'book.options.backups'
/** The Archive options page's id. */
export const BOOK_ARCHIVE_OPTIONS_PAGE = 'book.options.archive'

const channel = (event: string) => channelFor(BOOK_PLUGIN_ID, event)

/** Requests, renderer → main. */
export const BOOK_CHANNELS = {
  /** → `Result<ArchiveDialogInput>`: what the Archive dialog opens with. */
  archiveInput: channel('archive.input'),
  /** `{ before }` → `Result<ArchivePlan>`: what archiving before that date would do, recomputed as the date moves. */
  archivePlan: channel('archive.plan'),
  /**
   * `ArchiveRunRequest` → `Result<ArchiveOutcome | null>`: confirms (in the main process), optionally backs up
   * first, and archives. Null when the user cancelled the confirmation: the dialog stays open.
   */
  archiveRun: channel('archive.run'),
  backupsStatus: channel('backups.status'),
  /**
   * `{ current?, defaultPath?, title? }` → the chosen folder's path, or undefined if cancelled. The caller chooses
   * a starting folder and title so the same picker serves backups and archives.
   */
  chooseFolder: channel('chooseFolder'),
  /** → `ArchiveOptionsStatus`, available with or without an open book. */
  archiveStatus: channel('archive.status'),
  /** `{ folder?: string }` → `BackupInfo[]`: the backups in a folder (the backup folder by default), newest first. */
  backupsList: channel('backups.list'),
  /** → `BackupInfo`, or undefined if cancelled: picks a backup file anywhere, with an open dialog. */
  backupsChoose: channel('backups.choose'),
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
  /** `BackupStatus`, after each backup attempt and when the book it describes changes. */
  backups: channel('backups.changed'),
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
  renameSubBook: 'book.dialog.rename',
  /** Input `RestoreDialogInput`, result `RestoreDialogResult`. */
  restore: 'book.dialog.restore',
  /** Input `ArchiveDialogInput`, result `ArchiveOutcome` (the dialog runs the archive itself, through IPC). */
  archive: 'book.dialog.archive'
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
