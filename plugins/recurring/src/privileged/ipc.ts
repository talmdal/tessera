// The recurring views talk to the plugin here, and the plugin pushes the snapshot back. The context keys the
// warnings hang on are set from the same snapshot, so what the bar, the navigator's badge and the view show can
// never disagree.
import type { ContextKeyService, Disposable, IpcMessage, PluginContext } from '@tessera/types'
import type { BookSession } from '@tessera/book-api'
import {
  RECURRING_CHANNELS, RECURRING_CONTEXT_KEYS as K, RECURRING_EVENTS, RECURRING_PLUGIN_ID,
  RecurringError, isRecurringError, toRecurringResult,
  type EnterRequest, type ForecastEntry, type Holiday, type Posting, type RecurringSnapshot, type SaveFromTransactionRequest,
  type SaveSeriesRequest, type SeriesInput
} from '@tessera/recurring-api'
import type { RecurringServiceImpl } from './RecurringServiceImpl'
import { overdueSummary } from './snapshot'

/** The channel name a view listens on: the plugin's events are emitted unprefixed. */
export const local = (event: string) => event.slice(`${RECURRING_PLUGIN_ID}:`.length)

/** What `work` reads, or `none` when no book is open, including one that closed while it was reading. */
async function unlessClosed<T, N>(session: BookSession, work: () => Promise<T>, none: N): Promise<T | N> {
  if (!session.current) return none
  try {
    return await work()
  } catch (err) {
    if (isRecurringError(err) && err.code === 'NO_BOOK') return none
    throw err
  }
}

/** The snapshot the view shows, or null when no book is open. */
export function snapshotOrNull(service: RecurringServiceImpl, session: BookSession, options: { includePaused?: boolean, includeEnded?: boolean } = {}): Promise<RecurringSnapshot | null> {
  return unlessClosed(session, () => service.snapshot(options), null)
}

/**
 * Publishes the snapshot to the views and sets the context keys the warnings read. Called after every change, and
 * when the date rolls over, so "overdue" is never stale.
 */
export async function publishSnapshot(
  context: Pick<PluginContext, 'events' | 'logger'> & { contextKeys: Pick<ContextKeyService, 'set'> },
  service: RecurringServiceImpl,
  session: BookSession
): Promise<void> {
  try {
    const snapshot = await snapshotOrNull(service, session)
    context.events.emit(local(RECURRING_EVENTS.snapshot), snapshot)

    const summary = snapshot?.summary
    const overdue = summary?.overdueCount ?? 0
    const due = overdue + (summary?.dueSoonCount ?? 0)
    // Unset rather than zero: a bare key in a `when` expression is false when it is missing or falsy
    context.contextKeys.set(K.overdueCount, overdue > 0 ? overdue : undefined)
    context.contextKeys.set(K.overdueSummary, overdue > 0 ? overdueSummary(overdue) : undefined)
    context.contextKeys.set(K.dueCount, due > 0 ? due : undefined)
    context.contextKeys.set(K.hasSeries, (snapshot?.rows.length ?? 0) > 0 || undefined)
  } catch (err) {
    context.logger.error('[recurring] Could not publish the snapshot', err)
  }
}

const requestsOf = (data: { requests?: unknown } | undefined): EnterRequest[] => {
  if (!Array.isArray(data?.requests) || data.requests.length === 0) {
    throw new RecurringError('INVALID', 'Choose what to enter.', 'requests')
  }
  return data.requests as EnterRequest[]
}

const idsOf = (data: { ids?: unknown } | undefined): string[] => {
  if (!Array.isArray(data?.ids) || data.ids.some(id => typeof id !== 'string')) {
    throw new RecurringError('INVALID', 'Choose the recurring transactions.', 'ids')
  }
  return data.ids as string[]
}

