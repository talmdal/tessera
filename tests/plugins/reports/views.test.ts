// @vitest-environment node
// The reports plugin's UI, seen from the privileged side (phase R3): what it adds to the shell (the Reports tab, the
// report view, the Reports menu and the Transactions dialog), the catalog the views follow and when it is sent, the
// commands and context keys, and each channel the views use: open (with Accounts carried from report to report), run,
// members, select; and Show Transactions' dialog.
import { describe, expect, it } from 'vitest'
import { DIALOGS_EXTENSION_POINT } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_CONTEXT_KEYS as K, REPORTS_DIALOGS, REPORTS_EVENTS, REPORTS_MENU, REPORTS_VIEWS,
  type OpenedView, type ReportResult, type ReportsCatalog, type TransactionsArgs, type TransactionsDialogInput
} from '@tessera/reports-api'
import { household, proprietor } from './examples'
import { setupApp, type App } from './app'
import { file } from '../ledger/harness'

const catalogEvents = (app: App) => app.named(REPORTS_EVENTS.catalog).map(e => e.data as ReportsCatalog | null)
const last = <T>(list: T[]) => list[list.length - 1]

async function opened(app: App, ref: object): Promise<OpenedView> {
  const reply = await app.ask(REPORTS_CHANNELS.open, { ref })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.value
}

async function ran(app: App, ref: object, parameters: object = {}): Promise<ReportResult> {
  const reply = await app.ask(REPORTS_CHANNELS.run, { ref, parameters })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.value
}

describe('what the reports plugin adds to the shell', () => {
  it('contributes the Reports tab beside Budgets, the report view after the budget, the Reports menu after Budget, and the dialog', async () => {
    const app = await setupApp()
    const of = (point: string) => app.runtime.extensions.getContributions(point).filter(c => c.contributor === 'reports').map(c => c.impl)
    expect(of('shell.views')).toEqual([
      expect.objectContaining({ id: REPORTS_VIEWS.view, slot: 'shell.main', module: './ReportView', icon: 'ShowChart', order: -30, when: LEDGER_CONTEXT_KEYS.isOpen }),
      expect.objectContaining({ id: REPORTS_VIEWS.list, slot: 'shell.left', module: './ReportList', icon: 'ShowChart', order: -90, when: LEDGER_CONTEXT_KEYS.isOpen })
    ])
    expect(of('shell.menus')).toContainEqual(expect.objectContaining({ kind: 'menu', id: REPORTS_MENU, label: '&Reports', order: 20 }))
    expect(of(DIALOGS_EXTENSION_POINT)).toEqual([
      expect.objectContaining({ id: REPORTS_DIALOGS.transactions, module: './TransactionsDialog' }),
      expect.objectContaining({ id: REPORTS_DIALOGS.customise, module: './CustomiseDialog' }),
      expect.objectContaining({ id: REPORTS_DIALOGS.save, module: './SaveDialog' })
    ])
    expect(app.log.warn).not.toHaveBeenCalled()
  })
})

