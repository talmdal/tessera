// The book plugin: the file that holds a user's finances and its sub-books. Domain-free: it never mentions
// accounts; domain plugins declare their collections through `book.schema` and use `book.session`.
// See docs/account-manager-design.md, "The book".
import type { AppState, PluginContext, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_PLUGIN_ID, BOOK_SESSION_SERVICE, BOOK_VIEWS, type BookSession } from '@tessera/book-api'
import { registerCommands, revealer } from './commands'
import { contributions } from './contributions'
import { nodeDisk, type BookDisk } from './disk'
import { BookPublisher, registerIpc } from './ipc'
import { BookSessionImpl, describeError, bookName } from './BookSessionImpl'
import { RecentBooks } from './RecentBooks'
import { SchemaRegistry } from './SchemaRegistry'

let active: BookSessionImpl | undefined

/** Exactly the `BookSession` contract, so other plugins can't reach the implementation's internals. */
export function publicSession(session: BookSessionImpl): BookSession {
  return {
    get current() { return session.current },
    database: contributor => session.database(contributor),
    create: (file, options) => session.create(file, options),
    open: file => session.open(file),
    close: () => session.close(),
    delete: file => session.delete(file),
    tree: () => session.tree(),
    createSubBook: input => session.createSubBook(input),
    renameSubBook: (id, name, options) => session.renameSubBook(id, name, options),
    moveSubBook: (id, to, index) => session.moveSubBook(id, to, index),
    deleteSubBook: id => session.deleteSubBook(id),
    participate: (contributor, participant) => session.participate(contributor, participant),
    registerNavigator: contributor => session.registerNavigator(contributor),
    onWillClose: listener => session.onWillClose(listener),
    onDidChange: session.onDidChange,
    onDidChangeTree: session.onDidChangeTree
  }
}

export async function activate(context: PluginContext, options: { disk?: BookDisk } = {}) {
  const engine = context.services.get<StorageEngine>('storage.engine')
  const appState = context.services.get<AppState>('app.state')
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const disk = options.disk ?? nodeDisk()

  const recent = new RecentBooks(appState)
  const schema = new SchemaRegistry(context.extensions, context.services, context.logger)
  const session = new BookSessionImpl({ engine, files, prompts, recent, schema, disk, log: context.logger })
  const publisher = new BookPublisher(context, session, recent, disk)
  active = session

  context.subscriptions.push(
    session.onDidChange(change => {
      if (change.type === 'opened') publisher.setError(undefined)
      else {
        publisher.publishState()
        publisher.publishTree(null)
      }
      void publisher.publishRecent()
    }),
    session.onDidChangeTree(tree => publisher.publishTree(tree)),
    session.onDidChangeNavigator(() => publisher.publishState()),
    ...contributions().map(([point, id, impl]) => context.extensions.contribute(BOOK_PLUGIN_ID, point, id, impl)),
    ...registerCommands(context, session, prompts),
    ...registerIpc(context, session, publisher, recent),
    context.services.provide(BOOK_PLUGIN_ID, BOOK_SESSION_SERVICE, publicSession(session)),
    // On quit the book closes but is remembered, so it reopens at the next start
    context.lifecycle.onShuttingDown(() => session.shutdown())
  )

  // Reopen the last book once every plugin has activated: the schema contributors and their migrators are there
  context.lifecycle.onStarted(async () => {
    const last = await recent.last().catch(() => undefined)
    if (last !== undefined) {
      try {
        await session.open(last)
      } catch (err) {
        context.logger.warn(`[book] Could not reopen ${last}: ${describeError(err)}`)
        publisher.setError(`“${bookName(last)}” could not be reopened. ${describeError(err)}`)
      }
    }
    if (!session.current) await revealer(context)(BOOK_VIEWS.start)
  })

  publisher.publishState()
}

/** Runs after every plugin that requires `book.session` has deactivated. */
export async function deactivate() {
  const session = active
  active = undefined
  await session?.shutdown()
}
