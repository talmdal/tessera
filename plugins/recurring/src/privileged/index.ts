// The recurring plugin: payments and deposits that repeat. It keeps its series in the open book through
// `book.schema`, and writes every transaction through `accounts.service`, so the account manager's rules are
// enforced in one place. See docs/recurring-transactions-design.md.
//
// Built so far: the schema, `recurring.service`, the snapshot behind the warnings, and the Recurring view with
// every way into it. Still to come: the view's list (phase 3), the dialogs (phase 4), "Make Recurring…" and the
// register's row action (phase 5).
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import { SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_SCHEMA_POINT, BOOK_SESSION_SERVICE, type BookSession } from '@tessera/book-api'
import { ACCOUNTS_SERVICE, todayIso, type AccountsService } from '@tessera/accounts-api'
import {
  RECURRING_MIGRATOR_SERVICE, RECURRING_PLUGIN_ID, RECURRING_SERVICE, RECURRING_VIEWS, type RecurringService
} from '@tessera/recurring-api'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { publishSnapshot, registerIpc, snapshotOrNull } from './ipc'
import { RecurringServiceImpl } from './RecurringServiceImpl'
import { RECURRING_SCHEMA, recurringMigrator } from './schema'

/** How often to notice that the date has changed. Overdue is a question about today, so it must not go stale. */
const ROLLOVER_CHECK_MS = 60_000

/** Exactly the `RecurringService` contract, so other plugins can't reach the implementation's internals. */
export function publicService(service: RecurringServiceImpl): RecurringService {
  return {
    get: id => service.get(id),
    list: filter => service.list(filter),
    snapshot: options => service.snapshot(options),
    forecast: (range, filter) => service.forecast(range, filter),
    create: input => service.create(input),
    templateFrom: (accountId, transactionId) => service.templateFrom(accountId, transactionId),
    createFromTransaction: (input, source) => service.createFromTransaction(input, source),
    update: (id, patch, options) => service.update(id, patch, options),
    delete: (ids, options) => service.delete(ids, options),
    setPaused: (ids, paused) => service.setPaused(ids, paused),
    enter: (requests, options) => service.enter(requests, options),
    skip: (ids, options) => service.skip(ids, options),
    history: (seriesId, limit) => service.history(seriesId, limit),
    holidays: () => service.holidays(),
    addHoliday: input => service.addHoliday(input),
    removeHoliday: id => service.removeHoliday(id),
    onDidChange: service.onDidChange
  }
}

/**
 * Re-publishes when the local date changes. Nothing is stored about "today", so a window left open overnight
 * simply starts showing yesterday's due transactions as overdue.
 */
export function watchDateRollover(today: () => string, onRollover: () => void, intervalMs = ROLLOVER_CHECK_MS): Disposable {
  let seen = today()
  const timer = setInterval(() => {
    const now = today()
    if (now !== seen) {
      seen = now
      onRollover()
    }
  }, intervalMs)
  timer.unref?.()
  return { dispose: () => clearInterval(timer) }
}

export async function activate(context: PluginContext) {
  const session = context.services.get<BookSession>(BOOK_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const service = new RecurringServiceImpl({ session, accounts, log: context.logger })

  const publish = () => publishSnapshot(context, service, session)

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    // Declared before any book opens; the collections are created when one does
    context.extensions.contribute(RECURRING_PLUGIN_ID, BOOK_SCHEMA_POINT, RECURRING_PLUGIN_ID, RECURRING_SCHEMA),
    context.services.provide(RECURRING_PLUGIN_ID, RECURRING_MIGRATOR_SERVICE, recurringMigrator),
    context.services.provide(RECURRING_PLUGIN_ID, RECURRING_SERVICE, publicService(service)),

    service.onDidChange(() => { void publish() }),
    // A book opening with something overdue shows the list — a reveal, not a dialog, so it can be ignored
    session.onDidChange(async bookChange => {
      if (bookChange.type !== 'opened' || bookChange.created) return
      const snapshot = await snapshotOrNull(service, session)
      if (snapshot && snapshot.summary.overdueCount > 0 && context.commands.has('shell.layout.reveal')) {
        await context.commands.execute('shell.layout.reveal', RECURRING_VIEWS.list).catch(() => undefined)
      }
    }),
    // Accounts are another plugin's, so this follows its changes rather than sharing a transaction with them
    accounts.onDidChange(async accountsChange => {
      await service.handleAccountsChange(accountsChange)
      await publish()
    }),
    watchDateRollover(todayIso, () => { void publish() }),

    ...contributions().map(([point, id, impl]) => context.extensions.contribute(RECURRING_PLUGIN_ID, point, id, impl)),
    ...registerIpc(context, service, session),
    ...registerCommands(context, service, prompts)
  )

  await publish()
}
