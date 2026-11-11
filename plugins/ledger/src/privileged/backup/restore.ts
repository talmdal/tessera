// Restoring a backup: as a new ledger, or in its ledger's place. The current file is never replaced, trashed or
// deleted: a restore in place renames it to a name the user chooses, and the backup takes its name (decided in review;
// see docs/backup-restore-design.md, "Restoring"). Everything is checked before anything changes, and every failure
// puts the files back as they were.
import path from 'node:path'
import type { Database, Json, Logger, ShellFiles, StorageEngine } from '@tessera/types'
import {
  LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_FILTER, LEDGER_BACKUP_META, LEDGER_FILE_EXTENSION, LEDGER_FILE_FILTER, LEDGER_META, LedgerError,
  isLedgerError, validateLedgerFileName,
  type BackupInfo, type LedgerInfo, type RestoreOutcome, type RestorePlan, type RestoreProgress, type RestoreRequest
} from '@tessera/ledger-api'
import type { LedgerDisk } from '../disk'
import { ledgerName, type FileOperations, type LedgerSessionImpl } from '../LedgerSessionImpl'
import { samePath } from '../paths'
import type { RecentLedgers } from '../RecentLedgers'
import { fileProblem } from './BackupService'
import { isBackupFile, keptName, restoredName, unusedPath } from './naming'
import { renameWithRetry, type RetryOptions } from './rename'

export interface RestoreServiceDeps {
  session: Pick<LedgerSessionImpl, 'current' | 'inspect' | 'withFileOperations'>
  engine: Pick<StorageEngine, 'readMeta' | 'open' | 'newId'>
  files: Pick<ShellFiles, 'showOpenDialog' | 'showOpenFolderDialog' | 'documentsPath'>
  disk: LedgerDisk
  recent: Pick<RecentLedgers, 'list'>
  /** The default backup folder, where the dialog lists backups. */
  backupFolder: () => string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => Date
  retry?: Omit<RetryOptions, 'onWaiting'>
}

/** A file's name without its extension, for a file that isn't a ledger. */
const stem = (file: string) => path.basename(file, path.extname(file))

/** `Home.tessera` in `folder`, from a name the user typed. */
const ledgerFile = (folder: string, name: string) => path.join(folder, name.trim() + LEDGER_FILE_EXTENSION)

const invalid = (field: string, message: string) => new LedgerError('INVALID', message, field)

/** Where a backup can be restored in place, or why it can't. */
type Target = { path: string } | { unavailable: string }

