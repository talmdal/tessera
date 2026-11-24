// The reports plugin, the report manager: it knows no particular report. It provides the `reports.sources`,
// `reports.definitions` and `reports.groups` extension points and `reports.service`, which runs whatever is
// contributed to them; its own two sources (`reports.flows`, `reports.balances`, over accounts.service) and its seven
// definitions are contributed through those same points, with nothing private. Saved reports live in the ledger
// (ledger.schema), and move with a sub-ledger that is deleted. It shows a report in the main area, lists the reports
// offered and saved in the Reports tab, mirrors the reports offered into the Reports menu, and lists the transactions
// behind a figure in a dialog. It prints the report shown, saves it as PDF, and exports its table to CSV (R6).
// See docs/reporting-design.md.
import {
  SHELL_FILES_SERVICE, SHELL_PRINT_SERVICE, SHELL_PROMPTS_SERVICE, type PluginContext, type ShellFiles, type ShellPrint, type ShellPrompts
} from '@tessera/types'
import { LEDGER_SCHEMA_POINT, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, todayIso, type AccountsService } from '@tessera/accounts-api'
import {
  BALANCES_SOURCE, FLOWS_SOURCE, REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT, REPORTS_MIGRATOR_SERVICE,
  REPORTS_PLUGIN_ID, REPORTS_SERVICE, showCommandOf, type ReportsService
} from '@tessera/reports-api'
import { BALANCES_CONTRIBUTION } from './balances'
import { BalancesSource } from './BalancesSource'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { DEFINITIONS, GROUPS } from './definitions'
import { FLOWS_CONTRIBUTION } from './flows'
import { FlowsSource } from './FlowsSource'
import { registerIpc } from './ipc'
import { MenuMirror } from './menu'
import { registerOutput } from './output'
import { Refresher } from './refresh'
import { ReportsServiceImpl } from './ReportsServiceImpl'
import { REPORTS_SCHEMA, reportsMigrator } from './schema'
import { REPORTS_SETTINGS, settingsContribution } from './settings'
import { ViewState } from './viewState'
import { ReportsViewSupport } from './viewSupport'

/** The service other plugins get: exactly the contract, so nothing internal (the registry, the participant) leaks through. */
export function publicService(service: ReportsServiceImpl): ReportsService {
  return {
    definitions: () => service.definitions(),
    groups: () => service.groups(),
    saved: () => service.saved(),
    open: ref => service.open(ref),
    run: (ref, parameters, options) => service.run(ref, parameters, options),
    runSpec: (spec, parameters, title) => service.runSpec(spec, parameters, title),
    saveReport: input => service.saveReport(input),
    updateReport: (id, patch, options) => service.updateReport(id, patch, options),
    duplicateReport: (id, name) => service.duplicateReport(id, name),
    deleteReport: id => service.deleteReport(id),
    onDidChange: service.onDidChange
  }
}

export interface ActivateOptions {
  /** Today, 'YYYY-MM-DD' (tests fix it). */
  today?: () => string
  /** Now, ISO 8601 (tests fix it). */
  now?: () => string
  /** How long changes to figures are gathered before the views are told (tests shorten it). */
  refreshDelayMs?: number
  /** How long the view has to draw a report for printing (tests shorten it). */
  printWaitMs?: number
  /** For tests: called once activated, with what waits until every refresh has run (so tests need not guess how long). */
  onActivated?: (hooks: { idle(): Promise<void> }) => void
}

export async function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const today = options.today ?? (() => todayIso())
  const sourceDeps = { session, accounts, log: context.logger, today }
  const flows = new FlowsSource(sourceDeps)
  const balances = new BalancesSource(sourceDeps)
  // The Reports page: read where it is used, so a change applies at once
  const settings = context.settings.register(REPORTS_SETTINGS)
  const service = new ReportsServiceImpl({
    session, accounts, extensions: context.extensions, services: context.services, log: context.logger, today,
    topRows: () => settings.get().topRows, ...(options.now && { now: options.now })
  })
  const contribute = (point: string, id: string, impl: unknown) => context.extensions.contribute(REPORTS_PLUGIN_ID, point, id, impl)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const support = new ReportsViewSupport(service, session, accounts, today, () => settings.get().openOn)
  const view = new ViewState(context, service, session, (savedId, args) => support.differs(savedId, args))
  const commands = registerCommands(context, service, view, prompts)
  const menu = new MenuMirror(context, () => service.definitions(), id => commands.show({ definitionId: id }))
  const refresher = new Refresher(context, view, options.refreshDelayMs, () => menu.sync())
  // A definition's `when` reads context keys: the Reports tab greys it to match. Only when some flag changed: this
  // follows every context key in the app
  let enabled = ''
  const enablement = () => {
    const now = service.definitions().map(d => context.commands.isEnabled(showCommandOf(d.id)) ? '1' : '0').join('')
    if (now !== enabled) { enabled = now; refresher.enablementChanged() }
  }

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    { dispose: () => flows.dispose() },
    { dispose: () => balances.dispose() },
    // Declared before any ledger opens (the ledger reopens the last one once every plugin has activated)
    contribute(LEDGER_SCHEMA_POINT, REPORTS_PLUGIN_ID, REPORTS_SCHEMA),
    context.services.provide(REPORTS_PLUGIN_ID, REPORTS_MIGRATOR_SERVICE, reportsMigrator),
    // The two sources: services, and their descriptions through the public point, as any plugin's
    context.services.provide(REPORTS_PLUGIN_ID, FLOWS_SOURCE, flows),
    context.services.provide(REPORTS_PLUGIN_ID, BALANCES_SOURCE, balances),
    contribute(REPORT_SOURCES_POINT, FLOWS_CONTRIBUTION.id, FLOWS_CONTRIBUTION),
    contribute(REPORT_SOURCES_POINT, BALANCES_CONTRIBUTION.id, BALANCES_CONTRIBUTION),
    ...GROUPS.map(group => contribute(REPORT_GROUPS_POINT, group.id, group)),
    ...DEFINITIONS.map(definition => contribute(REPORT_DEFINITIONS_POINT, definition.id, definition)),
    context.services.provide(REPORTS_PLUGIN_ID, REPORTS_SERVICE, publicService(service)),
    // Deleting a sub-ledger moves a saved report over it to the parent
    session.participate(REPORTS_PLUGIN_ID, service.subLedgerParticipant),
    // The UI: the menu, the views and the dialog; the reports offered, mirrored into the menu as they come and go
    ...[...contributions(), settingsContribution()].map(([point, id, impl]) => contribute(point, id, impl)),
    menu,
    refresher,
    service.onDidChange(change => refresher.changed(change)),
    // A new *Rows before "Other"* changes the figures of reports that take it; *Open reports on*, the next one opened
    settings.onDidChange(({ changed }) => { if (changed.includes('topRows')) refresher.stale() }),
    context.commands.onDidChange(enablement),
    ...commands.disposables,
    ...registerIpc(context, service, support, view),
    // Printing, PDF and CSV: the shell's services, looked up when used
    ...registerOutput({
      context, service, view, prompts,
      files: () => context.services.get<ShellFiles>(SHELL_FILES_SERVICE),
      print: () => context.services.get<ShellPrint>(SHELL_PRINT_SERVICE),
      ...(options.printWaitMs !== undefined && { waitMs: options.printWaitMs })
    })
  )
  menu.sync()
  await view.refresh()
  options.onActivated?.({ idle: () => refresher.idle() })
}