export function registerIpc(context: PluginContext, service: RecurringServiceImpl, session: BookSession): Disposable[] {
  return [
    context.ipc.register(RECURRING_CHANNELS.snapshot, (msg: IpcMessage<{ includePaused?: boolean, includeEnded?: boolean }>) =>
      snapshotOrNull(service, session, {
        includePaused: msg.data?.includePaused === true,
        includeEnded: msg.data?.includeEnded === true
      })),

    context.ipc.register(RECURRING_CHANNELS.saveSeries, async (msg: IpcMessage<SaveSeriesRequest>) => {
      const { id, input, expectedRev } = msg.data ?? {} as Partial<SaveSeriesRequest>
      return toRecurringResult(() => {
        if (typeof input !== 'object' || input === null) throw new RecurringError('INVALID', 'Enter its details.', 'name')
        if (typeof id !== 'string') return service.create(input as SeriesInput)
        // The whole form: an optional field it leaves out was emptied, so it is cleared
        return service.update(id, { ...input, notes: input.notes ?? null }, {
          ...(typeof expectedRev === 'number' && { expectedRev })
        })
      })
    }),

    context.ipc.register(RECURRING_CHANNELS.createFromTransaction, async (msg: IpcMessage<SaveFromTransactionRequest>) => {
      const { input, source } = msg.data ?? {} as Partial<SaveFromTransactionRequest>
      return toRecurringResult(() => {
        if (typeof input !== 'object' || input === null) throw new RecurringError('INVALID', 'Enter its details.', 'name')
        if (typeof source?.accountId !== 'string' || typeof source.transactionId !== 'string') {
          throw new RecurringError('NOT_FOUND', 'That transaction no longer exists.')
        }
        return service.createFromTransaction(input, source)
      })
    }),

    context.ipc.register(RECURRING_CHANNELS.deleteSeries, async (msg: IpcMessage<{ ids?: string[] }>) =>
      toRecurringResult(() => service.delete(idsOf(msg.data)))),

    context.ipc.register(RECURRING_CHANNELS.setPaused, async (msg: IpcMessage<{ ids?: string[], paused?: boolean }>) =>
      toRecurringResult(() => service.setPaused(idsOf(msg.data), msg.data?.paused === true))),

    context.ipc.register(RECURRING_CHANNELS.enter, async (msg: IpcMessage<{ requests?: EnterRequest[], confirm?: unknown }>) =>
      toRecurringResult(() => service.enter(requestsOf(msg.data), {
        ...(Array.isArray(msg.data?.confirm) && { confirm: msg.data.confirm })
      }))),

    context.ipc.register(RECURRING_CHANNELS.skip, async (msg: IpcMessage<{ ids?: string[], count?: number }>) =>
      toRecurringResult(() => service.skip(idsOf(msg.data), {
        ...(typeof msg.data?.count === 'number' && { count: msg.data.count })
      }))),

    context.ipc.register(RECURRING_CHANNELS.forecast, async (msg: IpcMessage<{ from?: string, to?: string }>): Promise<ForecastEntry[]> => {
      const { from, to } = msg.data ?? {}
      if (typeof from !== 'string' || typeof to !== 'string') return []
      return unlessClosed(session, () => service.forecast({ from, to }), [])
    }),

    context.ipc.register(RECURRING_CHANNELS.holidays, async (): Promise<Holiday[]> =>
      unlessClosed(session, () => service.holidays(), [])),

    context.ipc.register(RECURRING_CHANNELS.addHoliday, async (msg: IpcMessage<{ date?: string, name?: string }>) =>
      toRecurringResult(() => service.addHoliday({ date: String(msg.data?.date ?? ''), name: String(msg.data?.name ?? '') }))),

    context.ipc.register(RECURRING_CHANNELS.removeHoliday, async (msg: IpcMessage<{ id?: string }>) =>
      toRecurringResult(() => service.removeHoliday(String(msg.data?.id ?? '')))),

    context.ipc.register(RECURRING_CHANNELS.history, async (msg: IpcMessage<{ seriesId?: string, limit?: number }>): Promise<Posting[]> => {
      const seriesId = msg.data?.seriesId
      if (typeof seriesId !== 'string') return []
      return unlessClosed(session, () => service.history(seriesId, msg.data?.limit), [])
    })
  ]
}
