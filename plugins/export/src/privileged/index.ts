// The export plugin (the export manager): File › Export… and Accounts › Export Account…, which write an open ledger's
// transactions to a file, for a spreadsheet, another finance program or another ledger. It knows no file format:
// file-type plugins contribute to `export.formats`, and their writers turn neutral data into bytes. It reads the ledger
// through accounts.service and never changes it, so a read-only ledger, an archive file even, can be exported. See
// docs/export-design.md.
import path from 'node:path'
import type { IpcMessage, PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS, LEDGER_SESSION_SERVICE, displayDate, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import {
  EXPORT_CHANNELS, EXPORT_COMMANDS, EXPORT_CONTEXT_KEYS, EXPORT_FORMATS_POINT, EXPORT_PLUGIN_ID, ExportError, isExportError,
  toExportResult, type ExportAccountArgs
} from '@tessera/export-api'
import { archivedNote } from '../shared/notes'
import { contributions } from './contributions'
import type { ExportDisk, SaveOptions } from './files'
import { Formats } from './formats'
import { Exporter, requestOf, type ExportReport } from './run'

export interface ActivateOptions {
  /** Tests write to memory, fix the clock, and shorten the waits. */
  disk?: ExportDisk
  save?: SaveOptions
  now?: () => Date
  writeTimeoutMs?: number
}

/** A ledger open, a format that writes, and nothing else running: an export can start. */
const CAN_EXPORT = `${LEDGER_CONTEXT_KEYS.isOpen} && ${EXPORT_CONTEXT_KEYS.hasFormats} && !${EXPORT_CONTEXT_KEYS.isRunning} && !${LEDGER_CONTEXT_KEYS.isBusy}`

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The message after an export: what went where, and anything cut, changed or left out. */
export function reportMessage(report: ExportReport): { message: string, detail: string } {
  const what = report.accountName !== undefined ? `“${report.accountName}”` : plural(report.accounts, 'account')
  const lines = [
    `${plural(report.transactions, 'transaction')} from ${what}, ${displayDate(report.range.from)} to ${displayDate(report.range.to)}.`,
    `Saved in ${path.dirname(report.path)}.`,
    ...[archivedNote(report.archived)].filter((note): note is string => note !== undefined),
    ...report.warnings
  ]
  return { message: `Exported to ${path.basename(report.path)}.`, detail: lines.join('\n') }
}

export function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)

  const formats = new Formats(context.extensions, context.services, context.logger)
  const exporter = new Exporter({
    session, accounts, files, prompts, state: context.state, formats, contextKeys: context.contextKeys, log: context.logger,
    ...(options.disk && { disk: options.disk }), ...(options.save && { save: options.save }), ...(options.now && { now: options.now }),
    ...(options.writeTimeoutMs !== undefined && { writeTimeoutMs: options.writeTimeoutMs })
  })
  /** An export from the dialog to the message after it; a failure the user can act on is said, and nothing written. */
  const run = async (startId?: string): Promise<void> => {
    try {
      const report = await exporter.exportFile(startId)
      if (report) await prompts.message({ kind: report.warnings.length > 0 ? 'warning' : 'info', title: 'Export', ...reportMessage(report) })
    } catch (err) {
      if (!isExportError(err)) throw err
      await prompts.message({ kind: 'error', title: 'Export', message: 'Nothing was exported.', detail: err.message })
    }
  }
  const publishFormats = () => context.contextKeys.set(EXPORT_CONTEXT_KEYS.hasFormats, formats.all().length > 0)

  context.subscriptions.push(
    ...contributions().map(([point, id, impl]) => context.extensions.contribute(EXPORT_PLUGIN_ID, point, id, impl)),
    context.extensions.onDidChange(({ point }) => { if (point === EXPORT_FORMATS_POINT) publishFormats() }),
    // File › Export…: a read-only ledger can be exported too, as nothing in it changes
    context.commands.register(EXPORT_COMMANDS.file, () => run(), { enablement: CAN_EXPORT }),
    // Accounts › Export Account…: the same, starting from one account, the argument's or the navigator's selection
    context.commands.register(EXPORT_COMMANDS.account, (args?: unknown) => {
      const given = (args as Partial<ExportAccountArgs> | undefined)?.id
      const selected = context.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.selectionKind) === 'account'
        ? context.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.selectionId) : undefined
      const id = typeof given === 'string' ? given : typeof selected === 'string' ? selected : undefined
      return id === undefined ? Promise.resolve() : run(id)
    }, { enablement: `${CAN_EXPORT} && ${ACCOUNTS_CONTEXT_KEYS.selectionKind} == 'account'` }),
    // The Export dialog's preview
    context.ipc.register(EXPORT_CHANNELS.check, (msg: IpcMessage<unknown>) => toExportResult(async () => {
      const request = requestOf(msg.data)
      if (!request) throw new ExportError('INVALID', 'The export asked for isn’t one Tessera can check.')
      return exporter.preview(request)
    }))
  )
  context.contextKeys.set(EXPORT_CONTEXT_KEYS.isRunning, false)
  publishFormats()
  // File-type plugins that activate after this one are counted once every plugin has
  context.lifecycle.onStarted(() => publishFormats())
}
