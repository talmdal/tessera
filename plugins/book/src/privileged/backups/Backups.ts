// Automatic backups, taken when a book closes. See docs/backup-restore-design.md, "Automatic backups".
//
// Closing never waits on a backup: a close listener takes an in-memory snapshot (fast) and queues the write; the
// book then flushes and closes as before. Close listeners run last registered first, and `attach` is called as the
// book plugin activates, before any other plugin can reach `book.session`, so this one always runs last. Writes, verification, pruning and bookkeeping run after, one at
// a time. On quit, `drain` gives the queue a budget inside the shell's shutdown limit and abandons what is left.
import path from 'node:path'
import type { Writable } from 'node:stream'
import type { Database, DatabaseSnapshot, Disposable, Event, Logger, ShellFiles } from '@tessera/types'
import {
  BOOK_API_VERSION, BookError, DEFAULT_BACKUP_FOLDER_NAME, type BackupTrigger, type BookBackupOptions, type BookChange,
  type BookInfo
} from '@tessera/book-api'
import type { BackupDisk } from './BackupDisk'
import { backupHeader, readBackupHeader, verifyBackup, writeBackup } from './backupFile'
import type { BackupLedger } from './BackupLedger'
import { backupFileName } from './naming'
import { isBackupDue } from './schedule'

/** How long quitting waits for backups still being written: inside the shell's 10 s limit for shutdown listeners. */
export const BACKUP_SHUTDOWN_BUDGET_MS = 6000
/** After abandoning, how long to wait for the partial file to be removed and the attempt recorded. */
export const ABANDON_GRACE_MS = 1000
/** A partial file older than this was left by a write that will never finish. */
export const STALE_PARTIAL_MS = 60 * 60 * 1000

/** What backups need of the session: `BookSessionImpl` is one. The unscoped database is the book plugin's alone. */
export interface BackupsSession {
  onWillClose(listener: (book: BookInfo) => void | Promise<void>): Disposable
  readonly onDidChange: Event<BookChange>
  unscopedDatabase(): Database
}

export interface BackUpNowOptions {
  /** An exact file to write (Back Up To…); otherwise a new file in the backup folder. */
  to?: string
  /** `pre-restore` for the safety copy a restore takes; `manual` otherwise. */
  trigger?: 'manual' | 'pre-restore'
  /** Whether it may count as the book's last backup (only ever in the backup folder). Default true. */
  record?: boolean
}

export interface BackupsDeps {
  disk: BackupDisk
  ledger: BackupLedger
  files: Pick<ShellFiles, 'trash' | 'documentsPath'>
  /** The current backup options, read at each close, so a change applies from the next one. */
  options: () => BookBackupOptions
  /** The storage engine's id, recorded in each backup's header. */
  engineId: string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => Date
}

/** One backup waiting to be written, or being written. */
interface Job {
  book: BookInfo
  snapshot: DatabaseSnapshot
  takenAt: Date
  /** The book's change count when the snapshot was taken: a change after it means the book still needs a backup. */
  epoch: number
  abort: AbortController
  trigger: BackupTrigger
  /** A manual backup to an exact file (Back Up To…); otherwise a new file in the backup folder. */
  to?: string
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

/** Resolves true if `work` is still running after `ms`. */
async function outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), ms) })
  try {
    return await Promise.race([work.then(() => false), late])
  } finally {
    clearTimeout(timer)
  }
}

export class Backups {
  private queue: Promise<void> = Promise.resolve()
  private readonly jobs = new Set<Job>()
  /** Changes seen per book in this process, so a change during a write isn't cleared by that write finishing. */
  private readonly epochs = new Map<string, number>()
  /** Books changed in their current session: known at once, before the ledger write that records it lands. */
  private readonly changedNow = new Set<string>()
  private watching: Disposable | undefined
  private shuttingDown = false
  private readonly recordListeners = new Set<(book: BookInfo) => void>()

  constructor(private readonly deps: BackupsDeps) {}

