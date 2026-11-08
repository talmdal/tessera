// The ledger plugin: the file that holds a user's finances and its sub-ledgers. Domain-free: it never mentions
// accounts; domain plugins declare their collections through `ledger.schema` and use `ledger.session`.
// See docs/account-manager-design.md, "The ledger".
import type { PluginContext, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_PLUGIN_ID, LEDGER_SESSION_SERVICE, LEDGER_VIEWS, type LedgerSession } from '@tessera/ledger-api'
import { registerCommands, revealer } from './commands'
import { contributions } from './contributions'
import { nodeDisk, type LedgerDisk } from './disk'
import { LedgerPublisher, registerIpc } from './ipc'
import { LedgerSessionImpl, describeError, ledgerName } from './LedgerSessionImpl'
import { RecentLedgers } from './RecentLedgers'
import { SchemaRegistry } from './SchemaRegistry'
import { LEDGER_SETTINGS, settingsContribution } from './settings'

let active: LedgerSessionImpl | undefined

/** Exactly the `LedgerSession` contract, so other plugins can't reach the implementation's internals. */
export function publicSession(session: LedgerSessionImpl): LedgerSession {
  return {
    get current() { return session.current },
    database: contributor => session.database(contributor),
    create: (file, options) => session.create(file, options),
    open: file => session.open(file),
    close: () => session.close(),
    delete: file => session.delete(file),
    tree: () => session.tree(),
    createSubLedger: input => session.createSubLedger(input),
    renameSubLedger: (id, name, options) => session.renameSubLedger(id, name, options),
    moveSubLedger: (id, to, index) => session.moveSubLedger(id, to, index),
    deleteSubLedger: id => session.deleteSubLedger(id),
    participate: (contributor, participant) => session.participate(contributor, participant),
    registerNavigator: contributor => session.registerNavigator(contributor),
    onWillClose: listener => session.onWillClose(listener),
    onDidChange: session.onDidChange,
    onDidChangeTree: session.onDidChangeTree
  }
}

export async function activate(context: PluginContext, options: { disk?: LedgerDisk } = {}) {
  const engine = context.services.get<StorageEngine>('storage.engine')
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const disk = options.disk ?? nodeDisk()

  const settings = context.settings.register(LEDGER_SETTINGS)
  // What the ledger remembers (recent ledgers, the last one open) is its state; how many to list is a setting
  const recent = new RecentLedgers(context.state, undefined, () => settings.get().recentLimit)
  const schema = new SchemaRegistry(context.extensions, context.services, context.logger)
  const session = new LedgerSessionImpl({ engine, files, prompts, recent, schema, disk, log: context.logger })
  const publisher = new LedgerPublisher(context, session, recent, disk)
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
    ...[...contributions(), settingsContribution()].map(([point, id, impl]) => context.extensions.contribute(LEDGER_PLUGIN_ID, point, id, impl)),
    // A new limit shows on the start view at once
    settings.onDidChange(({ changed }) => { if (changed.includes('recentLimit')) void publisher.publishRecent() }),
    ...registerCommands(context, session, prompts),
    ...registerIpc(context, session, publisher, recent),
    context.services.provide(LEDGER_PLUGIN_ID, LEDGER_SESSION_SERVICE, publicSession(session)),
    // On quit the ledger closes but is remembered, so it reopens at the next start
    context.lifecycle.onShuttingDown(() => session.shutdown())
  )

  // Reopen the last ledger once every plugin has activated: the schema contributors and their migrators are there.
  // The user may prefer to start at the start view.
  context.lifecycle.onStarted(async () => {
    const last = settings.get().reopenLast ? await recent.last().catch(() => undefined) : undefined
    if (last !== undefined) {
      try {
        await session.open(last)
      } catch (err) {
        context.logger.warn(`[ledger] Could not reopen ${last}: ${describeError(err)}`)
        publisher.setError(`“${ledgerName(last)}” could not be reopened. ${describeError(err)}`)
      }
    }
    if (!session.current) await revealer(context)(LEDGER_VIEWS.start)
  })

  publisher.publishState()
}

/** Runs after every plugin that requires `ledger.session` has deactivated. */
export async function deactivate() {
  const session = active
  active = undefined
  await session?.shutdown()
}
