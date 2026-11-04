// The book's views talk to it here: requests, and the state they follow through push events.
import type { Disposable, IpcMessage, PluginContext } from '@tessera/types'
import {
  BOOK_CHANNELS, BOOK_CONTEXT_KEYS, BOOK_EVENTS, BOOK_PLUGIN_ID, toResult,
  type BookState, type BookTree, type RecentBook
} from '@tessera/book-api'
import type { BookDisk } from './disk'
import type { BookSessionImpl } from './BookSessionImpl'
import type { RecentBooks } from './RecentBooks'

/** `events.emit` adds the plugin's prefix itself: 'book:state.changed' is emitted as 'state.changed'. */
const local = (event: string) => event.slice(`${BOOK_PLUGIN_ID}:`.length)

const text = (value: unknown, what: string) => {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is required`)
  return value
}

/**
 * Mirrors the session into context keys (for menus and `when`) and push events (for views). Events carry the
 * whole new value, so a view that applies one twice is still right.
 */
export class BookPublisher {
  private error: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events' | 'logger'>,
    private readonly session: BookSessionImpl,
    private readonly recent: RecentBooks,
    private readonly disk: BookDisk
  ) {}

  state(): BookState {
    const book = this.session.current
    return { isOpen: book !== undefined, ...(book && { book }), ...(this.error !== undefined && { error: this.error }) }
  }

  /** A failure to show on the start view (reopening at start-up), or undefined to clear it. */
  setError(error: string | undefined) {
    this.error = error
    this.publishState()
  }

  publishState() {
    const { book } = this.state()
    const keys = this.context.contextKeys
    keys.set(BOOK_CONTEXT_KEYS.isOpen, book !== undefined)
    keys.set(BOOK_CONTEXT_KEYS.isReadOnly, book?.readOnly ?? false)
    keys.set(BOOK_CONTEXT_KEYS.name, book?.name)
    keys.set(BOOK_CONTEXT_KEYS.hasNavigator, this.session.hasNavigator)
    this.context.events.emit(local(BOOK_EVENTS.state), this.state())
  }

  publishTree(tree: BookTree | null) {
    this.context.events.emit(local(BOOK_EVENTS.tree), tree)
  }

  async recentBooks(): Promise<RecentBook[]> {
    return Promise.all((await this.recent.list()).map(async entry => ({ ...entry, exists: await this.disk.exists(entry.path) })))
  }

  async publishRecent() {
    try {
      this.context.events.emit(local(BOOK_EVENTS.recent), await this.recentBooks())
    } catch (err) {
      this.context.logger.warn(`[book] Could not read the recent books: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function registerIpc(context: PluginContext, session: BookSessionImpl, publisher: BookPublisher, recent: RecentBooks): Disposable[] {
  return [
    context.ipc.register(BOOK_CHANNELS.state, () => publisher.state()),

    context.ipc.register(BOOK_CHANNELS.recent, () => publisher.recentBooks()),

    context.ipc.register(BOOK_CHANNELS.recentRemove, async (msg: IpcMessage<{ path?: unknown }>) => {
      await recent.remove(text(msg.data?.path, 'A path'))
      await publisher.publishRecent()
    }),

    context.ipc.register(BOOK_CHANNELS.open, async (msg: IpcMessage<{ path?: unknown }>) => {
      const file = text(msg.data?.path, 'A path')
      return toResult(() => session.open(file))
    }),

    context.ipc.register(BOOK_CHANNELS.delete, async (msg: IpcMessage<{ path?: unknown }>) => {
      const deleted = await session.delete(text(msg.data?.path, 'A path'))
      await publisher.publishRecent()
      return deleted
    }),

    context.ipc.register(BOOK_CHANNELS.tree, async () => session.current ? session.tree() : null),

    context.ipc.register(BOOK_CHANNELS.createSubBook, async (msg: IpcMessage<{ name?: unknown, parentId?: unknown }>) => {
      const { name, parentId } = msg.data ?? {}
      return toResult(() => session.createSubBook({
        name: typeof name === 'string' ? name : '',
        parentId: typeof parentId === 'string' ? parentId : null
      }))
    }),

    context.ipc.register(BOOK_CHANNELS.renameSubBook, async (msg: IpcMessage<{ id?: unknown, name?: unknown, expectedRev?: unknown }>) => {
      const { id, name, expectedRev } = msg.data ?? {}
      return toResult(() => session.renameSubBook(text(id, 'An id'), typeof name === 'string' ? name : '',
        typeof expectedRev === 'number' ? { expectedRev } : {}))
    })
  ]
}