export class RestoreService {
  /** The backups the open Restore dialog has been shown: only those can be restored. */
  private offered: Set<string> | undefined
  /** A restore in progress, which the command waits for before it lets the ledger go. */
  private running: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: RestoreServiceDeps) {}

  private get now() { return this.deps.now ?? (() => new Date()) }

  // ---- The dialog's session

  /** File › Restore Ledger… has opened the dialog: its requests are answered until `end`. */
  begin() { this.offered = new Set() }
  end() { this.offered = undefined }
  get active() { return this.offered !== undefined }
  /** Resolves once no restore is running (the dialog's window may close while one does). */
  settled(): Promise<void> { return this.running.then(() => {}, () => {}) }

  private offer(info: BackupInfo): BackupInfo {
    this.session().add(info.path)
    return info
  }

  private session(): Set<string> {
    if (!this.offered) throw new LedgerError('INVALID', 'File › Restore Ledger… isn’t open.')
    return this.offered
  }

  /** Only a file the dialog was shown (listed, browsed to, or chosen by the command) can be planned or restored. */
  private offeredPath(file: unknown): string {
    const offered = this.session()
    const resolved = typeof file === 'string' && file !== '' ? path.resolve(file) : undefined
    if (!resolved || ![...offered].some(p => samePath(p, resolved))) throw new LedgerError('INVALID', 'Choose a backup from the list.')
    return resolved
  }

  // ---- What the dialog shows

  /** What a file is, as the Restore dialog shows it. A file that can't be restored says why, in `problem`. */
  async describe(file: string): Promise<BackupInfo> {
    const resolved = path.resolve(file)
    let stats: { size: number, modified: Date }
    try {
      stats = await this.deps.disk.stat(resolved)
    } catch {
      return { path: resolved, ledgerName: stem(resolved), takenAt: new Date(0).toISOString(), kind: 'ledger', size: 0,
        problem: `“${path.basename(resolved)}” can’t be found. It may have been moved or deleted.` }
    }
    let meta: Record<string, Json>
    try {
      ({ meta } = await this.deps.session.inspect(resolved, { allowBackup: true }))
    } catch (err) {
      if (!isLedgerError(err)) this.deps.log.warn(`[ledger] Could not read ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
      return { path: resolved, ledgerName: stem(resolved), takenAt: stats.modified.toISOString(), kind: 'ledger', size: stats.size,
        problem: isLedgerError(err) ? err.message : `“${path.basename(resolved)}” can’t be read.` }
    }
    const takenAt = meta[LEDGER_BACKUP_META.takenAt]
    const isBackup = typeof takenAt === 'string'
    const id = meta[LEDGER_META.id]
    const name = meta[LEDGER_BACKUP_META.ledgerName]
    const from = meta[LEDGER_BACKUP_META.ledgerPath]
    const kind = meta[LEDGER_BACKUP_META.kind]
    const before = meta[LEDGER_BACKUP_META.archiveBefore]
    const open = this.deps.session.current
    return {
      path: resolved,
      ledgerName: isBackup && typeof name === 'string' && name !== '' ? name : ledgerName(resolved),
      ...(typeof id === 'string' && id !== '' && { ledgerId: id }),
      ...(typeof from === 'string' && from !== '' && { ledgerPath: from }),
      takenAt: isBackup ? takenAt : stats.modified.toISOString(),
      kind: isBackup ? (kind === 'auto' || kind === 'archive' ? kind : 'manual') : 'ledger',
      ...(isBackup && kind === 'archive' && typeof before === 'string' && { archiveBefore: before }),
      size: stats.size,
      // An archive open for viewing can be restored: that is how an archive is undone. The open ledger can't
      ...(open && !open.archive && samePath(open.path, resolved) && { problem: 'This is the open ledger.' })
    }
  }

  /**
   * The backups in the default backup folder, and the archive files in its `Archives` folder, newest first. (Only
   * archives are taken from there: an ordinary backup someone moved in is neither listed nor trimmed.)
   */
  async list(): Promise<{ folder: string, backups: BackupInfo[] }> {
    this.session()
    const folder = this.deps.backupFolder()
    const archives = (await this.deps.disk.list(path.join(folder, LEDGER_ARCHIVES_FOLDER))).filter(isBackupFile)
    const archiveInfos = (await Promise.all(archives.map(file => this.describe(file)))).filter(info => info.kind === 'archive')
    const files = (await this.deps.disk.list(folder)).filter(isBackupFile)
    const infos = [...await Promise.all(files.map(file => this.describe(file))), ...archiveInfos]
    return { folder, backups: infos.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || a.path.localeCompare(b.path)).map(info => this.offer(info)) }
  }

  /** A backup (or a ledger file) from elsewhere, chosen in the open dialog. Undefined if cancelled. */
  async browse(windowId?: number): Promise<BackupInfo | undefined> {
    this.session()
    const chosen = await this.deps.files.showOpenDialog({
      title: 'Choose a Backup',
      defaultPath: this.deps.backupFolder(),
      filters: [LEDGER_BACKUP_FILTER, LEDGER_FILE_FILTER, { name: 'All files', extensions: ['*'] }],
      buttonLabel: 'Choose',
      ...(windowId !== undefined && { windowId })
    })
    return chosen === undefined ? undefined : this.offer(await this.describe(chosen))
  }

  /** The file the command was given, shown chosen. */
  async preselect(file: string): Promise<BackupInfo> {
    return this.offer(await this.describe(file))
  }

  chooseFolder(defaultPath: string | undefined, windowId?: number): Promise<string | undefined> {
    this.session()
    return this.deps.files.showOpenFolderDialog({
      title: 'Restore To', buttonLabel: 'Choose',
      ...(defaultPath !== undefined && { defaultPath }), ...(windowId !== undefined && { windowId })
    })
  }

  /** How a listed backup can be restored, with names that are free. */
  async plan(file: unknown): Promise<RestorePlan> {
    const info = await this.usable(this.offeredPath(file))
    const now = this.now()
    const exists = (f: string) => this.deps.disk.exists(f)
    const target = await this.targetOf(info)

    // As a new ledger: in the ledger's own folder when it is known and there, else the documents folder. Where the
    // ledger is gone from it, under its own name
    const known = 'path' in target ? target.path : info.ledgerPath
    const folder = known && await this.deps.disk.isFolder(path.dirname(known)) ? path.dirname(known) : this.deps.files.documentsPath()
    const gone = known !== undefined && !('path' in target) && !(await exists(known)) && samePath(path.dirname(known), folder)
    // A ledger file (a copy made before an upgrade) has no name of its own: its ledger's, when that is known, reads better
    const ledger = 'path' in target ? ledgerName(target.path) : info.ledgerName
    const base = gone ? ledgerName(known!) : restoredName(ledger, now)
    const newName = ledgerName(await unusedPath(ledgerFile(folder, base), exists))

    let inPlace: RestorePlan['inPlace']
    if ('unavailable' in target) inPlace = target
    else {
      const name = ledgerName(target.path)
      const open = this.deps.session.current
      const keepAs = await exists(target.path)
        ? ledgerName(await unusedPath(ledgerFile(path.dirname(target.path), keptName(name, now)), exists))
        : undefined
      inPlace = { path: target.path, name, isOpen: open !== undefined && samePath(open.path, target.path), ...(keepAs !== undefined && { keepAs }) }
    }
    return { backup: info, asNew: { folder, name: newName }, inPlace }
  }

  private async usable(file: string): Promise<BackupInfo> {
    const info = await this.describe(file)
    if (info.problem) throw new LedgerError('RESTORE_FAILED', info.problem)
    return info
  }

  /**
   * The ledger a backup belongs to, on this computer: the open ledger with its id, else a recent ledger with its id,
   * else the file it was backed up from, if that is still there and is the same ledger (or has no id to tell).
   */
  private async targetOf(info: BackupInfo): Promise<Target> {
    const { disk, session } = this.deps
    const open = session.current
    if (info.ledgerId !== undefined) {
      if (open?.id === info.ledgerId) return { path: open.path }
      for (const entry of await this.deps.recent.list().catch(() => [])) {
        if (entry.id === info.ledgerId && await disk.exists(entry.path)) return { path: entry.path }
      }
    }
    const from = info.ledgerPath
    if (from !== undefined && await disk.exists(from)) {
      const there = await this.deps.engine.readMeta({ path: from }).catch(() => undefined)
      const id = there?.[LEDGER_META.id]
      if (typeof id !== 'string' || info.ledgerId === undefined || id === info.ledgerId) return { path: from }
      return { unavailable: `A different ledger is at “${from}” now. Restore this one as a new ledger.` }
    }
    return { unavailable: `“${info.ledgerName}” isn’t on this computer, or has been moved or deleted. Restore it as a new ledger.` }
  }

  // ---- Restoring

  /**
   * Restores a listed backup, calling `progress` with each step. Resolves the restored ledger, open. Throws INVALID
   * (with the field) for a name to change, RESTORE_FAILED with the reason otherwise; either way the files are as they were.
   */
  run(request: RestoreRequest, progress: (step: RestoreProgress) => void = () => {}): Promise<RestoreOutcome> {
    const work = (async () => {
      const info = await this.usable(this.offeredPath(request?.backup))
      return this.deps.session.withFileOperations(ops =>
        request.mode === 'inPlace' ? this.inPlace(info, request.keepAs, ops, progress) : this.asNew(info, request, ops, progress))
    })()
    this.running = work
    return work
  }

  private async asNew(info: BackupInfo, request: Extract<RestoreRequest, { mode: 'new' }>, ops: FileOperations, progress: (step: RestoreProgress) => void): Promise<RestoreOutcome> {
    const { disk } = this.deps
    const problem = validateLedgerFileName(request.name ?? '')
    if (problem) throw invalid('name', problem)
    const folder = typeof request.folder === 'string' && path.isAbsolute(request.folder) ? path.resolve(request.folder) : undefined
    if (!folder || !(await disk.isFolder(folder))) throw invalid('folder', `The folder “${request.folder}” isn’t available. Choose another.`)
    const target = ledgerFile(folder, request.name)
    if (await disk.exists(target)) throw invalid('name', `“${path.basename(target)}” is already in that folder. Choose another name.`)

    const temp = await this.copyIn(info, folder, request.name.trim(), progress)
    try {
      if (await disk.exists(target)) throw invalid('name', `“${path.basename(target)}” is already in that folder. Choose another name.`)
      await renameWithRetry(disk, temp, target, this.deps.retry)
    } catch (err) {
      await disk.remove(temp).catch(() => {})
      throw this.failure(err, target)
    }

    progress({ step: `Opening “${ledgerName(target)}”` })
    try {
      // A ledger of its own: a new id, so its backups and the original's are never taken for one ledger's
      return {
        ledger: await ops.open(target, async db => {
          await stripBackupMeta(db)
          await db.meta.set(LEDGER_META.id, this.deps.engine.newId())
          await db.meta.set(LEDGER_META.restoredFrom, { id: info.ledgerId ?? null, takenAt: info.takenAt })
        })
      }
    } catch (err) {
      // The restore made this file, and it can't be used: it goes, and the ledger that was open stays open
      await this.removeWithSideFiles(target)
      throw this.failure(err, target)
    }
  }

  private async inPlace(info: BackupInfo, keepAs: string | undefined, ops: FileOperations, progress: (step: RestoreProgress) => void): Promise<RestoreOutcome> {
    const { disk } = this.deps
    const target = await this.targetOf(info)
    if ('unavailable' in target) throw new LedgerError('RESTORE_FAILED', target.unavailable)
    const file = target.path
    const name = ledgerName(file)
    const folder = path.dirname(file)

    // The current file is kept under a name the user chose; nothing is ever deleted
    let aside: string | undefined
    if (await disk.exists(file)) {
      const problem = validateLedgerFileName(keepAs ?? '')
      if (problem) throw invalid('keepAs', problem)
      aside = ledgerFile(folder, keepAs!)
      if (samePath(aside, file)) throw invalid('keepAs', `Choose a name other than “${name}” to keep the current file under.`)
      if (await disk.exists(aside)) throw invalid('keepAs', `“${path.basename(aside)}” is already there. Choose another name.`)
    }

    const temp = await this.copyIn(info, folder, name, progress)
    const current = ops.current()
    const wasOpen = current !== undefined && samePath(current.path, file)
    let setAside = false
    try {
      if (wasOpen) {
        progress({ step: `Closing “${name}”` })
        await ops.close()
      }
      if (aside) {
        progress({ step: `Keeping the current “${name}” as “${ledgerName(aside)}”` })
        // Its side files go with it: after a crash, its last writes may be only in its -wal
        const sides = await disk.sideFiles(file)
        await renameWithRetry(disk, file, aside, this.deps.retry)
        setAside = true
        for (const side of sides) await renameWithRetry(disk, side, aside + side.slice(file.length), this.deps.retry)
      }
      // A side file left here would be applied by SQLite to the restored file, which would then open as the old one
      const left = await disk.sideFiles(file)
      if (left.length > 0) throw new Error(`“${path.basename(left[0])}” is still beside the ledger`)
      await renameWithRetry(disk, temp, file, this.deps.retry)
    } catch (err) {
      await disk.remove(temp).catch(() => {})
      if (setAside) await this.putBack(aside!, file)
      if (wasOpen) await this.reopen(ops, file)
      throw this.failure(err, file)
    }

    progress({ step: `Opening “${name}”` })
    let ledger: LedgerInfo
    try {
      // The same ledger, as it was: it keeps its id, and is no longer a backup
      ledger = await ops.open(file, stripBackupMeta)
    } catch (err) {
      await this.removeWithSideFiles(file)
      if (aside) await this.putBack(aside, file)
      if (wasOpen) await this.reopen(ops, file)
      throw this.failure(err, file)
    }
    if (aside) await this.newIdentity(aside)
    return { ledger, ...(aside && { kept: aside }) }
  }

  /** Copies the backup beside where it is going, under a temporary name, and checks the copy. */
  private async copyIn(info: BackupInfo, folder: string, name: string, progress: (step: RestoreProgress) => void): Promise<string> {
    const { disk } = this.deps
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    // In the same folder, so it takes its name by renaming, on the same volume
    const temp = path.join(folder, `.${name}.restoring-${stamp}${LEDGER_FILE_EXTENSION}`)
    progress({ step: 'Copying the backup', done: 0 })
    try {
      await disk.remove(temp)
      await disk.copy(info.path, temp, done => progress({ step: 'Copying the backup', done }))
      const meta = await this.deps.engine.readMeta({ path: temp })
      if (typeof meta[LEDGER_META.format] !== 'number') throw new Error('the copy did not read back as a ledger')
    } catch (err) {
      await disk.remove(temp).catch(() => {})
      throw this.failure(err, temp)
    }
    return temp
  }

  /** Puts the current file back under its name after a failure. If even that fails, says where it is. */
  private async putBack(aside: string, file: string) {
    const { disk } = this.deps
    try {
      const sides = await disk.sideFiles(aside)
      await renameWithRetry(disk, aside, file, this.deps.retry)
      for (const side of sides) await renameWithRetry(disk, side, file + side.slice(aside.length), this.deps.retry)
    } catch (err) {
      this.deps.log.error(`[ledger] Could not put ${aside} back as ${file}`, err)
      throw new LedgerError('RESTORE_FAILED', `The restore failed, and “${path.basename(file)}” couldn’t be put back: it is safe as “${path.basename(aside)}”.`)
    }
  }

  private async reopen(ops: FileOperations, file: string) {
    await ops.open(file).catch(err => this.deps.log.warn(`[ledger] Could not reopen ${file} after a failed restore: ${err instanceof Error ? err.message : String(err)}`))
  }

  /**
   * The kept file becomes a ledger of its own, with a new id, so its backups are never taken for the restored
   * ledger's. Best effort: a damaged file that can't be opened keeps its id.
   */
  private async newIdentity(file: string) {
    try {
      const db = await this.deps.engine.open({ path: file })
      try { await db.meta.set(LEDGER_META.id, this.deps.engine.newId()) } finally { await db.close() }
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not give ${file} an id of its own: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async removeWithSideFiles(file: string) {
    const { disk } = this.deps
    for (const side of await disk.sideFiles(file).catch(() => [])) await disk.remove(side).catch(() => {})
    await disk.remove(file).catch(() => {})
  }

  private failure(err: unknown, file: string): LedgerError {
    if (isLedgerError(err)) return err
    this.deps.log.warn(`[ledger] Restoring failed at ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return new LedgerError('RESTORE_FAILED', fileProblem(err, file) ?? `The backup couldn’t be restored: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A restored ledger is no longer a backup: Open would refuse it, and retention would count it. */
async function stripBackupMeta(db: Database) {
  for (const key of Object.values(LEDGER_BACKUP_META)) await db.meta.delete(key)
}
