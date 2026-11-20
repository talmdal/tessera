// What this machine knows about each book's backups, kept in application state (tier 1), never in the book: writing
// "last backed up" into a book on close would itself be a change, and a copied book would carry a stale stamp.
// See docs/backup-restore-design.md, "Bookkeeping".
import type { AppState } from '@tessera/types'
import type { BackupHistory } from './schedule'

export const LEDGER_KEY = 'book.backups'

/** The book an entry is about, as it was last seen: so a book can be found by path when it is not open. */
export interface LedgerBook {
  id: string
  name: string
  path: string
}

/** Paths compare as the platform does, as the recent-books list compares them. */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

export interface LedgerEntry extends BackupHistory {
  /** The book's name and path when last seen. */
  name?: string
  path?: string
  /** The path of the last successful backup, for the status line. */
  lastFile?: string
  /** Why the last attempt failed, when it did. */
  lastError?: string
}

type Ledger = Record<string, LedgerEntry>

const RESULTS = ['ok', 'failed', 'interrupted']

/** An entry as stored, read defensively: anything malformed is dropped rather than trusted. */
function valid(entry: unknown): LedgerEntry | undefined {
  const e = entry as Partial<LedgerEntry> | null
  if (typeof e !== 'object' || e === null || typeof e.changed !== 'boolean') return undefined
  return {
    changed: e.changed,
    ...(typeof e.name === 'string' && { name: e.name }),
    ...(typeof e.path === 'string' && { path: e.path }),
    ...(typeof e.lastBackupAt === 'string' && { lastBackupAt: e.lastBackupAt }),
    ...(typeof e.lastFile === 'string' && { lastFile: e.lastFile }),
    ...(typeof e.lastResult === 'string' && RESULTS.includes(e.lastResult) && { lastResult: e.lastResult }),
    ...(typeof e.lastError === 'string' && { lastError: e.lastError })
  }
}

export class BackupLedger {
  /** Reads and writes run one at a time, so two writes for one book never lose each other's change. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly state: AppState) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async all(): Promise<Ledger> {
    const stored = await this.state.get<unknown>(LEDGER_KEY)
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
    const ledger: Ledger = {}
    for (const [bookId, entry] of Object.entries(stored)) {
      const checked = valid(entry)
      if (checked) ledger[bookId] = checked
    }
    return ledger
  }

  /** Edits one book's entry, recording its current name and path with it. */
  private change(book: LedgerBook, edit: (entry: LedgerEntry | undefined) => LedgerEntry): Promise<void> {
    return this.serial(async () => {
      const ledger = await this.all()
      ledger[book.id] = { ...edit(ledger[book.id]), name: book.name, path: book.path }
      await this.state.set(LEDGER_KEY, ledger)
    })
  }

  entry(bookId: string): Promise<LedgerEntry | undefined> {
    return this.serial(async () => (await this.all())[bookId])
  }

  /** The entry of the book last seen at `path`, with its id: for a book that isn't open, known only by its path. */
  byPath(path: string): Promise<(LedgerEntry & { id: string }) | undefined> {
    return this.serial(async () => {
      const found = Object.entries(await this.all()).find(([, entry]) => entry.path !== undefined && samePath(entry.path, path))
      return found && { ...found[1], id: found[0] }
    })
  }

  /**
   * Forgets the book last seen at `path`: it was deleted. Only the bookkeeping goes; its backup files stay where they
   * are, since someone who deletes a book may want it back. Resolves how many entries were removed.
   */
  forget(path: string): Promise<number> {
    return this.serial(async () => {
      const ledger = await this.all()
      const gone = Object.entries(ledger).filter(([, entry]) => entry.path !== undefined && samePath(entry.path, path))
      if (gone.length === 0) return 0
      for (const [bookId] of gone) delete ledger[bookId]
      await this.state.set(LEDGER_KEY, ledger)
      return gone.length
    })
  }

  /** Something was written to the book. */
  markChanged(book: LedgerBook): Promise<void> {
    return this.change(book, entry => ({ ...entry, changed: true }))
  }

  /** A backup was written and verified. `changed` stays true if the book changed again while it was being written. */
  succeeded(book: LedgerBook, backup: { at: Date, file: string, changed: boolean }): Promise<void> {
    return this.change(book, () => ({
      lastBackupAt: backup.at.toISOString(), lastFile: backup.file, lastResult: 'ok', changed: backup.changed
    }))
  }

  /** The attempt failed: the last good backup is kept, and the next close retries. */
  failed(book: LedgerBook, error: string): Promise<void> {
    return this.change(book, entry => {
      const { lastError: _previous, ...kept } = entry ?? { changed: true }
      return { ...kept, lastResult: 'failed', lastError: error, changed: true }
    })
  }

  /** The attempt was cut short at quit: as a failure, retried at the next close. */
  interrupted(book: LedgerBook): Promise<void> {
    return this.change(book, entry => {
      const { lastError: _previous, ...kept } = entry ?? { changed: true }
      return { ...kept, lastResult: 'interrupted', changed: true }
    })
  }
}
