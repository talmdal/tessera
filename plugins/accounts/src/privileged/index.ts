// The accounts plugin: the accounts of the open ledger. It stores them through `ledger.schema`, offers them to other
// plugins as `accounts.service`, and shows them in the Accounts navigator, which replaces the ledger's own panel.
// See docs/account-manager-design.md, "The chart of accounts".
import type { PluginContext, ShellPrompts } from '@tessera/types'
import { SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_SCHEMA_POINT, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import {
  ACCOUNTS_EVENTS, ACCOUNTS_MIGRATOR_SERVICE, ACCOUNTS_PLUGIN_ID, ACCOUNTS_SERVICE, ACCOUNTS_VIEWS, REGISTER_ANNOTATIONS_POINT,
  type AccountsService
} from '@tessera/accounts-api'
import { RegisterAnnotationsReader } from './annotations'
import { AccountsServiceImpl } from './AccountsServiceImpl'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { publishChange, registerIpc } from './ipc'
import { ReconcileActions } from './reconcileActions'
import { RegisterState } from './register'
import { ACCOUNTS_SCHEMA, accountsMigrator } from './schema'
import { local, SelectionState } from './selection'

/** Exactly the `AccountsService` contract, so other plugins can't reach the implementation's internals. */
export function publicService(service: AccountsServiceImpl): AccountsService {
  return {
    get: id => service.get(id),
    list: filter => service.list(filter),
    chart: options => service.chart(options),
    balances: id => service.balances(id),
    createAccount: input => service.createAccount(input),
    updateAccount: (id, patch, options) => service.updateAccount(id, patch, options),
    closeAccount: (id, options) => service.closeAccount(id, options),
    reopenAccount: (id, options) => service.reopenAccount(id, options),
    deleteAccount: (id, options) => service.deleteAccount(id, options),
    moveAccount: (id, to, index) => service.moveAccount(id, to, index),
    transactions: accountId => service.transactions(accountId),
    payees: service.payees,
    categories: service.categories,
    reconciliation: service.reconciliation,
    onDidChange: service.onDidChange
  }
}

export interface ActivateOptions {
  /** How long an annotator may take (tests shorten it). Default ANNOTATE_TIMEOUT_MS. */
  annotationTimeoutMs?: number
}

export async function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const service = new AccountsServiceImpl({ session, log: context.logger })
  const selection = new SelectionState(context, service, session)
  const register = new RegisterState(context, service, session)
  const actions = new ReconcileActions(context.extensions, context.commands, context.logger)
  // Other plugins' marks on register rows; when an annotator says they changed, the registers concerned reload
  const annotations = new RegisterAnnotationsReader(context.extensions, context.services, context.logger,
    accounts => context.events.emit(local(ACCOUNTS_EVENTS.annotations), { accounts }), options.annotationTimeoutMs)

  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    { dispose: () => annotations.dispose() },
    context.extensions.onDidChange(({ point }) => { if (point === REGISTER_ANNOTATIONS_POINT) annotations.sync() }),
    // Declared before any ledger opens (the ledger reopens the last one once every plugin has activated)
    context.extensions.contribute(ACCOUNTS_PLUGIN_ID, LEDGER_SCHEMA_POINT, ACCOUNTS_PLUGIN_ID, ACCOUNTS_SCHEMA),
    context.services.provide(ACCOUNTS_PLUGIN_ID, ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator),
    context.services.provide(ACCOUNTS_PLUGIN_ID, ACCOUNTS_SERVICE, publicService(service)),
    session.participate(ACCOUNTS_PLUGIN_ID, service.participant),
    // The navigator shows the ledger tree with accounts in it, so the ledger's own panel steps aside
    session.registerNavigator(ACCOUNTS_PLUGIN_ID),
    service.onDidChange(async change => {
      await selection.refresh()
      await register.refresh()
      await publishChange(context, service, session, change)
    }),
    session.onDidChange(change => {
      if (change.type === 'opened' && change.created) void reveal(ACCOUNTS_VIEWS.navigator)
    }),
    ...contributions().map(([point, id, impl]) => context.extensions.contribute(ACCOUNTS_PLUGIN_ID, point, id, impl)),
    ...registerCommands(context, service, selection, register, prompts),
    ...registerIpc(context, service, session, selection, register, actions, annotations)
  )
  // Annotators whose plugins activated after this one are followed from start-up (and whenever a register loads)
  context.lifecycle.onStarted(() => annotations.sync())

  await selection.refresh()
  await register.refresh()
}
