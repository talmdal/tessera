// The ledger's data: the file that is open, and the tree of sub-ledgers inside it.
// See docs/account-manager-design.md, "The ledger".

/** The open ledger file. */
export interface LedgerInfo {
  path: string
  /** The file name without `.tessera`; shown in the title, the status bar and the start view. */
  name: string
  readOnly: boolean
  /**
   * The ledger's identity (`ledger.id` in its meta). Absent for an older ledger opened read-only, which hasn't been
   * given one yet, and for an archive file open for viewing: it shares its ledger's id, and isn't that ledger.
   */
  id?: string
  /** Set when this is an archive file, open read-only for viewing (File › Open Ledger… on a `.tesserabkp` archive). */
  archive?: LedgerArchiveInfo
}

/** What an open archive file is. */
export interface LedgerArchiveInfo {
  /** The archive date, YYYY-MM-DD: the ledger as it was just before archiving what occurred before it. */
  before: string
  /** When the archive file was made, ISO 8601, UTC. */
  takenAt: string
  /** The name of the ledger it was made from. */
  ledgerName: string
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

/**
 * One archive of the ledger, kept in the ledger's own `ledger.archives` collection, written in the same storage
 * transaction as the removal. See docs/ledger-compaction-design.md, "The ledger's record of its archives".
 */
export interface ArchiveRecord {
  id: string
  /** The archive date, YYYY-MM-DD: what was removed occurred before it. */
  before: string
  /** When the archive was made, ISO 8601, UTC. */
  archivedAt: string
  /** The archive file made first, as it was saved: it may have moved since. */
  copy: { path: string, takenAt: string }
  /** How many records the participants removed, in all. */
  count: number
  /** What each participant removed, for the user: "1,204 transactions from 6 accounts". */
  summaries: string[]
  rev: number
}

/**
 * What compacting the ledger's file did, the archive's last step: its size on disk (with its side files) before and
 * after, in bytes; or why it couldn't be made smaller. The archive stands either way.
 */
export type ArchiveCompaction = { before: number, after: number } | { problem: string }

/**
 * What an archive did: the record it wrote, without its storage fields; and, from File › Archive Ledger…, what
 * compacting the file did.
 */
export type ArchiveOutcome = Omit<ArchiveRecord, 'id' | 'rev'> & { compaction?: ArchiveCompaction }

/** `LedgerSession.onDidArchive`: an archive has been committed. */
export interface LedgerArchived {
  before: string
  /** The archive file's path. */
  copy: string
}

/** A ledger in the recent list (kept in `app.state`). */
export interface RecentLedger {
  path: string
  name: string
  /** ISO timestamp of the last time it was opened. */
  openedAt: string
  /** The ledger's identity, when it had one: how a backup finds the ledger it came from. */
  id?: string
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
