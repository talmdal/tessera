// Archiving the open ledger, as File › Archive Ledger… does it: the archive file first, made and checked as a backup is
// (a snapshot, kind `archive`, in the `Archives` folder of the default backup folder), then the removal in one storage
// transaction through the participants. Nothing is removed without the archive file, and an archive file that records
// an archive that didn't happen is deleted again. See docs/ledger-compaction-design.md, "The archive, step by step".
import path from 'node:path'
import type { Logger } from '@tessera/types'
import {
  LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_EXTENSION, LedgerError, displayDate, isLedgerError,
  type ArchiveCompaction, type ArchiveDialogInput, type ArchiveOutcome, type ArchivePreview, type ArchiveProgress, type LedgerInfo
} from '@tessera/ledger-api'
import type { LedgerDisk } from '../disk'
import { localDate, type LedgerSessionImpl } from '../LedgerSessionImpl'
import type { BackupService } from '../backup/BackupService'
import { unusedPath } from '../backup/naming'
import { suggestedArchiveDate, type ArchiveSettings } from './settings'

export interface ArchiveServiceDeps {
  session: Pick<LedgerSessionImpl, 'current' | 'changeCount' | 'runArchive' | 'describeArchive' | 'archiveRecords' | 'withOpenLedger'>
  backups: Pick<BackupService, 'folder' | 'backUp'>
  disk: Pick<LedgerDisk, 'exists' | 'remove' | 'stat' | 'sideFiles'>
  settings: () => ArchiveSettings
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => Date
}

/** The archive file's name, without its extension: `Home (archive before 2026-01-01)`. Sortable and locale-free. */
export const archiveFileName = (ledgerName: string, before: string) => `${ledgerName} (archive before ${before})`

export class ArchiveService {
  /** Set while File › Archive Ledger… has its dialog open: the dialog's requests are answered only then. */
  private open = false
  /** An archive in progress, which the command waits for before it lets the ledger go. */
  private running: Promise<unknown> | undefined
  /** What the dialog's archive did, since the dialog opened: the command reports it even if the window closed first. */
  private finished: ArchiveOutcome | undefined

  constructor(private readonly deps: ArchiveServiceDeps) {}

  private get now() { return this.deps.now ?? (() => new Date()) }

  // ---- The dialog's session

  begin() { this.open = true; this.finished = undefined }
  end() { this.open = false }
  get active() { return this.open }
  /** The archive the dialog ran, once it has finished. */
  get completed(): ArchiveOutcome | undefined { return this.finished }
  /** Resolves once no archive is running (the dialog's window may close while one does). */
  settled(): Promise<void> { return Promise.resolve(this.running).then(() => {}) }

  private checkOpen() {
    if (!this.open) throw new LedgerError('INVALID', 'File › Archive Ledger… isn’t open.')
  }

  /** The folder archive files go in: `Archives`, in the default backup folder. Retention never looks inside it. */
  folder(): string {
    return path.join(this.deps.backups.folder(), LEDGER_ARCHIVES_FOLDER)
  }

  private ledger() {
    const ledger = this.deps.session.current
    if (!ledger) throw new LedgerError('NO_LEDGER', 'No ledger is open.')
    if (ledger.readOnly) throw new LedgerError('READ_ONLY', `“${ledger.name}” is open read-only, so it can’t be archived.`)
    return ledger
  }

  /**
   * The date and options, checked: the session's description refuses a date that isn't one or is after today, and
   * options that aren't on or off; then only options a participant offers are allowed.
   */
  private async checked(before: unknown, options: unknown): Promise<{ before: string, options: Record<string, boolean>, preview: Omit<ArchivePreview, 'copy'> }> {
    const parts = await this.deps.session.describeArchive(before as string, options as Record<string, boolean> | undefined)
    const given = { ...options as Record<string, boolean> | undefined }
    const offered = new Set(parts.flatMap(part => (part.options ?? []).map(o => o.id)))
    const unknown = Object.keys(given).filter(id => !offered.has(id))
    if (unknown.length > 0) throw new LedgerError('INVALID', `The archive has no option “${unknown[0]}”.`, 'options')
    const date = before as string
    return { before: date, options: given, preview: { before: date, parts, count: parts.reduce((sum, p) => sum + p.count, 0) } }
  }

  /** Where the archive file would go now: a name that is free. */
  private async copyPath(ledgerName: string, before: string): Promise<string> {
    return unusedPath(path.join(this.folder(), archiveFileName(ledgerName, before) + LEDGER_BACKUP_EXTENSION), f => this.deps.disk.exists(f))
  }

  // ---- What the dialog shows

  /** The dialog's starting point: the suggested date, today, and the ledger's last archive. */
  async dialogInput(): Promise<ArchiveDialogInput> {
    const ledger = this.ledger()
    const now = this.now()
    const [last] = await this.deps.session.archiveRecords().catch(() => [])
    return {
      ledgerName: ledger.name, suggestedBefore: suggestedArchiveDate(now, this.deps.settings()), today: localDate(now),
      ...(last && { lastArchive: { before: last.before, archivedAt: last.archivedAt } })
    }
  }

