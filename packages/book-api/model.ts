// The book's data: the file that is open, and the tree of sub-books inside it.
// See docs/account-manager-design.md, "The book".

/** The open book file. */
export interface BookInfo {
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
  | { type: 'opened', book: BookInfo, created: boolean }
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