  /**
   * Starts backing up the session's books. Call it as soon as the session exists, before anything else registers a
   * close listener: listeners run last registered first, and this one must run last, after every other plugin's.
   */
  attach(session: BackupsSession): Disposable[] {
    return [
      session.onDidChange(change => {
        if (change.type === 'opened') this.opened(session.unscopedDatabase(), change.book, change.migrated)
      }),
      session.onWillClose(book => this.closing(session.unscopedDatabase(), book))
    ]
  }

  private get now() { return this.deps.now ?? (() => new Date()) }

  /** Resolves once every backup queued so far has been written, or has failed. For tests and for `drain`. */
  idle(): Promise<void> {
    return this.queue
  }

  // ---- Tracking changes while a book is open

  private opened(db: Database, book: BookInfo, migrated: boolean) {
    this.changedNow.delete(book.id)
    // A migration changed the data before anyone could see it change: it still needs backing up
    if (migrated) this.changed(book)
    this.watch(db, book)
  }

  /** Waits for the book's next change. Only the first counts: one ledger write per session, not one per edit. */
  private watch(db: Database, book: BookInfo) {
    this.watching?.dispose()
    const watch = db.onDidChange(() => {
      watch.dispose()
      if (this.watching === watch) this.watching = undefined
      this.changed(book)
    })
    this.watching = watch
  }

  private changed(book: BookInfo) {
    this.epochs.set(book.id, (this.epochs.get(book.id) ?? 0) + 1)
    if (this.changedNow.has(book.id)) return
    this.changedNow.add(book.id)
    this.deps.ledger.markChanged(book)
      .catch(err => this.deps.log.warn(`[book] Could not record that “${book.name}” changed: ${describe(err)}`))
  }

  // ---- Closing

  /** The last close listener, before the book flushes: decide, snapshot, queue. Never writes. */
  private async closing(db: Database, book: BookInfo): Promise<void> {
    this.watching?.dispose()
    this.watching = undefined
    const options = this.deps.options()
    const entry = await this.deps.ledger.entry(book.id)
    const history = { ...entry, changed: Boolean(entry?.changed) || this.changedNow.has(book.id) }
    this.changedNow.delete(book.id)
    const takenAt = this.now()
    if (!isBackupDue(history, options, takenAt)) return

    let snapshot: DatabaseSnapshot
    try {
      snapshot = await db.snapshot()
    } catch (err) {
      // The book still closes; the next close tries again
      await this.deps.ledger.failed(book, describe(err)).catch(() => {})
      this.recorded(book)
      this.deps.log.warn(`[book] Automatic backup of “${book.name}” failed: could not copy the book: ${describe(err)}`)
      return
    }
    this.enqueue({ book, snapshot, takenAt, epoch: this.epochs.get(book.id) ?? 0, abort: new AbortController(), trigger: 'auto' }, job => this.run(job))
  }

  /** Queues a job behind every backup already queued; resolves with what `work` makes of it. */
  private enqueue<T>(job: Job, work: (job: Job) => Promise<T>): Promise<T> {
    this.jobs.add(job)
    const done = this.queue.then(() => work(job)).finally(() => { this.jobs.delete(job) })
    this.queue = done.then(() => undefined, () => undefined)
    return done
  }

  // ---- Backing up on demand