  /** What archiving before `before` would do: each participant's description, and the archive file's name and folder. */
  async preview(before: unknown, options?: unknown): Promise<ArchivePreview> {
    this.checkOpen()
    const ledger = this.ledger()
    const { preview } = await this.checked(before, options)
    const copy = await this.copyPath(ledger.name, preview.before)
    return { ...preview, copy: { name: path.basename(copy, LEDGER_BACKUP_EXTENSION), folder: path.dirname(copy) } }
  }

  // ---- Archiving

  /** The dialog's run: only while it is open, and one at a time. */
  runFromDialog(before: unknown, options: unknown, onProgress: (progress: ArchiveProgress) => void): Promise<ArchiveOutcome> {
    this.checkOpen()
    return this.run(before, options, onProgress).then(outcome => { this.finished = outcome; return outcome })
  }

  /**
   * Archives the open ledger before `before`. Refuses (INVALID) an invalid date or option, and a date with nothing to
   * archive, before making anything. Then: the archive file, checked and named; then the removal. If the ledger changed
   * while it was being copied (CONFLICT), the archive file is deleted and made again, once. If the removal fails, the
   * archive file is deleted, and nothing was removed.
   */
  run(before: unknown, options: unknown, onProgress: (progress: ArchiveProgress) => void = () => {}): Promise<ArchiveOutcome> {
    if (this.running) return Promise.reject(new LedgerError('BUSY', 'An archive is already being made.'))
    const work = this.archive(before, options, onProgress)
    // Settles either way: the caller has the failure
    const done = () => { this.running = undefined }
    this.running = work.then(done, done)
    return work
  }

  private async archive(before: unknown, options: unknown, onProgress: (progress: ArchiveProgress) => void): Promise<ArchiveOutcome> {
    const ledger = this.ledger()
    const request = await this.checked(before, options)
    if (request.preview.count === 0) throw new LedgerError('INVALID', `There is nothing to archive before ${displayDate(request.before)}.`, 'before')

    for (let attempt = 1; ; attempt++) {
      const unchangedSince = this.deps.session.changeCount
      onProgress({ step: 'copying', done: 0 })
      let copy: { path: string, takenAt: string }
      try {
        const target = await this.copyPath(ledger.name, request.before)
        const made = await this.deps.backups.backUp(target, {
          kind: 'archive', archiveBefore: request.before, record: false,
          onProgress: done => onProgress(done < 1 ? { step: 'copying', done } : { step: 'checking' })
        })
        copy = { path: made.path, takenAt: made.takenAt }
      } catch (err) {
        throw new LedgerError('ARCHIVE_FAILED', `The archive file couldn’t be made, so nothing was archived. ${err instanceof Error ? err.message : String(err)}`)
      }

      onProgress({ step: 'removing' })
      try {
        const outcome = await this.deps.session.runArchive({ before: request.before, options: request.options, copy, unchangedSince })
        this.deps.log.info(`[ledger] Archived ${ledger.path} before ${request.before}; the archive file is ${copy.path}`)
        onProgress({ step: 'compacting' })
        return { ...outcome, compaction: await this.compact(ledger) }
      } catch (err) {
        // The archive file records an archive that didn't happen: it goes. Everything it holds is still in the ledger
        await this.deps.disk.remove(copy.path).catch(removeErr =>
          this.deps.log.warn(`[ledger] Could not remove ${copy.path} after the archive failed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`))
        if (isLedgerError(err) && err.code === 'CONFLICT' && attempt === 1) {
          this.deps.log.info(`[ledger] ${ledger.path} changed while it was being copied; copying it again`)
          continue
        }
        throw err
      }
    }
  }

  /**
   * The archive's last step: the ledger's file made as small as what is left allows (SQLite's `VACUUM`, in the
   * driver's worker thread). It never fails the archive, which is committed: a failure, or too little free disk space,
   * is logged and reported, and the file is only larger than it needs to be.
   */
  private async compact(ledger: LedgerInfo): Promise<ArchiveCompaction> {
    try {
      const before = await this.sizeOnDisk(ledger.path)
      await this.deps.session.withOpenLedger(db => db.compact())
      const after = await this.sizeOnDisk(ledger.path)
      this.deps.log.info(`[ledger] Compacted ${ledger.path}: ${before} bytes before, ${after} after`)
      return { before, after }
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err)
      this.deps.log.warn(`[ledger] Could not compact ${ledger.path} after archiving it: ${problem}`)
      return { problem }
    }
  }

  /** A ledger's size on disk: its file and the side files holding its data (the `-wal`; not SQLite's `-shm` index). */
  private async sizeOnDisk(file: string): Promise<number> {
    let total = 0
    const sides = (await this.deps.disk.sideFiles(file).catch(() => [])).filter(side => !side.endsWith('-shm'))
    for (const part of [file, ...sides]) {
      total += (await this.deps.disk.stat(part).catch(() => ({ size: 0 }))).size
    }
    return total
  }
}
