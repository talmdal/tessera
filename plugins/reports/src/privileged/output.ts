// The report on paper and in spreadsheets (R6): Print Report…, Save Report as PDF… and Export Report…, each of the
// report the view shows, as it shows it. Printing is the view's and the shell's together: the plugin asks the view to
// draw the report in its print area (`reports:print.requested`); the view says when it has, and on what orientation
// (`reports:print.ready`); the plugin then prints that window through `shell.print`, or writes the PDF. The CSV is the
// plugin's alone: the report is run again as shown, and its table written through `shell.files.writeFile`. The Save
// dialog suggests "<report> <period>" in the folder used last. See docs/reporting-design.md, "Printing and exporting".
import path from 'node:path'
import type { Disposable, IpcMessage, PluginContext, ShellFiles, ShellPrint, ShellPrompts } from '@tessera/types'
import { MAIN_ACTIVE_VIEW_KEY } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import { safeFileName } from '@tessera/export-api'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_CONTEXT_KEYS as K, REPORTS_EVENTS, REPORTS_VIEWS, isReportsError,
  type DimensionField, type PrintReady, type PrintRequest, type ReportResult, type ReportsResult, type RunArgs
} from '@tessera/reports-api'
import { csvBytes, reportCsv } from './csv'
import type { ReportsServiceImpl } from './ReportsServiceImpl'
import { local, type ViewState } from './viewState'

/** Key in `context.state`: the folder a report was last exported or saved as PDF to. */
export const FOLDER_KEY = 'folder'

/** How long the view has to draw the report for printing before the plugin gives up: the chart may load first. */
export const PRINT_WAIT_MS = 60_000

/**
 * The three act on the report in front: enabled while the report view is the main area's view, so Ctrl+P in the
 * register doesn't print a report behind it.
 */
export const IN_FRONT = `${LEDGER_CONTEXT_KEYS.isOpen} && ${K.shown} && ${MAIN_ACTIVE_VIEW_KEY} == '${REPORTS_VIEWS.view}'`

/** "Spending by Category March 2027.pdf": the report's name and its period (the subtitle's first part), safe as a file name. */
export function fileNameFor(result: Pick<ReportResult, 'title' | 'subtitle'>, extension: 'csv' | 'pdf'): string {
  const period = result.subtitle.split(' · ')[0]?.trim() ?? ''
  return `${safeFileName([result.title, period].filter(Boolean).join(' '))}.${extension}`
}

interface Pending {
  output: PrintRequest['output']
  /** Where the PDF goes. */
  path?: string
  done(printed: boolean): void
  timer: ReturnType<typeof setTimeout>
}

export interface OutputDeps {
  context: PluginContext
  service: ReportsServiceImpl
  view: ViewState
  prompts: ShellPrompts
  /** Looked up when used: the shell provides them before any plugin activates. */
  files(): ShellFiles
  print(): ShellPrint
  waitMs?: number
}