  /**
   * A manual backup of the open book, taken now while it stays open: into the backup folder, or to the exact file `to`
   * (Back Up To…). Waits behind any backup already being written, verifies what it wrote, and resolves its path;
   * rejects with why it failed. Never pruned. It counts as the book's last backup only when it lands in the backup
   * folder, the one place Tessera manages; a failure is the caller's to report, and leaves the ledger as it was.
   */
  async backUpNow(db: Database, book: BookInfo, options: BackUpNowOptions = {}): Promise<string> {
    const { to, trigger = 'manual', record = true } = options
    // Watch afresh, so a change made while this is written still counts as a change after it
    this.watch(db, book)
    const epoch = this.epochs.get(book.id) ?? 0
    const takenAt = this.now()
    const snapshot = await db.snapshot()
    const job: Job = { book, snapshot, takenAt, epoch, abort: new AbortController(), trigger, ...(to !== undefined && { to }) }
    const file = await this.enqueue(job, j => this.write(j))

    this.deps.log.info(`[book] Backed up “${book.name}” to ${file}, as asked`)
    if (record && (to === undefined || this.inBackupFolder(to))) {
      const changed = (this.epochs.get(book.id) ?? 0) !== epoch
      if (!changed) this.changedNow.delete(book.id)
      await this.deps.ledger.succeeded(book, { at: takenAt, file, changed })
      this.recorded(book)
    }
    return file
  }

  /**
   * The book now holds something no backup has: a restore replaced it, say. Its next close backs it up, whatever
   * the frequency's last backup says.
   */
  markChanged(book: BookInfo) {
    this.changed(book)
  }

  /** The folder backups go to now: the chosen one, or the default. Not checked to exist. */
  backupFolder(): string {
    return this.deps.options().folder ?? this.defaultFolder()
  }

  private inBackupFolder(file: string): boolean {
    const fold = (p: string) => process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p
    return fold(path.resolve(path.dirname(file))) === fold(path.resolve(this.backupFolder()))
  }

  // ---- Writing, after the book has closed

  /** `<Documents>/Tessera Backups`: where backups go when no folder is chosen. */
  defaultFolder(): string {
    return path.join(this.deps.files.documentsPath(), DEFAULT_BACKUP_FOLDER_NAME)
  }

  /** Calls `listener` with the book each time an attempt to back it up has been recorded, whatever its outcome. */
  onDidRecord(listener: (book: BookInfo) => void): Disposable {
    this.recordListeners.add(listener)
    return { dispose: () => { this.recordListeners.delete(listener) } }
  }

  private recorded(book: BookInfo) {
    for (const listener of [...this.recordListeners]) {
      try { listener(book) } catch (err) { this.deps.log.error('[book] A backup listener failed', err) }
    }
  }

  /** Where backups go: the chosen folder, which must exist, or the default, which is made if it doesn't. */
  private async folder(options: BookBackupOptions): Promise<string> {
    if (options.folder !== null) {
      if (!(await this.deps.disk.folderExists(options.folder))) {
        throw new BookError('FILE_NOT_FOUND', `The backup folder “${options.folder}” can’t be found. If it is on a drive that isn’t connected, connect it, or choose another folder in Tools › Options › Book › Backups.`)
      }
      return options.folder
    }
    const folder = this.defaultFolder()
    if (!(await this.deps.disk.folderExists(folder))) await this.deps.disk.makeFolder(folder)
    return folder
  }

  /** Never throws: every outcome is logged, recorded in the ledger, and announced. */
  private async run(job: Job): Promise<void> {
    try {
      await this.attempt(job)
    } finally {
      this.recorded(job.book)
    }
  }

  /**
   * Writes a job's backup and reads it back, resolving its path; throws if either fails. At quit there is no time to
   * read it back: the digest computed while writing stands.
   */
  private async write(job: Job): Promise<string> {
    const { book, snapshot, takenAt, abort, trigger, to } = job
    if (abort.signal.aborted) throw abort.signal.reason
    const header = backupHeader({
      book: { id: book.id, name: book.name, path: book.path }, takenAt, trigger,
      app: `book ${BOOK_API_VERSION}`, engine: this.deps.engineId
    }, snapshot)
    const fill = async (out: Writable) => { await writeBackup(out, header, snapshot, { signal: abort.signal }) }

    let file: string
    if (to !== undefined) {
      await this.deps.disk.write(to, fill)
      file = to
    } else {
      const folder = await this.folder(this.deps.options())
      file = await this.deps.disk.create(folder, attempt => backupFileName(book.name, takenAt, trigger, attempt), fill)
    }
    if (!this.shuttingDown) await this.verify(file)
    return file
  }