describe('the catalog', () => {
  it('is null with no ledger open, and lists the groups, the seven reports and no saved ones once one is', async () => {
    const app = await setupApp()
    expect(await app.ask(REPORTS_CHANNELS.catalog)).toBeNull()
    await app.open()
    const catalog: ReportsCatalog = await app.ask(REPORTS_CHANNELS.catalog)
    expect(catalog.groups).toEqual([{ id: 'reports.group.spending', label: 'Income and Spending' }, { id: 'reports.group.balances', label: 'Net Worth and Balances' }])
    expect(catalog.definitions.map(d => d.label)).toEqual([
      'Income vs Expenses', 'Spending by Category', 'Spending by Payee', 'Category Trends', 'Cash Flow', 'Net Worth', 'Account Balances'
    ])
    expect(catalog.definitions.every(d => d.enabled)).toBe(true)
    expect(catalog).toMatchObject({ saved: [], readOnly: false, archive: false, ledgerName: 'Home', shown: null })
    // Sent as the ledger opened, and as it is now
    expect(last(catalogEvents(app))).toEqual(catalog)
  })

  it('is sent when a saved report comes or goes, and not again when nothing changed', async () => {
    const app = await setupApp()
    await app.open()
    const before = catalogEvents(app).length
    const saved = await app.reports.saveReport({ name: 'Groceries this year', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: {} })
    await app.idle()
    expect(catalogEvents(app)).toHaveLength(before + 1)
    expect(last(catalogEvents(app))!.saved).toEqual([{ id: saved.id, name: 'Groceries this year', basis: 'Spending by Category', available: true }])
    expect(app.key(K.hasSaved)).toBe(true)
    // Transactions change figures, not the catalog
    const a = await app.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    await app.accounts.transactions(a.id).create({ date: '2026-01-05', amount: -1000 })
    await app.idle()
    expect(catalogEvents(app)).toHaveLength(before + 1)
    await app.reports.deleteReport(saved.id)
    await app.idle()
    expect(last(catalogEvents(app))!.saved).toEqual([])
    expect(app.key(K.hasSaved)).toBe(false)
  })
})

describe('the commands', () => {
  it('Show Reports reveals the tab; Show shows a report and reveals the view; both need a ledger', async () => {
    const app = await setupApp()
    expect(app.enabled(C.showList)).toBe(false)
    expect(app.enabled(C.show)).toBe(false)
    await app.open()
    app.reveals.length = 0
    expect(await app.run(C.showList)).toBe(true)
    expect(app.reveals).toEqual([REPORTS_VIEWS.list])
    expect(await app.run(C.show, { definitionId: 'reports.netWorth' })).toBe(true)
    expect(app.reveals).toEqual([REPORTS_VIEWS.list, REPORTS_VIEWS.view])
    await app.idle()
    expect(last(catalogEvents(app))!.shown).toEqual({ ref: { definitionId: 'reports.netWorth' }, request: 1 })
    expect(app.key(K.shown)).toBe('reports.netWorth')
    expect(app.key(K.shownSaved)).toBe(false)
  })

  it('Show passes its parameters to the view, and counts each request, so showing the report shown again is seen', async () => {
    const app = await setupApp()
    await app.open()
    await app.run(C.show, { definitionId: 'reports.spendingByCategory' })
    await app.run(C.show, { definitionId: 'reports.spendingByCategory', parameters: { period: { preset: 'lastYear' } } })
    await app.idle()
    expect(last(catalogEvents(app))!.shown).toEqual({ ref: { definitionId: 'reports.spendingByCategory' }, parameters: { period: { preset: 'lastYear' } }, request: 2 })
  })

  it('Show refuses a report that isn’t there, and leaves the view as it was', async () => {
    const app = await setupApp()
    await app.open()
    app.reveals.length = 0
    expect(await app.run(C.show, { definitionId: 'reports.nothing' })).toBe(false)
    expect(await app.run(C.show, { savedId: 'nope' })).toBe(false)
    expect(await app.run(C.show, 'reports.netWorth')).toBe(false)
    expect(app.reveals).toEqual([])
    expect(app.key(K.shown)).toBeUndefined()
  })

  it('shows a saved report, and forgets it once it is deleted', async () => {
    const app = await setupApp()
    await app.open()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    await app.run(C.show, { savedId: saved.id })
    expect(app.key(K.shown)).toBe(saved.id)
    expect(app.key(K.shownSaved)).toBe(true)
    await app.reports.deleteReport(saved.id)
    await app.idle()
    expect(last(catalogEvents(app))!.shown).toBeNull()
    expect(app.key(K.shown)).toBeUndefined()
  })

  it('Refresh tells the views every source is stale, while a report is shown', async () => {
    const app = await setupApp()
    await app.open()
    expect(app.enabled(C.refresh)).toBe(false)
    await app.run(C.show, { definitionId: 'reports.netWorth' })
    expect(app.enabled(C.refresh)).toBe(true)
    await app.run(C.refresh)
    expect(last(app.named(REPORTS_EVENTS.stale))!.data).toEqual({ sources: null })
  })

  it('starts another ledger with nothing shown', async () => {
    const app = await setupApp()
    await app.open()
    await app.run(C.show, { definitionId: 'reports.netWorth' })
    await app.session.create(file('Other.tessera'))
    await app.idle()
    expect(last(catalogEvents(app))).toMatchObject({ ledgerName: 'Other', shown: null })
    expect(app.key(K.shown)).toBeUndefined()
  })
})

