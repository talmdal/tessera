// File › Back Up Ledger…: the ledger operation for its whole run (so no import or file command overlaps it), the save
// dialog in the default backup folder, the backup with its progress in the status bar, the result, then retention.
import path from 'node:path'
import type { Disposable, PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import {
  LEDGER_BACKUP_FILTER, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, isLedgerError, type BackUpLedgerArgs
} from '@tessera/ledger-api'
import type { LedgerDisk } from '../disk'
import type { LedgerSessionImpl } from '../LedgerSessionImpl'
import type { Activity } from './activity'
import type { BackupService } from './BackupService'
import { clockTime } from './naming'

const K = LEDGER_CONTEXT_KEYS

export interface BackupCommandDeps {
  session: Pick<LedgerSessionImpl, 'current' | 'beginOperation'>
  backups: BackupService
  files: Pick<ShellFiles, 'showSaveDialog'>
  prompts: Pick<ShellPrompts, 'message'>
  disk: Pick<LedgerDisk, 'mkdir'>
  activity: Activity
}

const requestedPath = (args: unknown): string | undefined => {
  const requested = (args as BackUpLedgerArgs | undefined)?.path
  if (requested !== undefined && (typeof requested !== 'string' || requested === '')) throw new Error('ledger.backup needs { path } to be a path')
  return requested
}

export function registerBackupCommand(context: Pick<PluginContext, 'commands' | 'logger'>, deps: BackupCommandDeps): Disposable {
  const { session, backups, files, prompts, disk, activity } = deps
  const log = context.logger

  const report = async (err: unknown) => {
    if (!isLedgerError(err)) log.error('[ledger] Backing up failed', err)
    await prompts.message({ kind: 'error', message: 'Could not back up the ledger.', detail: err instanceof Error ? err.message : String(err) })
  }

  return context.commands.register(LEDGER_COMMANDS.backup, async (args?: unknown): Promise<string | undefined> => {
    const requested = requestedPath(args)
    const ledger = session.current
    if (!ledger) return undefined

    let operation: Disposable
    try {
      operation = session.beginOperation(`Backing up “${ledger.name}”`)
    } catch (err) {
      await report(err)
      return undefined
    }
    try {
      let target = requested
      if (target === undefined) {
        // So the dialog opens there; a folder that can't be made (an unplugged drive) is reported when writing
        await disk.mkdir(backups.folder()).catch(() => {})
        target = await files.showSaveDialog({
          title: 'Back Up Ledger',
          defaultPath: await backups.suggestedPath(ledger.name),
          filters: [LEDGER_BACKUP_FILTER],
          buttonLabel: 'Back Up'
        })
        if (target === undefined) return undefined
      }

      const status = activity.start(`Backing up “${ledger.name}”`)
      let result
      try {
        result = await backups.backUp(target, {
          kind: 'manual',
          onProgress: done => status.progress(done),
          onWaiting: () => status.note(`Waiting for another program to release “${path.basename(target!)}”…`)
        })
      } catch (err) {
        status.done()
        await report(err)
        return undefined
      }
      status.done(`Backed up “${ledger.name}” at ${clockTime(new Date(result.takenAt))}`)

      // After the result is shown: on Windows the Recycle Bin takes about 50 ms a file
      try {
        const trimmed = await backups.trim(result)
        const removed = trimmed ? trimmed.trashed.length + trimmed.deleted.length : 0
        if (removed > 0) log.info(`[ledger] Removed ${removed} expired backup${removed === 1 ? '' : 's'} of “${ledger.name}”`)
      } catch (err) {
        log.warn(`[ledger] Could not remove expired backups: ${err instanceof Error ? err.message : String(err)}`)
      }
      return result.path
    } finally {
      operation.dispose()
    }
  }, { enablement: `${K.isOpen} && !${K.isBusy} && !${K.isArchive}` })
}
