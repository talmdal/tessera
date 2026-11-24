// The report views talk to the plugin here. Replies that can fail because of the user (a period too long, a report no
// longer offered, a source that failed) are `ReportsResult`s, so the view says what went wrong and stays usable.
import type { Disposable, IpcMessage, PluginContext } from '@tessera/types'
import {
  REPORTS_CHANNELS, ReportsError, toReportsResult,
  type Member, type MembersArgs, type OpenedView, type ReportParameters, type ReportResult, type ReportsResult, type RunArgs, type SaveArgs,
  type SavedReport, type ViewChoices
} from '@tessera/reports-api'
import { refOf } from './commands'
import { basisFor, viewOf } from './saving'
import type { ReportsServiceImpl } from './ReportsServiceImpl'
import type { ReportsViewSupport } from './viewSupport'
import type { ViewState } from './viewState'

const params = (value: unknown): ReportParameters => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ReportParameters : {}
const options = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, string | boolean> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''

/** The report a message names, or INVALID. */
const refIn = (data: unknown) => {
  const ref = refOf((data as { ref?: unknown } | undefined)?.ref)
  if (!ref) throw new ReportsError('INVALID', 'Say which report.', 'ref')
  return ref
}

export function registerIpc(context: PluginContext, service: ReportsServiceImpl, support: ReportsViewSupport, view: ViewState): Disposable[] {
  return [
    context.ipc.register(REPORTS_CHANNELS.catalog, () => view.catalog()),

    context.ipc.register(REPORTS_CHANNELS.open, async (msg: IpcMessage<{ ref?: unknown }>): Promise<ReportsResult<OpenedView>> =>
      toReportsResult(() => {
        const ref = refIn(msg.data)
        return support.open(ref, view.carried(), 'definitionId' in ref ? view.lastFor(ref.definitionId) : undefined)
      })),

    context.ipc.register(REPORTS_CHANNELS.run, async (msg: IpcMessage<RunArgs>): Promise<ReportsResult<ReportResult>> =>
      toReportsResult(async () => service.run(refIn(msg.data), params(msg.data?.parameters), options(msg.data?.options)))),

    context.ipc.register(REPORTS_CHANNELS.members, async (msg: IpcMessage<MembersArgs>): Promise<ReportsResult<Member[]>> =>
      toReportsResult(async () => service.members(refIn(msg.data), {
        ...(typeof msg.data?.dimension === 'string' && { dimension: msg.data.dimension }),
        ...(typeof msg.data?.parameter === 'string' && { parameter: msg.data.parameter }),
        parameters: params(msg.data?.parameters)
      }))),

    context.ipc.register(REPORTS_CHANNELS.select, async (msg: IpcMessage<RunArgs>) => {
      const ref = refOf(msg.data?.ref)
      if (!ref) throw new Error('A selection is { ref, parameters, options?, view? }')
      const shownAs = viewOf(msg.data?.view as ViewChoices | undefined)
      await view.report({
        ref, parameters: params(msg.data?.parameters), ...(msg.data?.options && { options: options(msg.data.options) }),
        ...(msg.data?.view && { view: { ...shownAs, collapsed: shownAs?.collapsed ?? [] } })
      })
    }),

    // Save Report As…: the report as shown, under a name, in the ledger. Every check is the service's
    context.ipc.register(REPORTS_CHANNELS.save, async (msg: IpcMessage<SaveArgs>): Promise<ReportsResult<SavedReport>> =>
      toReportsResult(async () => {
        const ref = refIn(msg.data)
        const shownAs = viewOf(msg.data?.view)
        return service.saveReport({
          name: text(msg.data?.name), basis: await basisFor(service, ref, options(msg.data?.options)), parameters: params(msg.data?.parameters),
          ...(shownAs && { view: shownAs })
        })
      })),

    context.ipc.register(REPORTS_CHANNELS.rename, async (msg: IpcMessage<{ id?: unknown, name?: unknown, expectedRev?: unknown }>): Promise<ReportsResult<SavedReport>> =>
      toReportsResult(() => service.updateReport(text(msg.data?.id), { name: text(msg.data?.name) },
        typeof msg.data?.expectedRev === 'number' ? { expectedRev: msg.data.expectedRev } : {}))),

    context.ipc.register(REPORTS_CHANNELS.duplicate, async (msg: IpcMessage<{ id?: unknown, name?: unknown }>): Promise<ReportsResult<SavedReport>> =>
      toReportsResult(() => service.duplicateReport(text(msg.data?.id), text(msg.data?.name))))
  ]
}
