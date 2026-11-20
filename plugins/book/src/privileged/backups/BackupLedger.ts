// What this machine knows about each book's backups, kept in application state (tier 1), never in the book: writing
// "last backed up" into a book on close would itself be a change, and a copied book would carry a stale stamp.
// See docs/backup-restore-design.md, "Bookkeeping".
import type { AppState } from '@tessera/types'
import type { BackupHistory } from './schedule'

export const LEDGER_KEY = 'book.backups'

export interface LedgerEntry extends BackupHistory {
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

  private change(bookId: string, edit: (entry: LedgerEntry | undefined) => LedgerEntry): Promise<void> {
    return this.serial(async () => {
      const ledger = await this.all()
      ledger[bookId] = edit(ledger[bookId])
      await this.state.set(LEDGER_KEY, ledger)
    })
  }

  entry(bookId: string): Promise<LedgerEntry | undefined> {
    return this.serial(async () => (await this.all())[bookId])
  }

  /** Something was written to the book. */
  markChanged(bookId: string): Promise<void> {
    return this.change(bookId, entry => ({ ...entry, changed: true }))
  }

  /** A backup was written and verified. `changed` stays true if the book changed again while it was being written. */
  succeeded(bookId: string, backup: { at: Date, file: string, changed: boolean }): Promise<void> {
    return this.change(bookId, () => ({
      lastBackupAt: backup.at.toISOString(), lastFile: backup.file, lastResult: 'ok', changed: backup.changed
    }))
  }

  /** The attempt failed: the last good backup is kept, and the next close retries. */
  failed(bookId: string, error: string): Promise<void> {
    return this.change(bookId, entry => {
      const { lastError: _previous, ...kept } = entry ?? { changed: true }
      return { ...kept, lastResult: 'failed', lastError: error, changed: true }
    })
  }

  /** The attempt was cut short at quit: as a failure, retried at the next close. */
  interrupted(bookId: string): Promise<void> {
    return this.change(bookId, entry => {
      const { lastError: _previous, ...kept } = entry ?? { changed: true }
      return { ...kept, lastResult: 'interrupted', changed: true }
    })
  }
}