describe('the channels', () => {
  it('open gives the heading what it needs: the source, what Compare with offers, the pickers, the tree, accounts and currencies', async () => {
    const app = await setupApp()
    await app.open()
    const { personal } = await proprietor(app.env)
    const trends = await opened(app, { definitionId: 'reports.categoryTrends' })
    expect(trends).toMatchObject({
      title: 'Category Trends', source: { id: 'reports.flows', time: 'range', scopes: ['ledger', 'subLedger', 'types', 'accounts'], currency: true, drillDown: true },
      compareOptions: ['previousYear', 'previousPeriod'], choose: [{ dimension: 'category', label: 'Category' }], grain: 'month',
      show: 'both', hasChart: true, emptyText: 'Nothing was spent from these accounts in this period.', today: '2027-01-15', yearStart: { month: 1, day: 1 },
      readOnly: false, parameters: { period: { preset: 'last12Months' }, scope: { kind: 'ledger' }, currency: 'mostUsed', compare: 'none' }
    })
    expect(trends.choices.subLedgers.map(s => s.name)).toEqual(['Personal', 'Business'])
    expect(trends.choices.accounts.map(a => a.name)).toEqual(['Personal Chequing', 'Personal Savings', 'Business Chequing'])
    expect(trends.choices.currencies).toEqual(['CAD'])
    const balances = await opened(app, { definitionId: 'reports.accountBalances' })
    expect(balances).toMatchObject({ source: { id: 'reports.balances', time: 'asOf', drillDown: false }, compareOptions: ['asOf'], show: 'table' })
    expect(personal).toBeDefined()
  })

  it('open says what is wrong with a report that can’t be shown', async () => {
    const app = await setupApp()
    await app.open()
    const reply = await app.ask(REPORTS_CHANNELS.open, { ref: { definitionId: 'reports.nothing' } })
    expect(reply).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await app.ask(REPORTS_CHANNELS.open, {})).toMatchObject({ ok: false, error: { code: 'INVALID' } })
  })

  it('carries Accounts from report to report: a sub-ledger stays, as everyday accounts in it for Cash Flow; a saved report keeps its own', async () => {
    const app = await setupApp()
    await app.open()
    const { personal } = await proprietor(app.env)
    const spending = { definitionId: 'reports.spendingByCategory' }
    await app.run(C.show, spending)
    await app.ask(REPORTS_CHANNELS.select, { ref: spending, parameters: { period: { preset: 'thisYear' }, scope: { kind: 'subLedger', subLedgerId: personal.id } } })
    expect((await opened(app, { definitionId: 'reports.incomeVsExpenses' })).parameters.scope).toEqual({ kind: 'subLedger', subLedgerId: personal.id })
    expect((await opened(app, { definitionId: 'reports.cashFlow' })).parameters.scope)
      .toEqual({ kind: 'types', types: ['chequing', 'savings', 'creditCard', 'lineOfCredit'], subLedgerId: personal.id })
    const saved = await app.reports.saveReport({ name: 'Everything', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: { scope: { kind: 'ledger' } } })
    expect((await opened(app, { savedId: saved.id })).parameters.scope).toEqual({ kind: 'ledger' })
  })

  it('ignores a selection for a report no longer shown (a late one), and carries nothing from it', async () => {
    const app = await setupApp()
    await app.open()
    const { business } = await proprietor(app.env)
    await app.run(C.show, { definitionId: 'reports.netWorth' })
    await app.ask(REPORTS_CHANNELS.select, { ref: { definitionId: 'reports.cashFlow' }, parameters: { scope: { kind: 'subLedger', subLedgerId: business.id } } })
    expect((await opened(app, { definitionId: 'reports.incomeVsExpenses' })).parameters.scope).toEqual({ kind: 'ledger' })
  })

  it('run runs a report with the heading’s parameters, and says what is wrong with them rather than failing', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    const result = await ran(app, { definitionId: 'reports.spendingByCategory' }, { period: { from: '2026-01-01', to: '2026-12-31' } })
    expect(result.subtitle).toBe('2026 · Whole ledger · CAD')
    expect(result.rows.find(r => r.kind === 'total')!.values[0]).toBe(4074790)
    const bad = await app.ask(REPORTS_CHANNELS.run, { ref: { definitionId: 'reports.categoryTrends' }, parameters: { period: { from: '2000-01-01', to: '2026-12-31' } } })
    expect(bad).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } })
  })

  it('members gives a picker’s choices from the report’s source', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    const reply = await app.ask(REPORTS_CHANNELS.members, { ref: { definitionId: 'reports.categoryTrends' }, dimension: 'category', parameters: {} })
    expect(reply.ok).toBe(true)
    expect(reply.value.map((m: { label: string }) => m.label)).toEqual(expect.arrayContaining(['Food', 'Groceries', 'Housing', 'Rent']))
    expect(await app.ask(REPORTS_CHANNELS.members, { ref: { definitionId: 'reports.categoryTrends' }, dimension: 'colour', parameters: {} }))
      .toMatchObject({ ok: false, error: { code: 'INVALID' } })
  })
})

