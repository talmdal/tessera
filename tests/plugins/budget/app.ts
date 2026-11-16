// The ledger, accounts and budget plugins activated together through plugin contexts, as the app runs them, on the
// memory engine: for tests of the budget's commands, channels, context keys, settings and status bar.
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { BUDGET_SERVICE, type BudgetService } from '@tessera/budget-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBudget } from '../../../plugins/budget/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'
import { account } from './harness'

export const TODAY = '2027-03-15'

export interface AppSetup {
  /** Today, 'YYYY-MM-DD' (default `TODAY`); a function, so a test can move it on. */
  today?: () => string
  /** How often the status bar checks for a new month (default: the plugin's minute). */
  monthCheckMs?: number
}

export async function setup(options: AppSetup = {}) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const engine = new KitStorageEngine(driver)
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  const state = memoryAppState()
  runtime.services.provide('storage-memory', 'storage.engine', engine)
  runtime.services.provide('app-state', 'app.state', state)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  const shell = createPluginContext('shell', runtime).context
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (id: unknown) => { reveals.push(String(id)) })
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  let idle: () => Promise<void> = async () => {}
  await activateBudget(createPluginContext('budget', runtime).context, {
    today: options.today ?? (() => TODAY), refreshDelayMs: 10, onActivated: hooks => { idle = hooks.idle },
    ...(options.monthCheckMs !== undefined && { monthCheckMs: options.monthCheckMs })
  })

  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const budgets = runtime.services.get<BudgetService>(BUDGET_SERVICE)
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const key = (k: string) => runtime.contextKeys.get(k)
  const enabled = (id: string) => runtime.commands.isEnabled(id)
  const named = (name: string) => events.filter(e => e.name === name)
  const open = async () => {
    files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
    await run(LEDGER_COMMANDS.new)
    await idle()
  }
  return {
    runtime, engine, log, prompts, answers, reveals, events, session, accounts, budgets, run, ask, key, enabled, named, open, state,
    /** Waits until the budget plugin has run every refresh it has to: after a change, before checking what it sent. */
    idle: () => idle()
  }
}

export type Env = Awaited<ReturnType<typeof setup>>

/** The household of the worked cases, small: Personal with chequing and a US card, Business with its chequing. */
export async function household(env: Env) {
  const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
  const business = await env.session.createSubLedger({ name: 'Business', parentId: null })
  const pchq = await env.accounts.createAccount(account('Personal Chequing', personal.id))
  const usVisa = await env.accounts.createAccount(account('US Visa', personal.id, { type: 'creditCard', currency: 'USD' }))
  const bchq = await env.accounts.createAccount(account('Business Chequing', business.id))
  const categories = await env.accounts.categories.list()
  const category = (name: string) => categories.find(c => c.name === name)!.id
  return { personal, business, pchq, usVisa, bchq, category }
}