export function registerOutput({ context, service, view, prompts, files, print, waitMs = PRINT_WAIT_MS }: OutputDeps): Disposable[] {
  let requests = 0
  const pending = new Map<number, Pending>()

  const failed = async (doing: string, err: unknown) => {
    if (!isReportsError(err) && !(err instanceof Error && 'code' in err)) context.logger.error(`[reports] ${doing} failed`, err)
    await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
  }

  /** The report shown, run as it is shown. */
  const shownResult = async (current: RunArgs) => service.run(current.ref, current.parameters, current.options ?? {})

  /** A path the user chose for the file, in the folder used last (else Documents); undefined when cancelled. */
  const chooseFile = async (result: ReportResult, extension: 'csv' | 'pdf') => {
    const folder = await context.state.get<string>(FOLDER_KEY).catch(() => undefined) ?? files().documentsPath()
    const chosen = await files().showSaveDialog({
      title: extension === 'csv' ? 'Export Report' : 'Save Report as PDF',
      defaultPath: path.join(folder, fileNameFor(result, extension)),
      filters: extension === 'csv' ? [{ name: 'CSV (comma-separated values)', extensions: ['csv'] }] : [{ name: 'PDF document', extensions: ['pdf'] }],
      buttonLabel: extension === 'csv' ? 'Export' : 'Save'
    })
    if (chosen) await context.state.set(FOLDER_KEY, path.dirname(chosen)).catch(() => undefined)
    return chosen
  }

  /** Asks the view to draw the report for printing; resolves once printed or written (true), or not (false). */
  const printShown = (output: PrintRequest['output'], filePath?: string) => new Promise<boolean>(resolve => {
    const request = ++requests
    const timer = setTimeout(() => {
      if (!pending.delete(request)) return
      resolve(false)
      prompts.message({
        kind: 'error', message: output === 'pdf' ? 'Could not save the report as PDF.' : 'Could not print the report.',
        detail: 'The report wasn’t ready in time. Show it, then try again.'
      }).catch(() => undefined)
    }, waitMs)
    pending.set(request, { output, ...(filePath !== undefined && { path: filePath }), done: resolve, timer })
    const event: PrintRequest = { request, output }
    context.events.emit(local(REPORTS_EVENTS.print), event)
  })

  /** The view has drawn the report (or can't): print the window it is in, or write the PDF. */
  const ready = async (msg: IpcMessage<PrintReady>): Promise<ReportsResult<boolean>> => {
    const data = msg.data
    const entry = typeof data?.request === 'number' ? pending.get(data.request) : undefined
    if (!data || !entry) return { ok: false, error: { code: 'NOT_FOUND', message: 'Nothing is waiting to be printed.' } }
    pending.delete(data.request)
    clearTimeout(entry.timer)
    const doing = entry.output === 'pdf' ? 'save the report as PDF' : 'print the report'
    if ('problem' in data) {
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: String(data.problem) })
      entry.done(false)
      return { ok: true, value: false }
    }
    const target = msg.sender?.windowId !== undefined ? { windowId: msg.sender.windowId } : {}
    try {
      const landscape = data.landscape === true
      const printed = entry.output === 'pdf'
        ? await print().savePdf({ ...target, path: entry.path!, landscape }).then(() => true)
        : await print().print({ ...target, landscape })
      entry.done(printed)
      return { ok: true, value: printed }
    } catch (err) {
      await failed(doing, err)
      entry.done(false)
      return { ok: true, value: false }
    }
  }

  return [
    context.commands.register(C.print, async () => view.get() ? printShown('print') : false, { enablement: IN_FRONT }),

    context.commands.register(C.savePdf, async () => {
      const current = view.get()
      if (!current) return false
      let result: ReportResult
      try {
        result = await shownResult(current)
      } catch (err) {
        await failed('save the report as PDF', err)
        return false
      }
      const chosen = await chooseFile(result, 'pdf')
      return chosen ? printShown('pdf', chosen) : false
    }, { enablement: IN_FRONT }),

    context.commands.register(C.exportCsv, async () => {
      const current = view.get()
      if (!current) return false
      let result: ReportResult
      let rowsLabel: string | undefined
      try {
        const resolved = await service.resolve(current.ref, current.parameters, current.options ?? {})
        const rows = resolved.spec.query.rows?.dimension
        rowsLabel = resolved.source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === rows)?.label
        result = await shownResult(current)
      } catch (err) {
        await failed('export the report', err)
        return false
      }
      const csv = reportCsv(result, { collapsed: current.view?.collapsed ?? [], ...(rowsLabel !== undefined && { rowsLabel }) })
      const chosen = await chooseFile(result, 'csv')
      if (!chosen) return false
      try {
        await files().writeFile(chosen, csvBytes(csv))
        return true
      } catch (err) {
        await failed('export the report', err)
        return false
      }
    }, { enablement: IN_FRONT }),

    context.ipc.register(REPORTS_CHANNELS.printReady, ready),

    // Closing: nothing is left waiting
    {
      dispose: () => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.done(false) }
        pending.clear()
      }
    }
  ]
}
