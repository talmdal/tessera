// Backing up the open ledger: a snapshot of its database (the ledger stays open), checked, then given its name.
// See docs/backup-restore-design.md, "Backing up".
import path from 'node:path'
import type { Database, Json, Logger, PluginState, ShellFiles, StorageEngine } from '@tessera/types'
import {
  LEDGER_API_VERSION, LEDGER_BACKUP_META, LEDGER_META, LedgerError, isLedgerError, type BackupKind, type LedgerInfo
} from '@tessera/ledger-api'
import type { LedgerDisk } from '../disk'
import type { LedgerSessionImpl } from '../LedgerSessionImpl'
import { samePath } from '../paths'
import { PARTIAL_SUFFIX, backupFileName, dateTime, unusedPath, withBackupExtension } from './naming'
import { renameWithRetry, type RetryOptions } from './rename'
import { discard, trimFolder, type TrimResult } from './retention'
import { backupFolder, type BackupSettings } from './settings'

/** Key in the ledger's `context.state`: `{ [ledger id, or path]: { takenAt, path } }`, each ledger's last backup. */
export const LAST_BACKUP_KEY = 'backup.last'

export interface LastBackup {
  takenAt: string
  path: string
}

/**
 * Key in the ledger's `context.state`: the last automatic backup that failed or was skipped, `BackupProblem`, until
 * a backup of that ledger succeeds. The status bar's "Last backup failed" shows it, at the next start too.
 */
export const BACKUP_PROBLEM_KEY = 'backup.lastAutoError'

export interface BackupProblem {
  /** The ledger's id, or its path for one without: a backup of this ledger clears the problem. */
  ledger: string
  ledgerName: string
  /** What went wrong, for the user: "The folder “E:\Backups” isn’t available." */
  message: string
  /** ISO 8601, UTC. */
  at: string
}

export interface BackupServiceDeps {
  session: Pick<LedgerSessionImpl, 'withOpenLedger' | 'backupStarting'>
  engine: Pick<StorageEngine, 'readMeta'>
  files: Pick<ShellFiles, 'trash' | 'documentsPath'>
  disk: LedgerDisk
  state: Pick<PluginState, 'get' | 'set' | 'update' | 'remove'>
  settings: () => BackupSettings
  log: Pick<Logger, 'info' | 'warn'>
  now?: () => Date
  /** For tests: how the rename waits for a held file. */
  retry?: Omit<RetryOptions, 'onWaiting'>
  /** Called with the problem to show each time it changes (undefined: none). */
  onProblem?(problem: BackupProblem | undefined): void
}

export interface BackupResult {
  path: string
  /** ISO 8601, UTC, as in the backup's meta. */
  takenAt: string
  ledgerName: string
  /** Absent for an older ledger open read-only, which has no id yet: its backups are never trimmed. */
  ledgerId?: string
}

export interface BackUpOptions {
  kind: BackupKind
  onProgress?(done: number): void
  /** Called once if the rename waits for another program: the status bar says so. */
  onWaiting?(): void
  /** Abandons the backup (an OS shutdown's budget): nothing is left, and it rejects with BACKUP_FAILED. */
  signal?: AbortSignal
  /** An archive file's archive date (`kind: 'archive'`), written to its meta and checked. */
  archiveBefore?: string
  /**
   * Default true: this is the ledger's latest backup (`backup.last`), and what changed before it is backed up. False
   * for an archive file, which the archive may yet delete (it fails, and nothing is removed): the changes it holds
   * must still be backed up as the ledger closes.
   */
  record?: boolean
}

