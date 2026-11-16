// @vitest-environment node
// The budget plugin activated beside the ledger and accounts plugins: through plugin contexts, as the app activates
// it, and as built and loaded by the real plugin manager on SQLite.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { BUDGET_MIGRATOR_SERVICE, BUDGET_SERVICE, type BudgetService } from '@tessera/budget-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBudget } from '../../../plugins/budget/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'

async function setup() {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, fakePrompts().prompts)
  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const archiveJoins = vi.spyOn(session, 'participateInArchive')
  const subLedgerJoins = vi.spyOn(session, 'participate')
  await activateAccounts(createPluginContext('accounts', runtime).context)
  await activateBudget(createPluginContext('budget', runtime).context)
  const open = async () => {
    files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
    await runtime.commands.execute(LEDGER_COMMANDS.new)
  }
  return { runtime, session, archiveJoins, subLedgerJoins, open, budgets: runtime.services.get<BudgetService>(BUDGET_SERVICE), accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE) }
}

describe('the budget plugin, activated', () => {
  it('joins archives after the accounts plugin, whose totals it keeps, and takes part in deleting sub-ledgers', async () => {
    const { archiveJoins, subLedgerJoins } = await setup()
    expect(archiveJoins.mock.calls.map(([contributor]) => contributor)).toEqual(['accounts', 'budget'])
    expect(subLedgerJoins.mock.calls.map(([contributor]) => contributor)).toEqual(['accounts', 'budget'])
  })

  it('provides exactly the BudgetService contract, a migrator, and its collections for ledger.schema', async () => {
    const { budgets, runtime } = await setup()
    expect(Object.keys(budgets).sort()).toEqual([
      'addLine', 'changeLine', 'create', 'delete', 'deleteLine', 'duplicate', 'fill', 'get', 'lines', 'list', 'onDidChange',
      'setLineNotes', 'status', 'suggest', 'update'
    ])
    expect(runtime.services.has(BUDGET_MIGRATOR_SERVICE)).toBe(true)
    expect(runtime.extensions.getContributions('ledger.schema').map(c => c.id)).toEqual(['accounts', 'budget'])
  })

  it('keeps budgets in the ledger it opens', async () => {
    const { budgets, open } = await setup()
    await expect(budgets.list()).rejects.toMatchObject({ code: 'NO_LEDGER' })
    await open()
    const b = await budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    expect(await budgets.list()).toEqual([b])
  })
})

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-budget-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

describe('the built budget plugin', () => {
  it('activates after accounts, on SQLite, and keeps its budgets across a restart', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'budget'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)
    const code = fs.readFileSync(path.join(out, 'budget', 'privileged/index.js'), 'utf8')
    expect(code).not.toMatch(/require\(["'](\.\.?\/|@tessera\/|@core|@shared)/)       // the contracts bundled in

    const userData = createTempModulesDir()
    const log = createLogger()
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, { exists: async (f: string) => fs.existsSync(f), trash: async () => {}, documentsPath: () => userData } as never)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async () => {} } as never)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      const active = (await manager.activateAll()).map(m => m.id)
      await runtime.lifecycle.markStarted()
      return { active, manager, session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE), accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE), budgets: runtime.services.get<BudgetService>(BUDGET_SERVICE) }
    }

    const first = await start()
    expect(first.active.indexOf('budget')).toBeGreaterThan(first.active.indexOf('accounts'))
    const ledger = path.join(userData, 'Home.tessera')
    await first.session.create(ledger)
    const chq = await first.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    const groceries = (await first.accounts.categories.list()).find(c => c.name === 'Groceries')!
    await first.accounts.transactions(chq.id).create({ date: '2027-03-05', amount: -59830, categoryId: groceries.id })
    const b = await first.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await first.budgets.addLine(b.id, { target: { kind: 'category', categoryId: groceries.id }, plan: { from: '2027-01', amount: 65000, frequency: 'monthly', due: '2027-01' } })
    await first.manager.deactivateAll()

    const second = await start()
    await second.session.open(ledger)
    const status = await second.budgets.status(b.id, { from: '2027-03', to: '2027-03' })
    expect(status.rows.map(r => [r.kind, r.label, r.figures.budget, r.figures.actual, r.figures.remaining])).toEqual([
      ['subtotal', 'Food', 65000, 59830, 5170], ['line', 'Groceries', 65000, 59830, 5170]
    ])
    await second.manager.deactivateAll()
  })
})
