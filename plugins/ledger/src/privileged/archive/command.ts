// File › Archive Ledger…: the ledger's operation while the Archive dialog is open (so nothing else opens, closes,
// imports or backs up meanwhile), the dialog's requests, and the result: a message saying where the archive file is,
// and the status bar. With an argument (`{ before }`), the archive runs without the dialog.
// See docs/ledger-compaction-design.md, "The archive, step by step".
import path from 'node:path'
import type { Disposable, IpcMessage, PluginContext, ShellPrompts } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_DIALOGS, LEDGER_EVENTS, LEDGER_PLUGIN_ID, displayDate, displaySize,
  isLedgerError, toResult,
  type ArchiveDialogInput, type ArchiveDialogResult, type ArchiveLedgerArgs, type ArchiveOutcome, type ArchiveProgress, type ArchiveRunRequest
} from '@tessera/ledger-api'
import type { LedgerSessionImpl } from '../LedgerSessionImpl'
import type { Activity } from '../backup/activity'
import type { ArchiveService } from './ArchiveService'

/** `events.emit` adds the plugin's prefix itself. */
const local = (event: string) => event.slice(`${LEDGER_PLUGIN_ID}:`.length)

export interface ArchiveCommandDeps {
  session: Pick<LedgerSessionImpl, 'current' | 'beginOperation'>
  archives: ArchiveService
  prompts: Pick<ShellPrompts, 'show' | 'message'>
  activity: Activity
}

/** What the archive did, as the message after it says it. */
export function archivedMessage(ledgerName: string, outcome: ArchiveOutcome): { message: string, detail: string } {
  return {
    message: `“${ledgerName}” has been archived.`,
    detail: [
      `Removed, all dated before ${displayDate(outcome.before)}: ${outcome.summaries.join('; ')}.`,
      'Each account’s balance was carried into its opening balance, so every balance is as it was.',
      `The archived transactions are in the archive file “${path.basename(outcome.copy.path)}”, in “${path.dirname(outcome.copy.path)}”. To see them, open that file with File › Open Ledger….`,
      ...compactionText(outcome.compaction)
    ].join(' ')
  }
}

/** What compacting the file did, for the message: how much smaller it is, or why it isn't (the archive stands). */
function compactionText(compaction: ArchiveOutcome['compaction']): string[] {
  if (!compaction) return []
  if ('problem' in compaction) return [`The ledger’s file couldn’t be made smaller: ${compaction.problem.replace(/\.$/, '')}. Everything was archived all the same.`]
  if (compaction.after >= compaction.before) return []
  return [`The ledger’s file is now ${displaySize(compaction.after)}, down from ${displaySize(compaction.before)}.`]
}

export function registerArchive(context: Pick<PluginContext, 'commands' | 'ipc' | 'events' | 'logger'>, deps: ArchiveCommandDeps): Disposable[] {
  const { session, archives, prompts, activity } = deps

  const report = async (err: unknown) => {
    if (!isLedgerError(err)) context.logger.error('[ledger] Archiving failed', err)
    await prompts.message({ kind: 'error', message: 'Could not archive the ledger.', detail: err instanceof Error ? err.message : String(err) })
  }
  const progress = (event: ArchiveProgress) => context.events.emit(local(LEDGER_EVENTS.archiveProgress), event)

  return [
    context.commands.register(LEDGER_COMMANDS.archive, async (args?: unknown): Promise<ArchiveOutcome | undefined> => {
      const requested = args as ArchiveLedgerArgs | undefined
      if (requested !== undefined && (typeof requested !== 'object' || requested === null || typeof requested.before !== 'string')) {
        throw new Error('ledger.archive needs { before } to be a date, YYYY-MM-DD')
      }
      const ledger = session.current
      if (!ledger) return undefined

      let operation: Disposable
      try {
        operation = session.beginOperation(`Archiving “${ledger.name}”`)
      } catch (err) {
        await report(err)
        return undefined
      }
      archives.begin()
      try {
        let outcome: ArchiveOutcome | undefined
        if (requested) {
          try {
            outcome = await archives.run(requested.before, requested.options, progress)
          } catch (err) {
            await report(err)
            return undefined
          }
        } else {
          const input = await archives.dialogInput()
          outcome = await prompts.show<ArchiveDialogResult, ArchiveDialogInput>(LEDGER_DIALOGS.archive, input)
          // The window closed without the outcome (while the archive ran, say): what the archive did is still reported
          if (!outcome) {
            await archives.settled()
            outcome = archives.completed
          }
        }
        if (!outcome) return undefined
        activity.start('Archiving').done(`Archived “${ledger.name}” before ${displayDate(outcome.before)}`)
        await prompts.message({ kind: 'info', title: 'Archive Ledger', ...archivedMessage(ledger.name, outcome) })
        return outcome
      } finally {
        // The dialog's window may have closed while an archive ran: it finishes before the ledger is let go
        await archives.settled()
        archives.end()
        operation.dispose()
      }
    }, { enablement: `${K.isOpen} && !${K.isReadOnly} && !${K.isBusy}` }),

    // The Archive dialog's requests: answered only while the command has it open
    context.ipc.register(LEDGER_CHANNELS.archivePreview, (msg: IpcMessage<ArchiveRunRequest>) =>
      toResult(() => archives.preview(msg.data?.before, msg.data?.options))),
    context.ipc.register(LEDGER_CHANNELS.archiveRun, (msg: IpcMessage<ArchiveRunRequest>) =>
      toResult(() => archives.runFromDialog(msg.data?.before, msg.data?.options, progress)))
  ]
}