  private async attempt(job: Job): Promise<void> {
    const { book, takenAt, abort } = job
    const { ledger, log } = this.deps
    try {
      const file = await this.write(job)
      // Pruning waits at quit too; the next successful backup prunes
      if (!this.shuttingDown) await this.prune(path.dirname(file), book, this.deps.options().keep)
      await ledger.succeeded(book, { at: takenAt, file, changed: (this.epochs.get(book.id) ?? 0) !== job.epoch })
      log.info(`[book] Backed up “${book.name}” to ${file}`)
    } catch (err) {
      if (abort.signal.aborted) {
        await ledger.interrupted(book).catch(() => {})
        log.warn(`[book] The automatic backup of “${book.name}” was cut short when Tessera quit; it will be taken the next time the book closes`)
      } else {
        await ledger.failed(book, describe(err)).catch(() => {})
        log.warn(`[book] Automatic backup of “${book.name}” failed: ${describe(err)}`)
      }
    }
  }

  /** Reads the new file back in full. A backup that has never been read back isn't trusted, so a bad one is removed. */
  private async verify(file: string) {
    try {
      await verifyBackup(this.deps.disk.open(file))
    } catch (err) {
      await this.deps.disk.remove(file).catch(() => {})
      throw new BookError('DAMAGED', `The backup could not be read back, so it was removed. ${describe(err)}`)
    }
  }

  /**
   * Keeps the newest `keep` automatic backups of this book and moves older ones to the Trash, or deletes them where
   * the drive has none. Never touches a manual or pre-restore backup, another book's, or a file it can't read.
   * Problems here are logged: the backup just written still counts.
   */
  private async prune(folder: string, book: BookInfo, keep: number) {
    const { disk, files, log } = this.deps
    try {
      const mine: { file: string, takenAt: number }[] = []
      for (const { file } of await disk.list(folder)) {
        try {
          const header = await readBackupHeader(disk.open(file))
          if (header.book.id === book.id && header.trigger === 'auto') mine.push({ file, takenAt: Date.parse(header.takenAt) })
        } catch {
          // Not readable as a backup: someone else's file, or damaged. Left alone either way
        }
      }
      mine.sort((a, b) => b.takenAt - a.takenAt)

      let deleted = 0
      for (const { file } of mine.slice(keep)) {
        try {
          await files.trash(file)
        } catch {
          // No Trash on this drive (a network share, some removable drives), or the Trash failed: delete instead
          try {
            await disk.remove(file)
            deleted++
          } catch (err) {
            log.warn(`[book] Could not remove the old backup ${file}: ${describe(err)}`)
          }
        }
      }
      if (deleted > 0) {
        log.info(`[book] The backup folder’s drive has no Trash; ${deleted} old backup${deleted === 1 ? ' was' : 's were'} of “${book.name}” deleted instead`)
      }

      const now = this.now().getTime()
      for (const { file, modifiedAt } of await disk.partials(folder)) {
        if (now - modifiedAt.getTime() > STALE_PARTIAL_MS) await disk.remove(file).catch(() => {})
      }
    } catch (err) {
      log.warn(`[book] Could not tidy the old backups of “${book.name}”: ${describe(err)}`)
    }
  }

  // ---- Quitting

  /**
   * On quit: waits for the backups still queued, up to `budgetMs`, then abandons the rest. An abandoned write removes
   * its partial file and is recorded as interrupted, so the next close takes it.
   */
  async drain(budgetMs = BACKUP_SHUTDOWN_BUDGET_MS): Promise<void> {
    this.shuttingDown = true
    if (!(await outlasts(this.queue, budgetMs))) return
    for (const job of this.jobs) job.abort.abort(new Error('Tessera is quitting'))
    if (await outlasts(this.queue, ABANDON_GRACE_MS)) this.deps.log.warn('[book] A backup was still being abandoned when Tessera quit')
  }
}
