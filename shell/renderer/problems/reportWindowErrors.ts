// shell/renderer/problems/reportWindowErrors.ts — sends a window's uncaught errors to the main process's
// problem log, so a view that breaks is as visible as a plugin that failed to load.
import type { TesseraBridge } from '@tessera/types'
import { PROBLEMS_REPORT, REPORT_LIMIT, type ProblemReport } from '../../../shared/problems/types'

const describe = (reason: unknown): { message: string, detail?: string } => {
  if (reason instanceof Error) return { message: reason.message || reason.name, ...(reason.stack !== undefined && { detail: reason.stack }) }
  if (typeof reason === 'string') return { message: reason }
  try { return { message: JSON.stringify(reason) ?? String(reason) } } catch { return { message: String(reason) } }
}

/** How many reports a window may send in a burst before it stops, so an error thrown every frame can't flood the log. */
const BURST = 20
const BURST_WINDOW_MS = 10_000

export function reportWindowErrors(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, bridge: Pick<TesseraBridge, 'invoke'>, now: () => number = Date.now) {
  let windowStart = 0
  let sent = 0

  const send = (report: ProblemReport) => {
    const at = now()
    if (at - windowStart > BURST_WINDOW_MS) { windowStart = at; sent = 0 }
    if (++sent > BURST) return
    const clipped: ProblemReport = {
      ...report,
      message: report.message.slice(0, REPORT_LIMIT),
      ...(report.detail !== undefined && { detail: report.detail.slice(0, REPORT_LIMIT) })
    }
    deliver(bridge, clipped)
  }

  const onError = (event: Event) => {
    const { error, message } = event as ErrorEvent
    const described = error !== undefined && error !== null ? describe(error) : { message: message || 'An error occurred in this window' }
    send({ level: 'error', message: `Uncaught error: ${described.message}`, ...(described.detail !== undefined && { detail: described.detail }) })
  }
  const onRejection = (event: Event) => {
    const described = describe((event as PromiseRejectionEvent).reason)
    send({ level: 'error', message: `Unhandled rejection: ${described.message}`, ...(described.detail !== undefined && { detail: described.detail }) })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

/**
 * Reports an error React caught in a boundary. Those never reach the window's `error` event, so a view that
 * fails to render would otherwise show its fallback text with nothing in the Problems list to say why.
 */
export function reportCaught(message: string, error: unknown, componentStack?: string | null) {
  const bridge = (globalThis as { window?: { api?: Pick<TesseraBridge, 'invoke'> } }).window?.api
  if (bridge === undefined) return
  const described = describe(error)
  const detail = [described.detail, componentStack ?? undefined].filter(Boolean).join('\n') || undefined
  const report: ProblemReport = {
    level: 'error',
    message: `${message}: ${described.message}`.slice(0, REPORT_LIMIT),
    ...(detail !== undefined && { detail: detail.slice(0, REPORT_LIMIT) })
  }
  deliver(bridge, report)
}

/** A report that cannot be delivered has nowhere else to go (the console already has it), so failure is ignored. */
function deliver(bridge: Pick<TesseraBridge, 'invoke'>, report: ProblemReport) {
  Promise.resolve().then(() => bridge.invoke(PROBLEMS_REPORT, report)).catch(() => undefined)
}
