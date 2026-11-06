// The ledger's data: the file that is open, and the tree of sub-ledgers inside it.
// See docs/account-manager-design.md, "The ledger".

/** The open ledger file. */
export interface LedgerInfo {
  path: string
  /** The file name without `.tessera`; shown in the title, the status bar and the start view. */
  name: string
  readOnly: boolean
}

/** A container inside a ledger, stored in the ledger's own `ledger.subledgers` collection. */
export interface SubLedger {
  id: string
  /** The containing sub-ledger, or null when it sits directly in the ledger. */
  parentId: string | null
  name: string
  /** Position among its siblings; lower first. */
  order: number
  notes?: string
  /** The storage revision, for `expectedRev` on updates. */
  rev: number
}

/** The open ledger and every sub-ledger in it. */
export interface LedgerTree {
  ledger: LedgerInfo
  /** Every sub-ledger, in no particular order: build the tree from `parentId` and `order`. */
  subLedgers: SubLedger[]
}

export type LedgerChange =
  | { type: 'opened', ledger: LedgerInfo, created: boolean }
  | { type: 'closed', ledger: LedgerInfo }

/** A ledger in the recent list (kept in `app.state`). */
export interface RecentLedger {
  path: string
  name: string
  /** ISO timestamp of the last time it was opened. */
  openedAt: string
  /** Filled in when the list is requested: whether the file is still there. */
  exists?: boolean
}

/** What the start view and status bar show, pushed as `ledger:state`. */
export interface LedgerState {
  isOpen: boolean
  ledger?: LedgerInfo
  /** The last failure to open (at start-up, or from the start view), shown instead of a modal. */
  error?: string
}