export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  private get now() { return this.deps.now ?? (() => new Date()) }

  /** The default backup folder: the setting, or <Documents>/Tessera Backups. */
  folder(): string {
    return backupFolder(this.deps.settings(), this.deps.files.documentsPath())
  }

  /**
   * Where File › Back Up Ledger… suggests, and where an automatic backup goes: the default folder, the ledger's name
   * and the time, not taken yet.
   */
  suggestedPath(ledgerName: string): Promise<string> {
    return unusedPath(path.join(this.folder(), backupFileName(ledgerName, this.now())), file => this.deps.disk.exists(file))
  }

  /**
   * Backs the open ledger up to `target` (the backup extension is added if it is missing). A file already there is
   * replaced: the save dialog asked. Runs in the session's file-operation queue, so the ledger can't close meanwhile.
   * Nothing half-written is ever left under the target's name. Throws BACKUP_FAILED with a reason the user can act on.
   */
  backUp(target: string, options: BackUpOptions): Promise<BackupResult> {
    return this.deps.session.withOpenLedger((db, ledger) => this.backUpDatabase(db, ledger, target, options))
  }

  /**
   * `backUp`'s work, for a caller that already has the ledger's database and holds the file-operation queue: the
   * backup as the ledger closes, which runs inside the close.
   */
  async backUpDatabase(db: Database, ledger: LedgerInfo, target: string, options: BackUpOptions): Promise<BackupResult> {
    const file = withBackupExtension(path.resolve(target))
    const { disk } = this.deps
    const takenAt = this.now().toISOString()
    const meta: Record<string, Json> = {
      [LEDGER_BACKUP_META.takenAt]: takenAt,
      [LEDGER_BACKUP_META.kind]: options.kind,
      [LEDGER_BACKUP_META.ledgerName]: ledger.name,
      [LEDGER_BACKUP_META.ledgerPath]: ledger.path,
      [LEDGER_BACKUP_META.takenWith]: `ledger ${LEDGER_API_VERSION}`,
      ...(options.archiveBefore !== undefined && { [LEDGER_BACKUP_META.archiveBefore]: options.archiveBefore })
    }
    const partial = file + PARTIAL_SUFFIX
    const record = options.record !== false
    // Changes from here on are for the next backup; if this one fails, they all still are
    const undo = record ? this.deps.session.backupStarting() : () => {}
    const { signal } = options
    try {
      signal?.throwIfAborted()
      await disk.mkdir(path.dirname(file))
      await disk.remove(partial)            // one a crash left: it is ours, by its name
      await db.snapshot({ path: partial }, {
        meta, ...(options.onProgress && { onProgress: options.onProgress }), ...(signal && { signal })
      })
      await this.verify(partial, ledger, takenAt, options.archiveBefore)
      signal?.throwIfAborted()
      if (await disk.exists(file)) {
        if ((await discard(this.deps, file)) === 'failed') throw new Error(`“${path.basename(file)}” is already there and could not be replaced`)
      }
      await renameWithRetry(disk, partial, file, {
        ...this.deps.retry, ...(options.onWaiting && { onWaiting: options.onWaiting }), ...(signal && { signal })
      })
    } catch (err) {
      undo()
      await disk.remove(partial).catch(() => {})
      throw signal?.aborted ? new LedgerError('BACKUP_FAILED', 'There wasn’t time to finish the backup before the computer shut down.') : failure(err, file)
    }
    this.deps.log.info(`[ledger] Backed up ${ledger.path} to ${file}`)
    if (record) await this.remember(ledger, { takenAt, path: file })
    return { path: file, takenAt, ledgerName: ledger.name, ...(ledger.id !== undefined && { ledgerId: ledger.id }) }
  }

  /**
   * Whether closing `ledger` calls for an automatic backup: it changed since it opened or since its last backup began
   * (`changed`, from the session); or its last automatic backup failed (its changes then may be in no backup, even
   * if it is unchanged since it reopened); or it has never been backed up. Closing without changes makes no backup,
   * so retention never pushes the meaningful ones out with copies of the same thing.
   */
  async needsBackup(ledger: LedgerInfo, changed: boolean): Promise<boolean> {
    if (changed) return true
    const key = ledger.id ?? ledger.path
    if ((await this.problem())?.ledger === key) return true
    const last = await this.lastBackups().catch(() => ({} as Record<string, LastBackup>))
    return last[key] === undefined
  }

  // ---- Problems with automatic backups

  /** Records that an automatic backup of `ledger` failed or was skipped, for the status bar (now and at the next start). */
  async recordProblem(ledger: LedgerInfo, message: string): Promise<void> {
    const problem: BackupProblem = { ledger: ledger.id ?? ledger.path, ledgerName: ledger.name, message, at: this.now().toISOString() }
    this.deps.onProblem?.(problem)
    try {
      await this.deps.state.set(BACKUP_PROBLEM_KEY, problem)
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not record the backup problem: ${describe(err)}`)
    }
  }

  /** The recorded problem, if any. */
  async problem(): Promise<BackupProblem | undefined> {
    const stored = await this.deps.state.get<BackupProblem>(BACKUP_PROBLEM_KEY).catch(() => undefined)
    return stored && typeof stored === 'object' && typeof stored.message === 'string' && typeof stored.ledgerName === 'string' ? stored : undefined
  }

  /** A backup of `ledger` succeeded: a problem recorded for it is over. */
  private async clearProblem(ledger: LedgerInfo) {
    const problem = await this.problem()
    if (!problem || (problem.ledger !== ledger.id && problem.ledger !== ledger.path)) return
    this.deps.onProblem?.(undefined)
    try {
      await this.deps.state.remove(BACKUP_PROBLEM_KEY)
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not clear the backup problem: ${describe(err)}`)
    }
  }

  /** The copy must read back as a backup of this ledger, made now. */
  private async verify(partial: string, ledger: LedgerInfo, takenAt: string, archiveBefore?: string) {
    const meta = await this.deps.engine.readMeta({ path: partial })
    const good = typeof meta[LEDGER_META.format] === 'number'
      && meta[LEDGER_BACKUP_META.takenAt] === takenAt
      && (ledger.id === undefined || meta[LEDGER_META.id] === ledger.id)
      && (archiveBefore === undefined || meta[LEDGER_BACKUP_META.archiveBefore] === archiveBefore)
    if (!good) throw new Error('the copy did not read back as a backup of this ledger')
  }

  /** Each ledger's last backup, by id (or path, for a ledger without one): whether closing it needs one, reminders later. */
  private async remember(ledger: LedgerInfo, last: LastBackup) {
    try {
      await this.deps.state.update<Record<string, LastBackup>>(LAST_BACKUP_KEY, { [ledger.id ?? ledger.path]: last })
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not record the backup of ${ledger.path}: ${describe(err)}`)
    }
    await this.clearProblem(ledger)
  }

  /** Each ledger's last backup, as recorded. */
  async lastBackups(): Promise<Record<string, LastBackup>> {
    const stored = await this.deps.state.get<Record<string, LastBackup>>(LAST_BACKUP_KEY)
    return stored && typeof stored === 'object' ? stored : {}
  }

  /**
   * After a backup: when it is in the default folder, removes the expired backups of the same ledger there. Backups
   * saved anywhere else are never trimmed, and neither are those of a ledger with no id.
   */
  async trim(result: BackupResult): Promise<TrimResult | undefined> {
    if (result.ledgerId === undefined) return undefined
    const { disk } = this.deps
    const folder = path.dirname(result.path)
    if (!samePath(await disk.realpath(folder), await disk.realpath(this.folder()))) return undefined
    const settings = this.deps.settings()
    return trimFolder(this.deps, {
      folder, ledgerId: result.ledgerId, justMade: result.path, now: this.now(),
      policy: { trim: settings.trim, days: settings.retentionDays, keepAtLeast: settings.keepAtLeast }
    })
  }
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

/** The problem as the status bar's tooltip says it: "“Home” wasn’t backed up when it closed (9 Nov 2026, 10:14). …". */
export const problemText = (problem: BackupProblem) =>
  `“${problem.ledgerName}” wasn’t backed up when it closed (${dateTime(new Date(problem.at))}). ${problem.message}`

/** The first errno code in an error or its causes (the storage engine wraps what the file system threw). */
function errnoOf(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code
  }
  return undefined
}

/**
 * A file failure as the user should read it, what to do about it rather than a stack: for writing `file`, in its
 * folder. Undefined when the error isn't one of those (the caller words it).
 */
export function fileProblem(err: unknown, file: string): string | undefined {
  const folder = path.dirname(file)
  switch (errnoOf(err)) {
    case 'ENOSPC': return `There isn’t enough space in “${folder}”.`
    case 'EACCES': case 'EPERM': case 'EROFS': return `Tessera can’t write to “${folder}”.`
    case 'ENOENT': case 'ENOTDIR': return `The folder “${folder}” isn’t available.`
    case 'EBUSY': return `Another program, such as a sync or antivirus program, is using “${path.basename(file)}”. Try again in a moment.`
    default: return undefined
  }
}

function failure(err: unknown, file: string): LedgerError {
  if (isLedgerError(err)) return err
  if (errnoOf(err) === 'ENOSPC') return new LedgerError('BACKUP_FAILED', `There isn’t enough space for the backup in “${path.dirname(file)}”.`)
  return new LedgerError('BACKUP_FAILED', fileProblem(err, file) ?? `The backup couldn’t be written: ${err instanceof Error ? err.message : String(err)}`)
}
