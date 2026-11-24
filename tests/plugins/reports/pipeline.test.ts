// @vitest-environment node
// The reports plugin as built and loaded by the app, beside the ledger, accounts, SQLite and app state plugins, through
// `reports.service`: a report on a real file, a saved report kept in it across a restart, and an archive file opened
// read-only, reported on, and left as it was. See docs/reporting-design.md, Phase R2.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PRINT_SERVICE, SHELL_PROMPTS_SERVICE, type StorageEngine } from '@tessera/types'
import { LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { MAIN_ACTIVE_VIEW_KEY } from '@tessera/types'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS, REPORTS_EVENTS, REPORTS_SERVICE, REPORTS_VIEWS, type PrintRequest, type ReportResult, type ReportsService
} from '@tessera/reports-api'
import { BUDGET_COMMANDS, BUDGET_REPORTS, BUDGET_SERVICE, type BudgetService } from '@tessera/budget-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { nodeWriteDisk, writeFileAtomically } from '../../../shell/main/dialogs/writeFile'
import { createElectronPrint } from '../../../shell/main/print/electronPrint'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-reports-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

const figures = (result: ReportResult) => result.rows.map(r => [r.label, ...r.values])

describe('the built reports plugin', () => {
  it('reports on a SQLite ledger, keeps a saved report across a restart, and reports on an archive file without writing to it', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'reports'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, { exists: async (f: string) => fs.existsSync(f), trash: async () => {}, documentsPath: () => userData } as never)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async () => {}, show: async () => undefined } as never)
      runtime.services.provide('shell', SHELL_PRINT_SERVICE, { print: async () => false, savePdf: async () => {}, paperSize: () => 'A4' } as never)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      await manager.activateAll()
      await runtime.lifecycle.markStarted()
      return {
        manager,
        session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE),
        accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE),
        reports: runtime.services.get<ReportsService>(REPORTS_SERVICE),
        engine: runtime.services.get<StorageEngine>('storage.engine')
      }
    }

    // ---- A household and a business, in a real file
    const first = await start()
    expect(first.reports.definitions().map(d => d.label)).toEqual([
      'Income vs Expenses', 'Spending by Category', 'Spending by Payee', 'Category Trends', 'Cash Flow', 'Net Worth', 'Account Balances'
    ])
    const ledger = path.join(userData, 'Home.tessera')
    await first.session.create(ledger)
    const business = await first.session.createSubLedger({ name: 'Business', parentId: null })
    const chq = await first.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000 })
    const bchq = await first.accounts.createAccount({ name: 'Business Chequing', type: 'chequing', subLedgerId: business.id, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 500000 })
    const categories = await first.accounts.categories.list()
    const id = (name: string) => categories.find(c => c.name === name)!.id
    await first.accounts.transactions(chq.id).createMany([
      { date: '2026-03-05', amount: -59830, payee: 'FreshCo', categoryId: id('Groceries') },
      { date: '2026-03-06', amount: -21205, payee: 'Corner Café', categoryId: id('Dining out') }
    ])
    await first.accounts.transactions(bchq.id).create({ date: '2026-03-25', amount: -300000, transferAccountId: chq.id })
    const march = { period: { from: '2026-03-01', to: '2026-03-31' } }
    const side = await first.reports.run({ definitionId: 'reports.incomeVsExpenses' }, { ...march, compare: 'subLedgers' })
    expect(side.columns.map(c => c.label)).toEqual(['Business', 'Home itself', 'Whole ledger'])
    expect(figures(side).find(r => r[0] === 'Net after transfers')).toEqual(['Net after transfers', -300000, 218965, -81035])
    const saved = await first.reports.saveReport({ name: 'Spending in March', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', options: { detail: 'all' } }, parameters: march })
    const before = await first.reports.run({ savedId: saved.id })
    expect(figures(before)).toEqual([['Food', 81035, 10000], ['Groceries', 59830, 7383], ['Dining out', 21205, 2616], ['Total', 81035, 10000]])
    await first.manager.deactivateAll()

    // ---- The app again: the saved report is in the ledger, and runs the same
    const second = await start()
    await second.session.open(ledger)
    expect((await second.reports.saved()).map(s => s.name)).toEqual(['Spending in March'])
    expect(figures(await second.reports.run({ savedId: saved.id }))).toEqual(figures(before))

    // ---- An archive file: the same reports, read-only, and nothing written to it
    const archive = path.join(userData, LEDGER_ARCHIVES_FOLDER, 'Home (archive before 2026-04-01).tesserabkp')
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    await (await second.engine.open({ path: ledger })).snapshot({ path: archive }, { meta: {
      [LEDGER_BACKUP_META.takenAt]: '2026-11-01T17:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: ledger, [LEDGER_BACKUP_META.takenWith]: 'test', [LEDGER_BACKUP_META.archiveBefore]: '2026-04-01'
    } })
    const bytes = fs.readFileSync(archive)
    await second.session.open(archive)
    expect(figures(await second.reports.run({ savedId: saved.id }))).toEqual(figures(before))
    await expect(second.reports.saveReport({ name: 'Another', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} }))
      .rejects.toMatchObject({ code: 'READ_ONLY' })
    await second.session.close()
    expect(fs.readFileSync(archive).equals(bytes)).toBe(true)
    await second.manager.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('offers Budget vs Actual from the built budget plugin; and, with either plugin turned off, the other works without it (R5)', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules-budget')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'budget', 'reports'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const ledger = path.join(userData, 'Home.tessera')
    const start = async (disabledPlugins: string[] = []) => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, { exists: async (f: string) => fs.existsSync(f), trash: async () => {}, documentsPath: () => userData } as never)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async () => {}, show: async () => undefined } as never)
      runtime.services.provide('shell', SHELL_PRINT_SERVICE, { print: async () => false, savePdf: async () => {}, paperSize: () => 'A4' } as never)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection({ ...defaultBootstrapConfig(), disabledPlugins }))
      await manager.activateAll()
      await runtime.lifecycle.markStarted()
      return { runtime, manager, session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE), accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE) }
    }

    // ---- Both: a budget, and the report of it
    const both = await start()
    await both.session.create(ledger)
    const budgets = both.runtime.services.get<BudgetService>(BUDGET_SERVICE)
    const reports = both.runtime.services.get<ReportsService>(REPORTS_SERVICE)
    const chq = await both.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    const groceries = (await both.accounts.categories.list()).find(c => c.name === 'Groceries')!.id
    const budget = await budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await budgets.addLine(budget.id, { target: { kind: 'category', categoryId: groceries }, plan: { from: '2026-01', amount: 65000, frequency: 'monthly', due: '2026-01' } })
    await both.accounts.transactions(chq.id).create({ date: '2026-03-05', amount: -59830, categoryId: groceries })
    expect(reports.definitions().find(d => d.id === BUDGET_REPORTS.vsActual)).toMatchObject({ label: 'Budget vs Actual', group: { label: 'Budgets' }, available: true })
    const result = await reports.run({ definitionId: BUDGET_REPORTS.vsActual }, { period: { from: '2026-03-01', to: '2026-03-31' } })
    expect(figures(result).find(r => r[0] === 'Groceries')).toEqual(['Groceries', 65000, 59830, 5170, 9204])
    await both.manager.deactivateAll()

    // ---- Without the reports plugin: the budget as before
    const noReports = await start(['reports'])
    await noReports.session.open(ledger)
    const status = await noReports.runtime.services.get<BudgetService>(BUDGET_SERVICE).status(budget.id, { from: '2026-03', to: '2026-03' })
    expect(status.totals.expenses.actual).toBe(59830)
    expect(noReports.runtime.services.has(REPORTS_SERVICE)).toBe(false)
    expect(await noReports.runtime.commands.execute(BUDGET_COMMANDS.showReport, { id: budget.id })).toBe(false)
    await noReports.manager.deactivateAll()

    // ---- Without the budget plugin: the reports, and no Budget vs Actual
    const noBudget = await start(['budget'])
    await noBudget.session.open(ledger)
    const alone = noBudget.runtime.services.get<ReportsService>(REPORTS_SERVICE)
    expect(alone.definitions().map(d => d.id)).not.toContain(BUDGET_REPORTS.vsActual)
    expect(alone.groups().map(g => g.label)).toEqual(['Income and Spending', 'Net Worth and Balances'])
    expect((await alone.run({ definitionId: 'reports.spendingByCategory' }, { period: { from: '2026-03-01', to: '2026-03-31' } })).rows.at(-1)?.values[0]).toBe(59830)
    await noBudget.manager.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[reports]'))).toEqual([])
  })

  it('prints, saves as PDF and exports to CSV through the shell\'s services, the files written whole (R6)', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules-output')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'reports'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const runtime = createPluginRuntime(userData, log)
    const chosen: string[] = []
    const writeFile = (file: string, data: Uint8Array | string) => writeFileAtomically(nodeWriteDisk, file, data)
    runtime.services.provide('shell', SHELL_FILES_SERVICE, {
      exists: async (f: string) => fs.existsSync(f), trash: async () => {}, documentsPath: () => userData, showSaveDialog: async () => chosen.shift(), writeFile
    } as never)
    runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async (m: unknown) => { throw new Error(JSON.stringify(m)) }, show: async () => undefined } as never)
    // The shell's own printing, over a window that prints and makes a PDF
    const printed: unknown[] = []
    const window = { id: 3, isDestroyed: () => false, webContents: {
      print: (options: unknown, done: (ok: boolean, reason: string) => void) => { printed.push(options); done(true, '') },
      printToPDF: async () => new TextEncoder().encode('%PDF-1.4 the report')
    } }
    runtime.services.provide('shell', SHELL_PRINT_SERVICE, createElectronPrint({
      BrowserWindow: { getFocusedWindow: () => null, fromId: (id: number) => id === 3 ? window : null, getAllWindows: () => [window] },
      app: { getLocaleCountryCode: () => 'CA' }, writeFile
    }))
    const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
    await manager.activateAll()
    await runtime.lifecycle.markStarted()
    const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
    const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
    await session.create(path.join(userData, 'Home.tessera'))
    const chq = await accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000 })
    const categories = await accounts.categories.list()
    await accounts.transactions(chq.id).createMany([
      { date: '2026-03-05', amount: -59830, payee: 'FreshCo', categoryId: categories.find(c => c.name === 'Groceries')!.id },
      { date: '2026-03-06', amount: -21205, payee: '=Corner Café', categoryId: categories.find(c => c.name === 'Dining out')!.id }
    ])

    // The report shown, in front, as the view says
    const ref = { definitionId: 'reports.spendingByPayee' }
    const march = { period: { from: '2026-03-01', to: '2026-03-31' } }
    await runtime.commands.execute(REPORTS_COMMANDS.show, ref)
    await runtime.ipc.dispatch({ channel: REPORTS_CHANNELS.select, data: { ref, parameters: march, options: {} } })
    runtime.contextKeys.set(MAIN_ACTIVE_VIEW_KEY, REPORTS_VIEWS.view)

    // Export Report…: the CSV, whole, in UTF-8 with its mark, the payee that looks like a formula protected
    const csv = path.join(userData, 'Payees.csv')
    chosen.push(csv)
    expect(await runtime.commands.execute(REPORTS_COMMANDS.exportCsv)).toBe(true)
    const text = fs.readFileSync(csv, 'utf8')
    expect(text.split('\r\n').filter(Boolean)).toEqual(['\ufeffPayee,Spending,Transactions,Share', 'FreshCo,598.30,1,73.83', "'=Corner Café,212.05,1,26.16", 'Total,810.35,2,100.00'])

    // Print Report… and Save Report as PDF…: the view (played here) answers from window 3 once it has drawn the report
    runtime.events.subscribe(event => {
      if (event.name !== REPORTS_EVENTS.print) return
      const request = event.data as PrintRequest
      setTimeout(() => runtime.ipc.dispatch({ channel: REPORTS_CHANNELS.printReady, data: { request: request.request, landscape: request.output === 'pdf' } }, { windowId: 3 }), 0)
    })
    expect(await runtime.commands.execute(REPORTS_COMMANDS.print)).toBe(true)
    expect(printed).toEqual([{ silent: false, printBackground: false, landscape: false }])
    const pdf = path.join(userData, 'Payees.pdf')
    chosen.push(pdf)
    expect(await runtime.commands.execute(REPORTS_COMMANDS.savePdf)).toBe(true)
    expect(fs.readFileSync(pdf, 'utf8')).toBe('%PDF-1.4 the report')
    expect(fs.readdirSync(userData).filter(f => f.startsWith('Payees'))).toEqual(['Payees.csv', 'Payees.pdf'])
    await manager.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
  })
})
