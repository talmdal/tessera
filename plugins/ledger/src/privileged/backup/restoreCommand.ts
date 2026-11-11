// File › Restore Ledger…: the ledger's operation while the Restore dialog is open (so nothing else opens, closes,
// imports or backs up meanwhile), the dialog's requests, and the result in the status bar.
import path from 'node:path'
import type { Disposable, IpcMessage, PluginContext, ShellPrompts } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_DIALOGS, LEDGER_EVENTS, LEDGER_PLUGIN_ID, isLedgerError, toResult,
  type LedgerInfo, type RestoreDialogInput, type RestoreDialogResult, type RestoreLedgerArgs, type RestoreRequest
} from '@tessera/ledger-api'
import type { LedgerSessionImpl } from '../LedgerSessionImpl'
import type { Activity } from './activity'
import type { RestoreService } from './restore'

/** `events.emit` adds the plugin's prefix itself. */
const local = (event: string) => event.slice(`${LEDGER_PLUGIN_ID}:`.length)

/** "9 Nov 2026, 10:14", as the user's clock and calendar show it. */
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export interface RestoreCommandDeps {
  session: Pick<LedgerSessionImpl, 'beginOperation'>
  restore: RestoreService
  prompts: Pick<ShellPrompts, 'show' | 'message'>
  activity: Activity
}

export function registerRestore(context: Pick<PluginContext, 'commands' | 'ipc' | 'events' | 'logger'>, deps: RestoreCommandDeps): Disposable[] {
  const { session, restore, prompts, activity } = deps

  const report = async (err: unknown) => {
    if (!isLedgerError(err)) context.logger.error('[ledger] Restoring failed', err)
    await prompts.message({ kind: 'error', message: 'Could not restore a ledger.', detail: err instanceof Error ? err.message : String(err) })
  }

  return [
    context.commands.register(LEDGER_COMMANDS.restore, async (args?: unknown): Promise<LedgerInfo | undefined> => {
      const requested = (args as RestoreLedgerArgs | undefined)?.path
      if (requested !== undefined && (typeof requested !== 'string' || requested === '')) throw new Error('ledger.restore needs { path } to be a path')

      let operation: Disposable
      try {
        operation = session.beginOperation('Restoring a ledger')
      } catch (err) {
        await report(err)
        return undefined
      }
      restore.begin()
      try {
        const input: RestoreDialogInput = requested === undefined ? {} : { preselect: (await restore.preselect(requested)).path }
        const result = await prompts.show<RestoreDialogResult, RestoreDialogInput>(LEDGER_DIALOGS.restore, input)
        if (!result?.ledger) return undefined
        const { ledger, kept, takenAt } = result
        activity.start('Restoring').done(`Restored “${ledger.name}” as it was on ${when(takenAt)}`)
        // Said once it is done, so nobody is left wondering where the file they had went
        await prompts.message({
          kind: 'info',
          title: 'Restore Ledger',
          message: `“${ledger.name}” has been restored.`,
          detail: [
            `It is as it was on ${when(takenAt)}.`,
            kept
              ? `The file you had before is kept as “${path.basename(kept)}”, in “${path.dirname(kept)}”.`
              : `It is “${path.basename(ledger.path)}”, in “${path.dirname(ledger.path)}”.`
          ].join(' ')
        })
        return ledger
      } finally {
        // The dialog's window may have closed while a restore ran: it finishes before the ledger is let go
        await restore.settled()
        restore.end()
        operation.dispose()
      }
    }, { enablement: `!${LEDGER_CONTEXT_KEYS.isBusy}` }),

    // The Restore dialog's requests: answered only while the command has it open
    context.ipc.register(LEDGER_CHANNELS.restoreList, () => restore.list()),
    context.ipc.register(LEDGER_CHANNELS.restoreBrowse, (msg: IpcMessage) => toResult(() => restore.browse(msg.sender?.windowId))),
    context.ipc.register(LEDGER_CHANNELS.restorePlan, (msg: IpcMessage<{ path?: unknown }>) => toResult(() => restore.plan(msg.data?.path))),
    context.ipc.register(LEDGER_CHANNELS.restoreFolder, (msg: IpcMessage<{ defaultPath?: unknown }>) =>
      restore.chooseFolder(typeof msg.data?.defaultPath === 'string' ? msg.data.defaultPath : undefined, msg.sender?.windowId)),
    context.ipc.register(LEDGER_CHANNELS.restoreRun, (msg: IpcMessage<RestoreRequest>) =>
      toResult(() => restore.run(msg.data, progress => context.events.emit(local(LEDGER_EVENTS.restoreProgress), progress))))
  ]
}