describe('Show Transactions', () => {
  it('lists what makes up a figure in the dialog, named as the register names it', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    const ref = { definitionId: 'reports.spendingByPayee' }
    const parameters = { period: { from: '2026-03-01', to: '2026-03-31' } }
    await app.run(C.show, ref)
    const result = await ran(app, ref, parameters)
    const rent = result.rows.find(r => r.label === 'Riverside Properties')!
    const args: TransactionsArgs = {
      ref, parameters, row: rent.drill!, column: result.columns[0].drill!, currency: 'CAD', label: rent.label, columnLabel: 'March 2026', figure: rent.values[0]
    }
    expect(await app.run(C.transactions, args)).toBe(true)
    const [dialog, input, options] = app.prompts.show.mock.calls[0] as [string, TransactionsDialogInput, { title: string }]
    expect(dialog).toBe(REPORTS_DIALOGS.transactions)
    expect(options.title).toBe('Transactions: Riverside Properties · March 2026')
    expect(input).toMatchObject({ title: 'Riverside Properties · March 2026', currency: 'CAD', figure: 150000, result: { total: 1 } })
    expect(input.result.transactions).toEqual([expect.objectContaining({ accountName: 'Chequing', date: '2026-03-04', amount: 150000, payee: 'Riverside Properties', label: 'Housing : Rent', currency: 'CAD' })])
  })

  it('says why it can’t list them, rather than failing', async () => {
    const app = await setupApp()
    await app.open()
    const ref = { definitionId: 'reports.netWorth' }
    await app.run(C.show, ref)
    const args = { ref, parameters: {}, row: { keys: ['asset'] }, column: { measure: 'balance' }, label: 'Assets', columnLabel: '', figure: 0 }
    expect(await app.run(C.transactions, args)).toBe(false)
    expect(app.prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', message: 'Could not list the transactions.' }))
    expect(app.prompts.show).not.toHaveBeenCalled()
  })
})
