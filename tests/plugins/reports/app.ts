// The ledger, accounts and reports plugins activated together through plugin contexts, as the app runs them, on the
// memory engine: for tests of the reports' commands, channels, context keys, menu and events (phase R3).
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { vi } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PRINT_SERVICE, SHELL_PROMPTS_SERVICE, type PluginContext, type ShellPrint } from '@tessera/types'
import { LEDGER_BACKUP_META, LEDGER_COMMANDS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { REPORTS_SERVICE, type ReportsService } from '@tessera/reports-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { activate as activateReports } from '../../../plugins/reports/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'
import type { ReportsEnv } from './harness'

export const TODAY = '2027-01-15'

export interface AppSetup {
  /** Before the reports plugin activates: another plugin's activation (contributing a report, say). */
  before?: (runtime: ReturnType<typeof createPluginRuntime>) => Promise<void> | void
  today?: () => string
  /** How long the view has to draw a report for printing. */
  printWaitMs?: number
}

export async function setupApp(options: AppSetup = {}) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const engine = new KitStorageEngine(driver)
  const disk = memoryDisk(driver)
  const { files, written } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  // The shell's printing: printed, unless a test says otherwise
  const print = {
    print: vi.fn(async (_options?: Parameters<ShellPrint['print']>[0]) => true),
    savePdf: vi.fn(async (_options: Parameters<ShellPrint['savePdf']>[0]) => {}),
    paperSize: vi.fn(() => 'Letter' as const)
  } satisfies ShellPrint
  const state = memoryAppState()
  runtime.services.provide('storage-memory', 'storage.engine', engine)
  runtime.services.provide('app-state', 'app.state', state)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  runtime.services.provide('shell', SHELL_PRINT_SERVICE, print)
  const shell = createPluginContext('shell', runtime).context
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (id: unknown) => { reveals.push(String(id)) })
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  await options.before?.(runtime)
  let idle: () => Promise<void> = async () => {}
  const context: PluginContext = createPluginContext('reports', runtime).context
  await activateReports({ ...context, logger: log }, {
    today: options.today ?? (() => TODAY), now: () => '2027-01-15T17:00:00.000Z', refreshDelayMs: 10, onActivated: hooks => { idle = hooks.idle },
    ...(options.printWaitMs !== undefined && { printWaitMs: options.printWaitMs })
  })

  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const reports = runtime.services.get<ReportsService>(REPORTS_SERVICE)
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const key = (k: string) => runtime.contextKeys.get(k)
  const enabled = (id: string) => runtime.commands.isEnabled(id)
  const named = (name: string) => events.filter(e => e.name === name)
  const open = async (name = 'Home') => {
    files.showSaveDialog.mockResolvedValueOnce(file(`${name}.tessera`))
    await run(LEDGER_COMMANDS.new)
    await idle()
  }
  /** What the household example needs of an env: its accounts and session. */
  const env = { accounts, session } as unknown as ReportsEnv
  /** An archive file of the open ledger, as File › Archive Ledger… makes it, to open read-only. */
  const archiveFile = async () => {
    const ledger = session.current!
    const at = file('Tessera Backups/Archives/Home (archive before 2026-01-01).tesserabkp')
    const db = await engine.open({ path: ledger.path })
    await db.snapshot({ path: at }, {
      meta: {
        [LEDGER_BACKUP_META.takenAt]: '2027-01-15T12:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: ledger.name,
        [LEDGER_BACKUP_META.ledgerPath]: ledger.path, [LEDGER_BACKUP_META.takenWith]: 'reports test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
      }
    })
    return at
  }
  return {
    runtime, engine, log, prompts, answers, files, written, print, reveals, events, session, accounts, reports, run, ask, key, enabled, named, open, state, env, archiveFile,
    /** Waits until the reports plugin has sent everything it had to: after a change, before checking what it sent. */
    idle: () => idle()
  }
}

export type App = Awaited<ReturnType<typeof setupApp>>
