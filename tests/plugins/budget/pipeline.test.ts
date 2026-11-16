// @vitest-environment node
// The budget plugin as built and loaded by the app, beside the ledger, accounts, SQLite and app state plugins, driven
// through the channels and commands its views and dialogs use: make a budget and its lines, enter transactions and the
// owner's pay from the business through accounts.service, watch the status follow; restart the app on the same ledger;
// open an archive file read-only; then the year month by month, a month's own amount, Fill from History and a copy.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE, type StorageEngine } from '@tessera/types'
import { LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS, BUDGET_CONTEXT_KEYS, BUDGET_EVENTS, type BudgetStatus, type BudgetsView
} from '@tessera/budget-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-budget-ui-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

const pause = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms))

describe('the built budget plugin, driven as its views drive it', () => {
  it('makes a budget, follows the ledger\'s transactions, survives a restart, shows an archive read-only, and plans a year', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'budget'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)
    expect(fs.existsSync(path.join(out, 'budget', 'renderer', 'icons', 'pie.svg'))).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, { exists: async (f: string) => fs.existsSync(f), trash: async () => {}, documentsPath: () => userData } as never)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async () => {}, show: async () => undefined } as never)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      await manager.activateAll()
      await runtime.lifecycle.markStarted()
      const events: { name: string, data?: any }[] = []
      runtime.events.subscribe(event => events.push(event))
      const ask = async <T = any>(channel: string, data?: unknown): Promise<T> => {
        const reply = await runtime.ipc.dispatch({ channel, data })
        if (!reply.ok) throw new Error(reply.error.message)
        return reply.data as T
      }
      return {
        runtime, manager, events, ask,
        session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE),
        accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE),
        engine: runtime.services.get<StorageEngine>('storage.engine')
      }
    }
    const figures = (status: BudgetStatus) => status.rows.map(r => [r.label, r.figures.budget, r.figures.actual, r.figures.remaining])

    // ---- A household with a business that pays its owner
    const first = await start()
    const ledger = path.join(userData, 'Home.tessera')
    await first.session.create(ledger)
    const personal = await first.session.createSubLedger({ name: 'Personal', parentId: null })
    const business = await first.session.createSubLedger({ name: 'Business', parentId: null })
    const open = (name: string, subLedgerId: string) => first.accounts.createAccount({ name, type: 'chequing', subLedgerId, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    const pchq = await open('Personal Chequing', personal.id)
    const bchq = await open('Business Chequing', business.id)
    const categories = await first.accounts.categories.list()
    const groceries = categories.find(c => c.name === 'Groceries')!

    // ---- New Budget… and two lines, through the dialogs' channels
    const saved = await first.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'Household', subLedgerId: personal.id, currency: 'CAD', yearStartMonth: 1 } })
    const budget = saved.value
    await first.runtime.commands.execute(BUDGET_COMMANDS.show, { id: budget.id })
    expect(first.runtime.contextKeys.get(BUDGET_CONTEXT_KEYS.shown)).toBe(budget.id)
    const add = (input: unknown) => first.ask(BUDGET_CHANNELS.addLine, { budgetId: budget.id, input })
    expect((await add({ target: { kind: 'category', categoryId: groceries.id }, plan: { from: '2027-01', amount: 65000, frequency: 'monthly', due: '2027-01' } })).ok).toBe(true)
    expect((await add({ target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: { from: '2027-01', amount: 300000, frequency: 'monthly', due: '2027-01-25' } })).ok).toBe(true)
    const march = { budgetId: budget.id, months: { from: '2027-03', to: '2027-03' } }
    expect(figures((await first.ask(BUDGET_CHANNELS.status, march)).value)).toEqual([
      ['Transfers from Business Chequing', 300000, 0, 300000], ['Food', 65000, 0, 65000], ['Groceries', 65000, 0, 65000]
    ])

    // ---- Transactions entered in the registers: the status follows, told once they settle
    first.events.length = 0
    await first.accounts.transactions(pchq.id).create({ date: '2027-03-05', amount: -59830, payee: 'Metro', categoryId: groceries.id })
    await first.accounts.transactions(bchq.id).create({ date: '2027-03-25', amount: -300000, payee: 'Owner', transferAccountId: pchq.id })
    await pause()
    expect(first.events.filter(e => e.name === BUDGET_EVENTS.status).map(e => e.data)).toEqual([{ budgetId: null }])
    const after = (await first.ask(BUDGET_CHANNELS.status, march)).value as BudgetStatus
    expect(figures(after)).toEqual([
      ['Transfers from Business Chequing', 300000, 300000, 0], ['Food', 65000, 59830, 5170], ['Groceries', 65000, 59830, 5170]
    ])
    expect(after.totals.net).toEqual({ budget: 235000, actual: 240170, remaining: 5170 })
    await first.manager.deactivateAll()

    // ---- The app again: the ledger reopens on the budget shown last
    const second = await start()
    await second.session.open(ledger)
    await pause()
    const view = await second.ask<BudgetsView>(BUDGET_CHANNELS.budgets)
    expect(view).toMatchObject({ shown: budget.id, readOnly: false, ledgerName: 'Home' })
    expect(view.budgets.map(b => [b.name, b.covers])).toEqual([['Household', 'Personal']])
    expect(figures((await second.ask(BUDGET_CHANNELS.status, march)).value)).toEqual(figures(after))

    // ---- An archive file: the same budget, read-only, and nothing written to it
    const archive = path.join(userData, LEDGER_ARCHIVES_FOLDER, 'Home (archive before 2027-01-01).tesserabkp')
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    await (await second.engine.open({ path: ledger })).snapshot({ path: archive }, { meta: {
      [LEDGER_BACKUP_META.takenAt]: '2027-04-01T17:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: ledger, [LEDGER_BACKUP_META.takenWith]: 'test', [LEDGER_BACKUP_META.archiveBefore]: '2027-01-01'
    } })
    const bytes = fs.readFileSync(archive)
    await second.session.open(archive)
    await pause()
    expect(await second.ask(BUDGET_CHANNELS.budgets)).toMatchObject({ shown: budget.id, readOnly: true, archive: true })
    expect(figures((await second.ask(BUDGET_CHANNELS.status, march)).value)).toEqual(figures(after))
    for (const command of [BUDGET_COMMANDS.newBudget, BUDGET_COMMANDS.newLine, BUDGET_COMMANDS.properties]) {
      expect(second.runtime.commands.isEnabled(command), command).toBe(false)
    }
    expect(await second.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'Another', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'READ_ONLY' } })
    await second.session.close()
    expect(fs.readFileSync(archive).equals(bytes)).toBe(true)

    // ---- The year, a month of its own, Fill from History and a copy (B4), back in the ledger
    await second.session.open(ledger)
    const groceriesLine = (await second.ask(BUDGET_CHANNELS.status, march)).value.rows.find((r: { label: string }) => r.label === 'Groceries').lineId
    expect((await second.ask(BUDGET_CHANNELS.changeLine, { lineId: groceriesLine, change: { apply: 'only', month: '2027-03', amount: 70000 } })).ok).toBe(true)
    const year = (await second.ask(BUDGET_CHANNELS.status, { budgetId: budget.id, months: { from: '2027-01', to: '2027-12' }, byMonth: true })).value as BudgetStatus
    const groceriesRow = year.rows.find(r => r.lineId === groceriesLine)!
    expect(groceriesRow.months!.slice(0, 4).map(m => m.budget)).toEqual([65000, 65000, 70000, 65000])
    expect(groceriesRow.ownMonths).toEqual(['2027-03'])
    expect(year.monthlyTotals![2].expenses).toEqual({ budget: 70000, actual: 59830, remaining: 10170 })
    // March's history, for lines from April: the owner's pay, and groceries rounded up to 10.00
    const suggested = (await second.ask(BUDGET_CHANNELS.suggest, { budgetId: budget.id, months: 1, start: '2027-04', step: 1000 })).value
    expect(suggested.map((x: { label: string, amount: number, existingLineId?: string }) => [x.label, x.amount, x.existingLineId !== undefined]))
      .toEqual([['Business Chequing', 300000, true], ['Food : Groceries', 60000, true]])
    const filled = await second.ask(BUDGET_CHANNELS.fill, { budgetId: budget.id, lines: suggested.map((x: { target: unknown, amount: number }) => ({ target: x.target, plan: { from: '2027-04', amount: x.amount, frequency: 'monthly', due: '2027-04' } })) })
    expect(filled.value.map((l: { plans: { from: string }[] }) => l.plans.map(p => p.from))).toEqual([['2027-01', '2027-04'], ['2027-01', '2027-04']])
    const copy = (await second.ask(BUDGET_CHANNELS.duplicate, { id: budget.id, name: 'Household (2)' })).value
    const copied = (await second.ask(BUDGET_CHANNELS.status, { budgetId: copy.id, months: { from: '2027-01', to: '2027-12' }, byMonth: true })).value as BudgetStatus
    const original = (await second.ask(BUDGET_CHANNELS.status, { budgetId: budget.id, months: { from: '2027-01', to: '2027-12' }, byMonth: true })).value as BudgetStatus
    const withoutIds = (rows: BudgetStatus['rows']) => rows.map(({ lineId: _id, ...row }) => row)
    expect(withoutIds(copied.rows)).toEqual(withoutIds(original.rows))          // the copy's own lines, the same plans and months
    await second.manager.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
  })
})
