// Backing up when the ledger closes: Close Ledger, switching ledgers, a user quit (in pass 1, with no time limit) and an
// OS shutdown (within a budget). Only when the ledger changed since its last backup, or was never backed up; never on
// Delete Ledger… or a restore in place. See docs/backup-restore-design.md, "Backing up when the ledger closes".
import path from 'node:path'
import type { Database, Disposable, Logger } from '@tessera/types'
import { isLedgerError, type LedgerInfo } from '@tessera/ledger-api'
import type { CloseReason, LedgerSessionImpl } from '../LedgerSessionImpl'
import { realTimers, type Activity, type Timers } from './activity'
import type { BackupResult, BackupService } from './BackupService'
import type { BackupSettings } from './settings'
import { clockTime } from './naming'

/** On an OS shutdown the backup gets this long: every quit listener shares the lifecycle's 10 s. */
export const SHUTDOWN_BUDGET_MS = 3000
/** On an OS shutdown, how long the backup waits for a running operation (an import unwinding) to end. */
export const OPERATION_WAIT_MS = 2000

export interface AutoBackupDeps {
  session: Pick<LedgerSessionImpl, 'current' | 'operation' | 'onDidChangeOperation' | 'changedSinceBackup' | 'beginOperation'>
  backups: Pick<BackupService, 'backUp' | 'backUpDatabase' | 'suggestedPath' | 'needsBackup' | 'recordProblem' | 'trim'>
  settings: () => BackupSettings
  activity: Activity
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  timers?: Timers
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

export class AutoBackup {
  constructor(private readonly deps: AutoBackupDeps) {}

  private get timers() { return this.deps.timers ?? realTimers }

  private async needed(ledger: LedgerInfo): Promise<boolean> {
    if (!this.deps.settings().onClose) return false
    return this.deps.backups.needsBackup(ledger, this.deps.session.changedSinceBackup)
  }

  /**
   * The session's close hook: runs as the ledger closes, after the `onWillClose` listeners, before the database
   * closes. Never throws, and never stops the close: a failure is recorded for the status bar.
   */
  readonly onClosing = async (db: Database, ledger: LedgerInfo, why: CloseReason): Promise<void> => {
    // Delete: the user is discarding it. A restore in place: the current file is kept. A user quit: pass 1 did it
    if (why === 'delete' || why === 'restore' || why === 'quit') return
    if (!(await this.needed(ledger))) return
    if (why === 'system') return this.duringShutdown(db, ledger)

    const status = this.deps.activity.start(`Backing up “${ledger.name}”`)
    let result: BackupResult
    try {
      const target = await this.deps.backups.suggestedPath(ledger.name)
      result = await this.deps.backups.backUpDatabase(db, ledger, target, {
        kind: 'auto',
        onProgress: done => status.progress(done),
        onWaiting: () => status.note(`Waiting for another program to release “${path.basename(target)}”…`)
      })
    } catch (err) {
      status.done()
      await this.failed(ledger, err)
      return
    }
    status.done(`Backed up “${ledger.name}” at ${clockTime(new Date(result.takenAt))}`)
    await this.trim(result)
  }

  /**
   * Pass 1 of a user quit: a running operation is a reason to wait; otherwise the backup, with its progress in the
   * status bar and no time limit. A failure is the reason: the user can plug the drive back in and Retry, Quit
   * Anyway, or Cancel.
   */
  readonly beforeQuit = async (): Promise<string | undefined> => {
    const { session, backups, activity } = this.deps
    const running = session.operation
    if (running !== undefined) return `“${running}” is still running.`
    const ledger = session.current
    if (!ledger || !(await this.needed(ledger))) return undefined

    let operation: Disposable
    try {
      operation = session.beginOperation(`Backing up “${ledger.name}”`)
    } catch {
      return `“${session.operation}” is still running.`
    }
    const status = activity.start(`Backing up “${ledger.name}”`)
    try {
      const target = await backups.suggestedPath(ledger.name)
      const result = await backups.backUp(target, {
        kind: 'auto',
        onProgress: done => status.progress(done),
        onWaiting: () => status.note(`Waiting for another program to release “${path.basename(target)}”…`)
      })
      status.done(`Backed up “${ledger.name}” at ${clockTime(new Date(result.takenAt))}`)
      await this.trim(result)
      return undefined
    } catch (err) {
      status.done()
      const message = await this.failed(ledger, err)
      return `“${ledger.name}” couldn’t be backed up. ${message}`
    } finally {
      operation.dispose()
    }
  }

  /**
   * An OS shutdown: nobody to ask, and a budget. A running operation gets a moment to unwind (its dialogs were
   * cancelled); if it doesn't, the backup is skipped rather than capture a half-applied import. The backup is
   * abandoned at the budget, leaving nothing behind.
   */
  private async duringShutdown(db: Database, ledger: LedgerInfo) {
    const running = this.deps.session.operation
    if (running !== undefined && !(await this.operationEnds(OPERATION_WAIT_MS))) {
      this.deps.log.warn(`[ledger] Did not back up ${ledger.path} as the computer shut down: “${running}” was still running`)
      await this.deps.backups.recordProblem(ledger, `“${running}” was still running.`)
      return
    }
    const controller = new AbortController()
    const timer = this.timers.setTimeout(() => controller.abort(), SHUTDOWN_BUDGET_MS)
    try {
      const target = await this.deps.backups.suggestedPath(ledger.name)
      const result = await this.deps.backups.backUpDatabase(db, ledger, target, { kind: 'auto', signal: controller.signal })
      if (!controller.signal.aborted) await this.trim(result)
    } catch (err) {
      await this.failed(ledger, err)
    } finally {
      this.timers.clearTimeout(timer)
    }
  }

  /** Resolves whether the running operation ended within `ms`. */
  private operationEnds(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      let subscription: Disposable | undefined
      const finish = (ended: boolean) => {
        subscription?.dispose()
        this.timers.clearTimeout(timer)
        resolve(ended)
      }
      const timer = this.timers.setTimeout(() => finish(false), ms)
      subscription = this.deps.session.onDidChangeOperation(label => { if (label === undefined) finish(true) })
      if (this.deps.session.operation === undefined) finish(true)
    })
  }

  /** Records a failed backup for the status bar; resolves its message. */
  private async failed(ledger: LedgerInfo, err: unknown): Promise<string> {
    if (isLedgerError(err)) this.deps.log.warn(`[ledger] Could not back up ${ledger.path} as it closed: ${err.message}`)
    else this.deps.log.error(`[ledger] Could not back up ${ledger.path} as it closed`, err)
    const message = describe(err)
    await this.deps.backups.recordProblem(ledger, message)
    return message
  }

  /** Retention after an automatic backup, as after a manual one. */
  private async trim(result: BackupResult) {
    try {
      const trimmed = await this.deps.backups.trim(result)
      const removed = trimmed ? trimmed.trashed.length + trimmed.deleted.length : 0
      if (removed > 0) this.deps.log.info(`[ledger] Removed ${removed} expired backup${removed === 1 ? '' : 's'} of “${result.ledgerName}”`)
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not remove expired backups: ${describe(err)}`)
    }
  }
}
