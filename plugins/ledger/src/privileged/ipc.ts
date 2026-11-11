// The ledger's views talk to it here: requests, and the state they follow through push events.
import type { Disposable, IpcMessage, PluginContext } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_CONTEXT_KEYS, LEDGER_EVENTS, LEDGER_PLUGIN_ID, displayDate, toResult,
  type LedgerState, type LedgerTree, type RecentLedger
} from '@tessera/ledger-api'
import type { LedgerDisk } from './disk'
import type { LedgerSessionImpl } from './LedgerSessionImpl'
import type { RecentLedgers } from './RecentLedgers'

/** `events.emit` adds the plugin's prefix itself: 'ledger:state.changed' is emitted as 'state.changed'. */
const local = (event: string) => event.slice(`${LEDGER_PLUGIN_ID}:`.length)

const text = (value: unknown, what: string) => {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is required`)
  return value
}

/**
 * Mirrors the session into context keys (for menus and `when`) and push events (for views). Events carry the
 * whole new value, so a view that applies one twice is still right.
 */
export class LedgerPublisher {
  private error: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events' | 'logger'>,
    private readonly session: LedgerSessionImpl,
    private readonly recent: RecentLedgers,
    private readonly disk: LedgerDisk
  ) {}

  state(): LedgerState {
    const ledger = this.session.current
    return { isOpen: ledger !== undefined, ...(ledger && { ledger }), ...(this.error !== undefined && { error: this.error }) }
  }

  /** A failure to show on the start view (reopening at start-up), or undefined to clear it. */
  setError(error: string | undefined) {
    this.error = error
    this.publishState()
  }

  publishState() {
    const { ledger } = this.state()
    const keys = this.context.contextKeys
    keys.set(LEDGER_CONTEXT_KEYS.isOpen, ledger !== undefined)
    keys.set(LEDGER_CONTEXT_KEYS.isReadOnly, ledger?.readOnly ?? false)
    keys.set(LEDGER_CONTEXT_KEYS.name, ledger?.name)
    keys.set(LEDGER_CONTEXT_KEYS.hasNavigator, this.session.hasNavigator)
    keys.set(LEDGER_CONTEXT_KEYS.isBusy, this.session.operation !== undefined)
    keys.set(LEDGER_CONTEXT_KEYS.operation, this.session.operation)
    // An archive file open for viewing: what it is, for the status bar; and a key for enablement
    keys.set(LEDGER_CONTEXT_KEYS.isArchive, ledger?.archive !== undefined)
    keys.set(LEDGER_CONTEXT_KEYS.archive, ledger?.archive && `Archive of “${ledger.archive.ledgerName}”, before ${displayDate(ledger.archive.before)} · read-only`)
    this.context.events.emit(local(LEDGER_EVENTS.state), this.state())
  }

  publishTree(tree: LedgerTree | null) {
    this.context.events.emit(local(LEDGER_EVENTS.tree), tree)
  }

  async recentLedgers(): Promise<RecentLedger[]> {
    return Promise.all((await this.recent.list()).map(async entry => ({ ...entry, exists: await this.disk.exists(entry.path) })))
  }

  async publishRecent() {
    try {
      this.context.events.emit(local(LEDGER_EVENTS.recent), await this.recentLedgers())
    } catch (err) {
      this.context.logger.warn(`[ledger] Could not read the recent ledgers: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function registerIpc(context: PluginContext, session: LedgerSessionImpl, publisher: LedgerPublisher, recent: RecentLedgers): Disposable[] {
  return [
    context.ipc.register(LEDGER_CHANNELS.state, () => publisher.state()),

    context.ipc.register(LEDGER_CHANNELS.recent, () => publisher.recentLedgers()),

    context.ipc.register(LEDGER_CHANNELS.recentRemove, async (msg: IpcMessage<{ path?: unknown }>) => {
      await recent.remove(text(msg.data?.path, 'A path'))
      await publisher.publishRecent()
    }),

    context.ipc.register(LEDGER_CHANNELS.open, async (msg: IpcMessage<{ path?: unknown }>) => {
      const file = text(msg.data?.path, 'A path')
      return toResult(() => session.open(file))
    }),

    context.ipc.register(LEDGER_CHANNELS.delete, async (msg: IpcMessage<{ path?: unknown }>) => {
      const deleted = await session.delete(text(msg.data?.path, 'A path'))
      await publisher.publishRecent()
      return deleted
    }),

    context.ipc.register(LEDGER_CHANNELS.tree, async () => session.current ? session.tree() : null),

    context.ipc.register(LEDGER_CHANNELS.createSubLedger, async (msg: IpcMessage<{ name?: unknown, parentId?: unknown }>) => {
      const { name, parentId } = msg.data ?? {}
      return toResult(() => session.createSubLedger({
        name: typeof name === 'string' ? name : '',
        parentId: typeof parentId === 'string' ? parentId : null
      }))
    }),

    context.ipc.register(LEDGER_CHANNELS.renameSubLedger, async (msg: IpcMessage<{ id?: unknown, name?: unknown, expectedRev?: unknown }>) => {
      const { id, name, expectedRev } = msg.data ?? {}
      return toResult(() => session.renameSubLedger(text(id, 'An id'), typeof name === 'string' ? name : '',
        typeof expectedRev === 'number' ? { expectedRev } : {}))
    })
  ]
}
