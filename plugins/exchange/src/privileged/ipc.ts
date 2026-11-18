// The exchange views talk to the pipeline here. Everything the user can cause comes back as an `ExchangeResult`,
// never a rejected promise, so a view renders a message rather than hitting an error boundary.
//
// The register's provisional rows come through `pending.rows`, the channel the plugin names in its
// `accounts.register.overlays` contribution — the register invokes it itself, with `{ accountId }`.
import type { ContextKeyService, Disposable, IpcMessage, PluginContext } from '@tessera/types'
import type { BookSession } from '@tessera/book-api'
import type { OverlayRow } from '@tessera/accounts-api'
import {
  EXCHANGE_CHANNELS, EXCHANGE_CONTEXT_KEYS as K, EXCHANGE_PLUGIN_ID,
  ExchangeError, isExchangeError, toExchangeResult,
  type AccountLink, type ExchangeFormatDescriptor, type HistoryFilter,
  type ImportBatch, type PayeeRule, type PendingSummary, type RenamePreviewRequest, type UndoRequest
} from '@tessera/exchange-api'
import type { ExchangeServiceImpl } from './ExchangeServiceImpl'
import type { FormatRegistry } from './formats'

/** The channel name a view listens on: the plugin's events are emitted unprefixed. */
export const local = (event: string) => event.slice(`${EXCHANGE_PLUGIN_ID}:`.length)

/** What `work` reads, or `none` when no book is open, including one that closed while it was reading. */
async function unlessClosed<T, N>(session: BookSession, work: () => Promise<T>, none: N): Promise<T | N> {
  if (!session.current) return none
  try {
    return await work()
  } catch (err) {
    if (isExchangeError(err) && err.code === 'NO_BOOK') return none
    throw err
  }
}

/**
 * Publishes what the menus and badges hang on. `formats.count` is unset rather than zero when nothing is
 * installed, because a bare key in a `when` expression is false when it is missing or falsy — so File ▸ Import
 * greys out on its own. `pending.count` is the navigator badge: unset when nothing is waiting.
 */
export async function publishKeys(
  context: { contextKeys: Pick<ContextKeyService, 'set'>, logger: Pick<PluginContext['logger'], 'error'> },
  service: ExchangeServiceImpl,
  formats: FormatRegistry,
  session: BookSession
): Promise<void> {
  try {
    const count = formats.readable().length
    context.contextKeys.set(K.formatCount, count > 0 ? count : undefined)
    const writable = formats.writable().length
    context.contextKeys.set(K.writableFormatCount, writable > 0 ? writable : undefined)
    const recent = await unlessClosed(session, () => service.history({ limit: 1 }), [] as ImportBatch[])
    context.contextKeys.set(K.canUndo, recent.length > 0 ? true : undefined)
    const pending = await unlessClosed(session, () => service.pendingCount(), 0)
    context.contextKeys.set(K.pendingCount, pending > 0 ? pending : undefined)
  } catch (err) {
    context.logger.error('[exchange] Could not publish the context keys', err)
  }
}

const requireText = (value: unknown, field: string, what: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new ExchangeError('INVALID', what, field)
  return value
}

export function registerIpc(context: PluginContext, service: ExchangeServiceImpl, formats: FormatRegistry, session: BookSession): Disposable[] {
  return [
    context.ipc.register(EXCHANGE_CHANNELS.formats, async (): Promise<ExchangeFormatDescriptor[]> =>
      formats.all()),

    context.ipc.register(EXCHANGE_CHANNELS.pendingSummary, async (): Promise<PendingSummary[]> =>
      unlessClosed(session, () => service.pendingSummary(), [])),

    context.ipc.register(EXCHANGE_CHANNELS.pendingRows, async (msg: IpcMessage<{ accountId?: string }>): Promise<OverlayRow[]> => {
      const accountId = msg.data?.accountId
      if (typeof accountId !== 'string') return []
      return unlessClosed(session, () => service.overlayRows(accountId), [])
    }),

    context.ipc.register(EXCHANGE_CHANNELS.renamePreview, async (msg: IpcMessage<RenamePreviewRequest>) =>
      toExchangeResult(async () => {
        const accountId = requireText(msg.data?.accountId, 'accountId', 'Which account?')
        const statementId = requireText(msg.data?.statementId, 'statementId', 'Which statement?')
        const rowKey = requireText(msg.data?.rowKey, 'rowKey', 'Which line?')
        const payee = msg.data?.payee
        return service.previewRename(accountId, statementId, rowKey, typeof payee === 'string' ? payee : null)
      })),

    context.ipc.register(EXCHANGE_CHANNELS.undo, async (msg: IpcMessage<UndoRequest>) =>
      toExchangeResult(async () => {
        const batchId = requireText(msg.data?.batchId, 'batchId', 'Choose the import to undo.')
        const result = await service.undo(batchId, {
          ...(Array.isArray(msg.data?.confirm) && { confirm: msg.data.confirm })
        })
        await publishKeys(context, service, formats, session)
        return result
      })),

    context.ipc.register(EXCHANGE_CHANNELS.history, async (msg: IpcMessage<HistoryFilter>): Promise<ImportBatch[]> =>
      unlessClosed(session, () => service.history(msg.data ?? {}), [])),

    context.ipc.register(EXCHANGE_CHANNELS.links, async (): Promise<AccountLink[]> =>
      unlessClosed(session, () => service.links(), [])),

    context.ipc.register(EXCHANGE_CHANNELS.removeLink, async (msg: IpcMessage<{ id?: string }>) =>
      toExchangeResult(() => service.removeLink(requireText(msg.data?.id, 'id', 'Choose the account to forget.')))),

    context.ipc.register(EXCHANGE_CHANNELS.rules, async (): Promise<PayeeRule[]> =>
      unlessClosed(session, () => service.payeeRules.list(), [])),

    context.ipc.register(EXCHANGE_CHANNELS.saveRules, async (msg: IpcMessage<{ rules?: PayeeRule[] }>) =>
      toExchangeResult(() => {
        const rules = msg.data?.rules
        if (!Array.isArray(rules)) throw new ExchangeError('INVALID', 'There are no rules to save.', 'rules')
        return service.payeeRules.replace(rules)
      }))
  ]
}
