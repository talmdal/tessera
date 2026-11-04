// The accounts plugin: the accounts of the open book. It stores them through `book.schema`, offers them to other
// plugins as `accounts.service`, and shows them in the Accounts navigator, which replaces the book's own panel.
// See docs/account-manager-design.md, "The chart of accounts".
import type { PluginContext, ShellPrompts } from '@tessera/types'
import { SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_SCHEMA_POINT, BOOK_SESSION_SERVICE, type BookSession } from '@tessera/book-api'
import {
  ACCOUNTS_MIGRATOR_SERVICE, ACCOUNTS_PLUGIN_ID, ACCOUNTS_SERVICE, ACCOUNTS_VIEWS, type AccountsService
} from '@tessera/accounts-api'
import { AccountsServiceImpl } from './AccountsServiceImpl'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { publishChange, registerIpc } from './ipc'
import { ReconcileActions } from './reconcileActions'
import { RegisterState } from './register'
import { ACCOUNTS_SCHEMA, accountsMigrator } from './schema'
import { SelectionState } from './selection'

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

export async function activate(context: PluginContext) {
  const session = context.services.get<BookSession>(BOOK_SESSION_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const service = new AccountsServiceImpl({ session, log: context.logger })
  const selection = new SelectionState(context, service, session)
  const register = new RegisterState(context, service, session)
  const actions = new ReconcileActions(context.extensions, context.commands, context.logger)

  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    // Declared before any book opens (the book reopens the last one once every plugin has activated)
    context.extensions.contribute(ACCOUNTS_PLUGIN_ID, BOOK_SCHEMA_POINT, ACCOUNTS_PLUGIN_ID, ACCOUNTS_SCHEMA),
    context.services.provide(ACCOUNTS_PLUGIN_ID, ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator),
    context.services.provide(ACCOUNTS_PLUGIN_ID, ACCOUNTS_SERVICE, publicService(service)),
    session.participate(ACCOUNTS_PLUGIN_ID, service.participant),
    // The navigator shows the book tree with accounts in it, so the book's own panel steps aside
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
    ...registerIpc(context, service, session, selection, register, actions)
  )

  await selection.refresh()
  await register.refresh()
}
