// The budget plugin: budgets over the ledger or a sub-ledger, their lines and plans, and how each month stands against
// what the transactions show. It keeps its data in the ledger (ledger.schema), reads the accounts only through
// accounts.service, takes part in deleting sub-ledgers and in archives, and provides `budget.service`. It shows a
// budget in the main area, lists the ledger's budgets in the Budgets tab, and adds the Budget menu and its dialogs, the
// Budget page of the Options dialog, and a warning in the status bar while lines are over budget this month. And it
// adds Budget vs Actual to the reports, on a source of its own over its status, through the reports plugin's points:
// without that plugin, nothing of it is used (docs/reporting-design.md, "7. Budget vs Actual").
// See docs/budget-design.md.
import type { PluginContext, ShellPrompts } from '@tessera/types'
import { SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_SCHEMA_POINT, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { BUDGET_MIGRATOR_SERVICE, BUDGET_PLUGIN_ID, BUDGET_REPORTS, BUDGET_SERVICE, type BudgetService } from '@tessera/budget-api'
import { REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT, REPORTS_COMMANDS } from '@tessera/reports-api'
import { BudgetServiceImpl } from './BudgetServiceImpl'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { registerIpc } from './ipc'
import { Refresher } from './refresh'
import { BUDGET_VS_ACTUAL, BUDGETS_GROUP } from './report'
import { BudgetReportSource, STATUS_SOURCE } from './reportSource'
import { BUDGET_SCHEMA, budgetMigrator } from './schema'
import { BUDGET_SETTINGS, settingsContribution } from './settings'
import { MONTH_CHECK_MS, StatusBar } from './statusBar'
import { BudgetViewSupport } from './viewSupport'
import { ViewState } from './viewState'

/** The service other plugins get: exactly the contract, so nothing internal (the participants) leaks through. */
export function publicService(service: BudgetServiceImpl): BudgetService {
  return {
    list: () => service.list(),
    get: id => service.get(id),
    create: input => service.create(input),
    update: (id, patch, options) => service.update(id, patch, options),
    duplicate: (id, name) => service.duplicate(id, name),
    delete: id => service.delete(id),
    lines: budgetId => service.lines(budgetId),
    addLine: (budgetId, input) => service.addLine(budgetId, input),
    changeLine: (lineId, change, options) => service.changeLine(lineId, change, options),
    setLineNotes: (lineId, notes, options) => service.setLineNotes(lineId, notes, options),
    deleteLine: lineId => service.deleteLine(lineId),
    fill: (budgetId, lines) => service.fill(budgetId, lines),
    status: (budgetId, months, options) => service.status(budgetId, months, options),
    suggest: (budgetId, options) => service.suggest(budgetId, options),
    onDidChange: service.onDidChange
  }
}

export interface ActivateOptions {
  /** Today, 'YYYY-MM-DD': the month the view opens on (tests fix it). */
  today?: () => string
  /** How long changes to actuals are gathered before the views are told (tests shorten it). */
  refreshDelayMs?: number
  /** How often the status bar's warning checks for a new month (tests shorten it). */
  monthCheckMs?: number
  /** For tests: called once activated, with what waits until every refresh has run (so tests need not guess how long). */
  onActivated?: (hooks: { idle(): Promise<void> }) => void
}

/** Runs `work` every `ms`, until disposed. */
function every(ms: number, work: () => void) {
  const timer = setInterval(work, ms)
  return { dispose: () => clearInterval(timer) }
}

export async function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  // The Budget page: read where it is used, so a change applies at once
  const settings = context.settings.register(BUDGET_SETTINGS)
  const service = new BudgetServiceImpl({ session, accounts, log: context.logger, warnAtPercent: () => settings.get().warnAtPercent })
  const view = new ViewState(context, service, session, options.today,
    () => ({ showBars: settings.get().showBars, showEmptyLines: settings.get().showEmptyLines }),
    () => context.commands.has(REPORTS_COMMANDS.show))
  const support = new BudgetViewSupport(service, accounts)
  const reportSource = new BudgetReportSource({ service, support, session, log: context.logger, shown: () => view.get().shown })
  const statusBar = new StatusBar(context, service, view, () => settings.get(), options.today)
  const refresher = new Refresher(context, view, options.refreshDelayMs, () => statusBar.refresh())
  view.onShown = () => refresher.shown()

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    refresher,
    // Declared before any ledger opens (the ledger reopens the last one once every plugin has activated)
    context.extensions.contribute(BUDGET_PLUGIN_ID, LEDGER_SCHEMA_POINT, BUDGET_PLUGIN_ID, BUDGET_SCHEMA),
    context.services.provide(BUDGET_PLUGIN_ID, BUDGET_MIGRATOR_SERVICE, budgetMigrator),
    context.services.provide(BUDGET_PLUGIN_ID, BUDGET_SERVICE, publicService(service)),
    // Deleting a sub-ledger moves a budget over it to the parent
    session.participate(BUDGET_PLUGIN_ID, service.subLedgerParticipant),
    // Archiving keeps the totals of what it removes, so past months' actuals don't change. Joined after `accounts`
    // (this plugin requires accounts.service, so activates after it), whose result it reads
    session.participateInArchive(BUDGET_PLUGIN_ID, service.archiver),
    // Another ledger: its own budgets, its remembered budget, this month. Nothing is written when a ledger opens
    session.onDidChange(() => refresher.ledgerChanged()),
    service.onDidChange(change => refresher.changed(change)),
    settings.onDidChange(({ changed }) => refresher.settingsChanged(changed)),
    // The app left open over the end of a month: the warning moves on to the new month
    every(options.monthCheckMs ?? MONTH_CHECK_MS, () => refresher.run(() => statusBar.checkMonth())),
    ...[...contributions(), settingsContribution()].map(([point, id, impl]) => context.extensions.contribute(BUDGET_PLUGIN_ID, point, id, impl)),
    // Budget vs Actual: the source over the status, the Budgets group and the report, through the reports plugin's points
    context.services.provide(BUDGET_PLUGIN_ID, BUDGET_REPORTS.service, reportSource),
    context.extensions.contribute(BUDGET_PLUGIN_ID, REPORT_SOURCES_POINT, STATUS_SOURCE.id, STATUS_SOURCE),
    context.extensions.contribute(BUDGET_PLUGIN_ID, REPORT_GROUPS_POINT, BUDGETS_GROUP.id, BUDGETS_GROUP),
    context.extensions.contribute(BUDGET_PLUGIN_ID, REPORT_DEFINITIONS_POINT, BUDGET_VS_ACTUAL.id, BUDGET_VS_ACTUAL),
    ...registerCommands(context, service, support, accounts, session, view, prompts, () => settings.get()),
    ...registerIpc(context, service, accounts, view, settings)
  )
  await view.refresh()
  await statusBar.refresh()
  options.onActivated?.({ idle: () => refresher.idle() })
}
