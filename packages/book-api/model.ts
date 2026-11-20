// The book's data: the file that is open, and the tree of sub-books inside it.
// See docs/account-manager-design.md, "The book".

/** The open book file. */
export interface BookInfo {
  /**
   * Stable across renames and moves: `BOOK_META.id`. A read-only book that has none yet is known by an id derived
   * from its path (`path-…`) until it is opened writable and given one.
   */
  id: string
  path: string
  /** The file name without `.tessera`; shown in the title, the status bar and the start view. */
  name: string
  readOnly: boolean
}

/** A container inside a book, stored in the book's own `ledger.subledgers` collection. */
export interface SubBook {
  id: string
  /** The containing sub-book, or null when it sits directly in the book. */
  parentId: string | null
  name: string
  /** Position among its siblings; lower first. */
  order: number
  notes?: string
  /** The storage revision, for `expectedRev` on updates. */
  rev: number
}

/** The open book and every sub-book in it. */
export interface BookTree {
  book: BookInfo
  /** Every sub-book, in no particular order: build the tree from `parentId` and `order`. */
  subBooks: SubBook[]
}

export type BookChange =
  /** `migrated`: opening ran migrations, so the data changed before anyone could see it change. */
  | { type: 'opened', book: BookInfo, created: boolean, migrated: boolean }
  | { type: 'closed', book: BookInfo }

/** A book in the recent list (kept in `app.state`). */
export interface RecentBook {
  path: string
  name: string
  /** ISO timestamp of the last time it was opened. */
  openedAt: string
  /** Filled in when the list is requested: whether the file is still there. */
  exists?: boolean
}

/** What the start view and status bar show, pushed as `book:state`. */
export interface BookState {
  isOpen: boolean
  book?: BookInfo
  /** The last failure to open (at start-up, or from the start view), shown instead of a modal. */
  error?: string
}

/**
 * Why a backup was taken: automatically at close, by the user (Back Up Now, Back Up To…), or as the safety copy of
 * a book about to be replaced by a restore. Only automatic backups are ever pruned.
 */
export type BackupTrigger = 'auto' | 'manual' | 'pre-restore'

/**
 * What the Backups options page shows under "Last backup": status, not an option, so never part of the draft. Pushed
 * as `book:backups.changed` after every backup attempt and whenever the book it is about changes.
 */
export interface BackupStatus {
  /** The open book, or the most recently opened one when none is open; absent when there is neither. */
  book?: { id?: string, name: string }
  /** ISO time of the book's last successful backup on this machine. */
  lastBackupAt?: string
  /** Its path. */
  lastFile?: string
  lastResult?: 'ok' | 'failed' | 'interrupted'
  /** Why the last attempt failed, when it did. */
  lastError?: string
  /** Where backups go when no folder is chosen: `<Documents>/Tessera Backups`, resolved on this machine. */
  defaultFolder: string
}

/** One backup file, as the Restore dialog lists it: read from its header only, never restored to find out. */
export interface BackupInfo {
  file: string
  sizeBytes: number
  /** Absent when the file can't be read as a backup; `problem` then says why. */
  header?: {
    bookId: string
    bookName: string
    /** Where the book was when backed up: only to suggest where a restored copy might go. */
    bookPath: string
    /** ISO timestamp. */
    takenAt: string
    trigger: BackupTrigger
    /** What wrote it, e.g. `book 0.1.0`. */
    app: string
    engine: string
    documents: number
  }
  /** Why this Tessera can't restore it, when it can't: listed, but not offered. */
  problem?: string
}

/** What the Restore dialog is shown with. */
export interface RestoreDialogInput {
  /** The open book, which "Replace the open book" would replace; absent when none is open. */
  open?: { id: string, name: string, readOnly: boolean }
  /** The backup folder the list starts in. */
  folder: string
}

/** What the Restore dialog closes with: which backup, and whether it replaces the open book or becomes a new one. */
export interface RestoreDialogResult {
  file: string
  target: 'replace' | 'new'
}

/** Where a restore goes: over the open book, or into a new book file at `path`. */
export type RestoreTarget = { kind: 'replace' } | { kind: 'new', path: string }
