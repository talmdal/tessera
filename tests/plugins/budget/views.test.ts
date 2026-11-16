// @vitest-environment node
// The budget plugin's UI, from the privileged side: its contributions, the Budget menu's commands and when they are
// enabled, the context keys, the channels its views and dialogs use, and how it tells the views that something changed.
// The ledger, accounts and budget plugins are activated together, as the app runs them, on the memory engine.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META, LedgerError } from '@tessera/ledger-api'
import { ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_CONTEXT_KEYS as K, BUDGET_DIALOGS, BUDGET_EVENTS, BUDGET_ICON, BUDGET_VIEWS,
  DEFAULT_HISTORY_MONTHS, DEFAULT_ROUND_TO,
  type BudgetDialogInput, type BudgetStatus, type BudgetsView, type DuplicateDialogInput, type HistoryDialogInput,
  type LineDialogInput, type LineSuggestion, type TransactionsArgs, type TransactionsDialogInput
} from '@tessera/budget-api'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { resolveIcons } from '../../../shared/layout/resolveIcons'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { DIR, file } from '../ledger/harness'
import { SHOWN_KEPT, SHOWN_KEY, ViewState } from '../../../plugins/budget/src/privileged/viewState'
import { TODAY, household, setup } from './app'
import { monthly } from './harness'

describe('the budget plugin: contributions', () => {
  it('adds a Budget menu after Accounts, the view and the Budgets tab with its own icon, and five dialogs, all valid', async () => {
    const { runtime } = await setup()
    const impls = (point: string, ...who: string[]) => runtime.extensions.getContributions(point).filter(c => who.includes(c.contributor))
    const menus = resolveMenus([{ kind: 'menu', id: 'shell.view', label: '&View' }, ...impls('shell.menus', 'accounts', 'budget').map(c => c.impl)])
    expect(menus.diagnostics).toEqual([])
    expect(menus.menus.map(m => m.id)).toEqual(['shell.view', 'accounts.menu', 'budget.menu'])
    const budgetMenu = menus.menus.find(m => m.id === 'budget.menu')!
    expect(normalizeMenuNodes(budgetMenu.children).map(n => n.type === 'item' ? n.label : n.type)).toEqual([
      '&New Budget…', '&Show Budget', 'separator', 'Budget &Properties…', 'D&uplicate Budget…', '&Delete Budget…', 'separator',
      'New &Line…', '&Edit Line…', 'Delete L&ine', 'separator', '&Fill from History…'
    ])
    const icons = resolveIcons(impls('shell.icons', 'budget'), (plugin, file) => `tessera-plugin://${plugin}/${file}`)
    expect(icons).toEqual({ icons: [{ id: BUDGET_ICON, url: 'tessera-plugin://budget/icons/pie.svg', pluginId: 'budget' }], diagnostics: [] })
    const views = resolveViews(impls('shell.views', 'budget'), () => 'x', undefined, id => id === BUDGET_ICON)
    expect(views.diagnostics).toEqual([])
    expect(views.views.map(v => [v.id, v.slot, v.icon])).toEqual([[BUDGET_VIEWS.list, 'shell.left', BUDGET_ICON], [BUDGET_VIEWS.view, 'shell.main', BUDGET_ICON]])
    // After the register in the main area, and beside the Accounts navigator in the left bar
    const order = (id: string) => (impls('shell.views', 'accounts', 'budget').find(c => c.id === id)!.impl as { order: number }).order
    expect(order(BUDGET_VIEWS.view)).toBeGreaterThan(order('accounts.register'))
    expect(order(BUDGET_VIEWS.list)).toBeGreaterThan(order('accounts.navigator'))
    expect(resolveDialogs(impls('shell.dialogs', 'budget'), () => 'x').dialogs.map(d => d.id))
      .toEqual([BUDGET_DIALOGS.budget, BUDGET_DIALOGS.line, BUDGET_DIALOGS.transactions, BUDGET_DIALOGS.history, BUDGET_DIALOGS.duplicate])
  })
})

describe('the budget plugin: commands, context keys and the budget shown', () => {
  it('offers New Budget once a writable ledger is open, and the rest once a budget is shown', async () => {
    const env = await setup()
    expect(env.enabled(C.newBudget)).toBe(false)
    expect(env.enabled(C.show)).toBe(false)
    expect(env.named(BUDGET_EVENTS.budgets).at(-1)?.data).toBeNull()
    await env.open()
    expect(env.enabled(C.newBudget)).toBe(true)
    expect(env.enabled(C.show)).toBe(true)
    expect(env.key(K.hasBudgets)).toBe(false)
    for (const command of [C.properties, C.deleteBudget, C.newLine, C.editLine, C.deleteLine]) expect(env.enabled(command), command).toBe(false)
    expect(await env.ask(BUDGET_CHANNELS.budgets)).toEqual({
      budgets: [], shown: null, month: '2027-03', period: 'month', readOnly: false, archive: false, ledgerName: 'Home',
      options: { showBars: true, showEmptyLines: false }
    })
  })

  it('makes a budget through its dialog, shows it, and publishes it', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    let asked: BudgetDialogInput | undefined
    env.prompts.show.mockImplementationOnce(async (id: unknown, input: unknown) => {
      expect(id).toBe(BUDGET_DIALOGS.budget)
      asked = input as BudgetDialogInput
      const saved = await env.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 } })
      return { id: saved.value.id }
    })
    const created = await env.run(C.newBudget) as { id: string }
    expect(asked).toMatchObject({ ledgerName: 'Home', subLedgerId: null, yearStartMonth: 1, defaultCurrency: 'CAD' })
    expect(asked!.subLedgers.map(s => s.name)).toEqual(['Personal', 'Business'])
    expect(asked!.accounts.map(a => [a.name, a.currency])).toEqual([['Personal Chequing', 'CAD'], ['US Visa', 'USD'], ['Business Chequing', 'CAD']])
    expect(env.reveals).toContain(BUDGET_VIEWS.view)
    expect(env.key(K.shown)).toBe(created.id)
    expect(env.key(K.hasBudgets)).toBe(true)
    await env.idle()
    const view = env.named(BUDGET_EVENTS.budgets).at(-1)!.data as BudgetsView
    expect(view.shown).toBe(created.id)
    expect(view.budgets.map(b => [b.name, b.covers])).toEqual([['Household', 'Personal']])
    for (const command of [C.properties, C.deleteBudget, C.newLine]) expect(env.enabled(command), command).toBe(true)
    expect(env.enabled(C.editLine)).toBe(false)
    // A new budget covers the sub-ledger selected in the Accounts navigator
    await env.ask(ACCOUNTS_CHANNELS.select, { kind: 'subLedger', id: h.business.id })
    env.prompts.show.mockResolvedValueOnce(undefined)
    await env.run(C.newBudget)
    expect(env.prompts.show).toHaveBeenLastCalledWith(BUDGET_DIALOGS.budget, expect.objectContaining({ subLedgerId: h.business.id }))
  })

  it('remembers the budget shown last in each ledger, and opens on the current month', async () => {
    const env = await setup()
    await env.open()
    const first = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const second = await env.budgets.create({ name: 'Cottage', subLedgerId: null, currency: 'CAD', yearStartMonth: 4 })
    await env.idle()
    expect(env.key(K.shown)).toBe(first.id)               // the one there was; a budget made elsewhere isn't shown
    await env.run(C.show, { id: second.id })
    await env.ask(BUDGET_CHANNELS.select, { budgetId: second.id, month: '2026-11', period: 'yearToDate' })
    expect((await env.ask(BUDGET_CHANNELS.budgets)).month).toBe('2026-11')
    await env.session.create(file('Other.tessera'))
    await env.idle()
    expect(env.key(K.shown)).toBeUndefined()
    await env.session.open(file('Home.tessera'))
    await env.idle()
    expect(env.key(K.shown)).toBe(second.id)
    expect(await env.ask(BUDGET_CHANNELS.budgets)).toMatchObject({ shown: second.id, month: '2027-03', period: 'month' })
  })

  it('publishes the line the view has selected, and deletes it after asking', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(65000) })
    await env.idle()
    await env.ask(BUDGET_CHANNELS.select, { budgetId: b.id, month: '2027-03', period: 'month', lineId: line.id })
    expect(env.key(K.lineSelected)).toBe(line.id)
    expect(env.enabled(C.editLine)).toBe(true)
    // A report about a budget no longer shown is late, and changes nothing
    await env.ask(BUDGET_CHANNELS.select, { budgetId: 'other', month: '2027-03', period: 'month' })
    expect(env.key(K.lineSelected)).toBe(line.id)

    env.answers.push(false)
    expect(await env.run(C.deleteLine)).toBe(false)
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Delete the line “Food : Groceries”?', confirmLabel: 'Delete Line', destructive: true
    }))
    expect(await env.run(C.deleteLine)).toBe(true)
    expect(await env.budgets.lines(b.id)).toEqual([])
    await env.idle()
    expect(env.key(K.lineSelected)).toBeUndefined()
    expect(env.enabled(C.deleteLine)).toBe(false)
  })

  it('deletes a budget after a confirmation naming its lines, and shows the next', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const a = await env.budgets.create({ name: 'A', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const b = await env.budgets.create({ name: 'B', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await env.budgets.addLine(a.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(1) })
    await env.budgets.addLine(a.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(1) })
    await env.idle()
    expect(await env.run(C.deleteBudget, { id: a.id })).toBe(true)
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Delete the budget “A” and its 2 lines?', detail: 'Your transactions aren’t affected. This can’t be undone.', destructive: true
    }))
    await env.idle()
    expect((await env.budgets.list()).map(x => x.name)).toEqual(['B'])
    expect(env.key(K.shown)).toBe(b.id)
  })

  it('offers a new line what it can be for, and selects the line the dialog added', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(150000) })
    await env.idle()
    let asked: LineDialogInput | undefined
    env.prompts.show.mockImplementationOnce(async (_id: unknown, input: unknown) => {
      asked = input as LineDialogInput
      const saved = await env.ask(BUDGET_CHANNELS.addLine, { budgetId: b.id, input: { target: asked.target, plan: monthly(300000, '2027-03') } })
      return { id: saved.value.id }
    })
    const added = await env.run(C.newLine, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'in' } }) as { id: string }
    const labels = asked!.choices!.map(c => c.label)
    // Categories by label, less the one with a line; then transfers with accounts outside the scope, in its currency
    expect(labels).toContain('Food : Groceries')
    expect(labels).not.toContain('Housing : Rent')
    expect(labels.filter(l => l.startsWith('Transfers'))).toEqual(['Transfers from: Business Chequing', 'Transfers to: Business Chequing'])
    expect(asked).toMatchObject({ month: '2027-03', label: 'Transfers from: Business Chequing', group: 'income', canCreateCategory: true })
    expect(env.named(BUDGET_EVENTS.line).at(-1)?.data).toEqual({ budgetId: b.id, lineId: added.id })
  })

  it('edits the line selected, titled with what it is for', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'in' }, plan: monthly(300000) })
    await env.idle()
    await env.ask(BUDGET_CHANNELS.select, { budgetId: b.id, month: '2027-04', period: 'month', lineId: line.id })
    env.prompts.show.mockResolvedValueOnce({ id: line.id })
    await env.run(C.editLine)
    expect(env.prompts.show).toHaveBeenLastCalledWith(BUDGET_DIALOGS.line,
      expect.objectContaining({ month: '2027-04', line: expect.objectContaining({ id: line.id }), label: 'Transfers from Business Chequing', group: 'income' }),
      { title: 'Edit Line: Transfers from Business Chequing' })
  })
})

describe('the budget plugin: Budget Properties…', () => {
  it('tells the dialog how many lines the budget has, and its transfer lines, for what a new scope or currency would do', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(1) })
    await env.budgets.addLine(b.id, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'in' }, plan: monthly(1) })
    await env.idle()
    env.prompts.show.mockResolvedValueOnce(undefined)
    await env.run(C.properties)
    expect(env.prompts.show).toHaveBeenLastCalledWith(BUDGET_DIALOGS.budget, expect.objectContaining({
      budget: expect.objectContaining({ id: b.id }), lineCount: 2,
      transferLines: [{ accountId: h.bchq.id, label: 'Transfers from Business Chequing' }]
    }), { title: 'Budget Properties' })
  })
})

describe('the budget plugin: what the view shows, on its own', () => {
  const fakeContext = (values = new Map<string, unknown>()) => ({
    contextKeys: { set: vi.fn(), get: vi.fn() }, events: { emit: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      update: async () => {}, remove: async () => {}
    }
  })

  it('says no ledger is open when the ledger closes as the tree is read, rather than failing', async () => {
    // The ledger's own error, as LedgerSessionImpl.tree() throws it: not a budget error
    const session = { current: { path: '/l/Home.tessera', name: 'Home', readOnly: false, id: 'L1' }, tree: async () => { throw new LedgerError('NO_LEDGER', 'No ledger is open.') } }
    const service = { list: async () => [], lines: async () => [] }
    const view = new ViewState(fakeContext() as never, service as never, session as never, () => TODAY)
    expect(await view.view()).toBeNull()
    await expect(view.refresh()).resolves.toBeUndefined()
  })

  it('remembers the budget shown in at most the 50 ledgers used last', async () => {
    const values = new Map<string, unknown>()
    const session = { current: undefined as undefined | { path: string, name: string, readOnly: boolean, id: string }, tree: async () => ({ subLedgers: [] }) }
    const service = { list: async () => [{ id: 'b' }], lines: async () => [] }
    const view = new ViewState(fakeContext(values) as never, service as never, session as never, () => TODAY)
    for (let i = 1; i <= SHOWN_KEPT + 5; i++) {
      session.current = { path: `/l/${i}.tessera`, name: `${i}`, readOnly: false, id: `L${i}` }
      await view.show('b')
    }
    // Ledger 3 used again: it becomes the most recent
    session.current = { path: '/l/3.tessera', name: '3', readOnly: false, id: 'L3' }
    await view.show('b')
    const kept = Object.keys(values.get(SHOWN_KEY) as object)
    expect(kept).toHaveLength(SHOWN_KEPT)
    expect(kept.at(-1)).toBe('L3')
    // 55 ledgers kept 6 to 55; 3 used again came back as the newest, and 6, then the oldest, went
    for (const gone of ['L1', 'L2', 'L4', 'L5', 'L6']) expect(kept).not.toContain(gone)
    expect(kept[0]).toBe('L7')
  })
})

describe('the budget plugin: channels', () => {
  it('saves a budget as a result: a name taken is the name field\'s problem, and the whole form replaces the notes', async () => {
    const env = await setup()
    await env.open()
    const saved = await env.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'Household', subLedgerId: null, currency: 'cad', yearStartMonth: 1, notes: 'Ours' } })
    expect(saved).toMatchObject({ ok: true, value: { name: 'Household', currency: 'CAD', notes: 'Ours' } })
    expect(await env.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'HOUSEHOLD', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 } }))
      .toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a budget named “Household”.', field: 'name' } })
    const edited = await env.ask(BUDGET_CHANNELS.saveBudget, { id: saved.value.id, expectedRev: saved.value.rev, input: { name: 'Home', subLedgerId: null, currency: 'CAD', yearStartMonth: 4 } })
    expect(edited.value).toMatchObject({ name: 'Home', yearStartMonth: 4 })
    expect(edited.value).not.toHaveProperty('notes')
    expect(await env.ask(BUDGET_CHANNELS.saveBudget, { id: saved.value.id, expectedRev: saved.value.rev, input: { name: 'Again', subLedgerId: null, currency: 'CAD', yearStartMonth: 4 } }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })

  it('changes a line\'s plan and notes in one request, each checked against the revision it started from', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(65000) })
    const changed = await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, expectedRev: line.rev, change: { apply: 'from', plan: monthly(70000, '2027-04') }, notes: 'More' })
    expect(changed.ok).toBe(true)
    expect(changed.value).toMatchObject({ notes: 'More', plans: [{ from: '2027-01', amount: 65000 }, { from: '2027-04', amount: 70000 }] })
    expect(await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, expectedRev: line.rev, notes: null })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await env.ask(BUDGET_CHANNELS.line, { lineId: line.id })).toEqual({ ok: true, value: changed.value })
    const cleared = await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, expectedRev: changed.value.rev, notes: null })
    expect(cleared.value).not.toHaveProperty('notes')
    expect(await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, change: { apply: 'from', plan: { ...monthly(1), frequency: 'weekly' } } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID', field: 'due' } })
  })

  it('changes the plan and the notes in one write: nothing when either is refused, so a retry isn\'t a conflict', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(100) })
    const change = { apply: 'from', plan: monthly(200, '2027-04') }
    expect(await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, expectedRev: line.rev, change, notes: 'bad\u0001note' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID', field: 'notes' } })
    expect((await env.budgets.lines(b.id))[0]).toEqual(line)
    expect(await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, expectedRev: line.rev, change, notes: 'Goes up in April' }))
      .toMatchObject({ ok: true, value: { rev: line.rev + 1, notes: 'Goes up in April' } })
  })

  it('makes a category for a new line, its problems on the For field', async () => {
    const env = await setup()
    await env.open()
    const made = await env.ask(BUDGET_CHANNELS.createCategory, { path: 'Pets : Food', kind: 'expense' })
    expect(made).toMatchObject({ ok: true, value: { name: 'Food', kind: 'expense' } })
    expect(await env.ask(BUDGET_CHANNELS.createCategory, { path: '  ', kind: 'income' })).toMatchObject({ ok: false, error: { code: 'INVALID', field: 'target' } })
  })

  it('gives the status as a result, and refuses too many months', async () => {
    const env = await setup()
    await env.open()
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    expect(await env.ask(BUDGET_CHANNELS.status, { budgetId: b.id, months: { from: '2027-03', to: '2027-03' } })).toMatchObject({ ok: true, value: { months: ['2027-03'] } })
    expect(await env.ask(BUDGET_CHANNELS.status, { budgetId: b.id, months: { from: '2025-01', to: '2027-03' } })).toMatchObject({ ok: false, error: { code: 'INVALID', field: 'months' } })
  })
})

describe('the budget plugin: the year, history and copies (B4)', () => {
  it('gives the year month by month, with the months that have their own amount and each month\'s totals', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(65000) })
    const set = await env.ask(BUDGET_CHANNELS.changeLine, { lineId: line.id, change: { apply: 'only', month: '2027-03', amount: 90000 } })
    expect(set.ok).toBe(true)
    const year = (await env.ask(BUDGET_CHANNELS.status, { budgetId: b.id, months: { from: '2027-01', to: '2027-12' }, byMonth: true })).value as BudgetStatus
    const groceries = year.rows.find(r => r.lineId === line.id)!
    expect(groceries.months!.map(m => m.budget)).toEqual([65000, 65000, 90000, ...Array(9).fill(65000)])
    expect(groceries.ownMonths).toEqual(['2027-03'])
    expect(year.monthlyTotals!.map(t => t.expenses.budget).slice(0, 4)).toEqual([65000, 65000, 90000, 65000])
    expect((await env.ask(BUDGET_CHANNELS.status, { budgetId: b.id, months: { from: '2027-03', to: '2027-03' } })).value).not.toHaveProperty('monthlyTotals')
  })

  it('fills a budget from the months before the month shown, through its dialog', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    for (const month of ['2026-12', '2027-01', '2027-02']) {
      await env.accounts.transactions(h.pchq.id).create({ date: `${month}-05`, amount: -61234, categoryId: h.category('Groceries') })
      await env.accounts.transactions(h.bchq.id).create({ date: `${month}-25`, amount: -300000, transferAccountId: h.pchq.id })
    }
    await env.idle()
    await env.ask(BUDGET_CHANNELS.select, { budgetId: b.id, month: '2027-03', period: 'month' })
    let asked: HistoryDialogInput | undefined
    env.prompts.show.mockImplementationOnce(async (id: unknown, input: unknown) => {
      expect(id).toBe(BUDGET_DIALOGS.history)
      asked = input as HistoryDialogInput
      const suggested = await env.ask(BUDGET_CHANNELS.suggest, { budgetId: b.id, months: 3, start: asked.start, step: 1000 })
      expect(suggested.value.map((x: LineSuggestion) => [x.label, x.amount, x.frequency])).toEqual([
        ['Business Chequing', 300000, 'monthly'], ['Food : Groceries', 62000, 'monthly']       // income first; expenses rounded up
      ])
      const lines = suggested.value.map((x: LineSuggestion) => ({ target: x.target, plan: { from: asked!.start, amount: x.amount, frequency: x.frequency, due: x.due } }))
      const filled = await env.ask(BUDGET_CHANNELS.fill, { budgetId: b.id, lines })
      return { count: filled.value.length }
    })
    expect(await env.run(C.fillFromHistory)).toEqual({ count: 2 })
    expect(asked).toMatchObject({ budget: { id: b.id }, start: '2027-03', months: DEFAULT_HISTORY_MONTHS, roundTo: DEFAULT_ROUND_TO })
    expect(env.prompts.show).toHaveBeenLastCalledWith(BUDGET_DIALOGS.history, expect.anything(), { title: 'Fill “Household” from History' })
    expect((await env.budgets.lines(b.id)).map(l => l.plans[0].amount)).toEqual([300000, 62000])
    // A line twice is refused as a whole, naming the one at fault
    const again = await env.ask(BUDGET_CHANNELS.fill, { budgetId: b.id, lines: [
      { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(1) }, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(2) }
    ] })
    expect(again).toMatchObject({ ok: false, error: { code: 'INVALID', field: 'lines[1].target' } })
  })

  it('goes from New Budget straight into Fill from History when asked', async () => {
    const env = await setup()
    await env.open()
    env.prompts.show.mockImplementationOnce(async () => {
      const saved = await env.ask(BUDGET_CHANNELS.saveBudget, { input: { name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 } })
      return { id: saved.value.id, fill: true }
    })
    env.prompts.show.mockResolvedValueOnce(undefined)
    const created = await env.run(C.newBudget) as { id: string }
    expect(created).toEqual({ id: expect.any(String) })
    expect(env.prompts.show.mock.calls.map(c => c[0])).toEqual([BUDGET_DIALOGS.budget, BUDGET_DIALOGS.history])
    expect(env.prompts.show.mock.calls[1][1]).toMatchObject({ budget: { id: created.id }, start: '2027-03' })
  })

  it('duplicates a budget under a name not taken, and shows the copy', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 4 })
    await env.budgets.create({ name: 'Household (2)', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(150000) })
    await env.budgets.changeLine(line.id, { apply: 'only', month: '2027-05', amount: 1 })
    await env.idle()
    let asked: DuplicateDialogInput | undefined
    env.prompts.show.mockImplementationOnce(async (_id: unknown, input: unknown) => {
      asked = input as DuplicateDialogInput
      expect(await env.ask(BUDGET_CHANNELS.duplicate, { id: b.id, name: 'household (2)' }))
        .toMatchObject({ ok: false, error: { code: 'DUPLICATE_NAME', field: 'name' } })
      const copy = await env.ask(BUDGET_CHANNELS.duplicate, { id: b.id, name: asked.name })
      return { id: copy.value.id }
    })
    const copy = await env.run(C.duplicate, { id: b.id }) as { id: string }
    expect(asked!.name).toBe('Household (3)')
    expect(env.prompts.show).toHaveBeenLastCalledWith(BUDGET_DIALOGS.duplicate, expect.anything(), { title: 'Duplicate “Household”' })
    expect(env.key(K.shown)).toBe(copy.id)
    expect(await env.budgets.get(copy.id)).toMatchObject({ name: 'Household (3)', yearStartMonth: 4 })
    expect((await env.budgets.lines(copy.id)).map(l => [l.plans, l.overrides])).toEqual([[line.plans, { '2027-05': 1 }]])
  })
})

describe('the budget plugin: the transactions behind a row', () => {
  it('lists exactly what a row\'s actual is made of, by the status\'s own rules, with Open Register on each', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const groceries = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(65000) })
    const t = env.accounts.transactions(h.pchq.id)
    await t.create({ date: '2027-03-03', amount: -5000, payee: 'Metro', categoryId: h.category('Groceries') })
    await t.create({ date: '2027-03-09', amount: -2500, payee: 'The Keg', categoryId: h.category('Dining out') })
    await t.create({ date: '2027-03-25', amount: 300000, payee: 'Me', transferAccountId: h.bchq.id })
    await t.create({ date: '2027-04-01', amount: -9900, payee: 'Metro', categoryId: h.category('Groceries') })
    await env.accounts.transactions(h.usVisa.id).create({ date: '2027-03-04', amount: -1000, categoryId: h.category('Groceries') })
    await env.idle()

    const months = { from: '2027-03', to: '2027-03' }
    const listed = async (row: TransactionsArgs['row'], label: string) => {
      env.prompts.show.mockResolvedValueOnce(undefined)
      await env.run(C.transactions, { budgetId: b.id, row, months, label, period: 'March 2027' } satisfies TransactionsArgs)
      const [id, input, options] = env.prompts.show.mock.calls.at(-1)!
      expect(id).toBe(BUDGET_DIALOGS.transactions)
      expect(options).toEqual({ title: `Transactions: ${label}` })
      return input as TransactionsDialogInput
    }
    // The line: March's groceries in Personal Chequing, not April's, nor the US card's (another currency)
    const line = await listed({ kind: 'line', group: 'expense', lineId: groceries.id }, 'Groceries')
    expect(line).toMatchObject({ row: 'Groceries', period: 'March 2027', currency: 'CAD', total: 5000, actual: 5000 })
    expect(line.rows).toEqual([expect.objectContaining({ date: '2027-03-03', accountName: 'Personal Chequing', payee: 'Metro', label: 'Food : Groceries', amount: 5000 })])
    // The Food subtotal: every line in its branch (the Keg isn't: Dining out has no line, so it is under Other)
    expect((await listed({ kind: 'subtotal', group: 'expense', categoryId: (await env.accounts.categories.list()).find(c => c.name === 'Food')!.id }, 'Food')).total).toBe(5000)
    expect((await listed({ kind: 'other', group: 'expense' }, 'Other expenses')).rows.map(r => r.payee)).toEqual(['The Keg'])
    // The owner's pay from the business: a transfer across the budget's scope, money in
    const pay = await listed({ kind: 'otherTransfers', group: 'income' }, 'Other transfers in')
    expect(pay.rows).toEqual([expect.objectContaining({ payee: 'Me', label: 'Transfer from: Business Chequing', amount: 300000 })])
    expect(pay).not.toHaveProperty('archived')
    // Each row names its account, for Open Register: the accounts plugin's command for other plugins
    expect(await env.run(ACCOUNTS_COMMANDS.openRegister, { id: pay.rows[0].accountId })).toBe(true)
    expect(env.reveals).toContain('accounts.register')
  })
})

describe('the budget plugin: keeping the views current', () => {
  it('tells the views once for a burst of transactions, and at once for its own changes', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    env.events.length = 0
    await env.accounts.transactions(h.pchq.id).createMany(Array.from({ length: 30 }, (_, i) => ({ date: '2027-03-01', amount: -100 - i })))
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-03-02', amount: -1 })
    await env.idle()
    expect(env.named(BUDGET_EVENTS.status).map(e => e.data)).toEqual([{ budgetId: null }])
    env.events.length = 0
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(1) })
    await env.idle()
    expect(env.named(BUDGET_EVENTS.status).map(e => e.data)).toEqual([{ budgetId: b.id }])
    // Nothing about the budgets list changed, so it isn't sent again
    expect(env.named(BUDGET_EVENTS.budgets)).toEqual([])
  })

  it('follows a sub-ledger renamed in what a budget covers', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.session.createSubLedger({ name: 'Kids', parentId: h.personal.id })
    await env.session.renameSubLedger(h.personal.id, 'Family')
    await env.idle()
    expect((env.named(BUDGET_EVENTS.budgets).at(-1)!.data as BudgetsView).budgets[0].covers).toBe('Family and its sub-ledgers')
  })
})

describe('the budget plugin: a ledger open read-only', () => {
  it('shows an archive file\'s budgets, says it is read-only, and offers nothing that changes it', async () => {
    const env = await setup()
    await env.open()
    const b = await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const archive = path.join(DIR, 'Tessera Backups', LEDGER_ARCHIVES_FOLDER, 'Home (archive before 2026-01-01).tesserabkp')
    const home = env.session.current!.path
    await (await env.engine.open({ path: home })).snapshot({ path: archive }, { meta: {
      [LEDGER_BACKUP_META.takenAt]: '2026-11-10T17:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: home, [LEDGER_BACKUP_META.takenWith]: 'test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
    } })
    const before = env.state.values.get('budget.shown')
    await env.session.open(archive)
    await env.idle()
    expect(await env.ask(BUDGET_CHANNELS.budgets)).toMatchObject({ shown: b.id, readOnly: true, archive: true })
    expect(env.enabled(C.show)).toBe(true)
    expect(env.enabled(C.transactions)).toBe(true)
    for (const command of [C.newBudget, C.properties, C.deleteBudget, C.newLine, C.editLine, C.deleteLine, C.duplicate, C.fillFromHistory]) {
      expect(env.enabled(command), command).toBe(false)
    }
    // Showing a budget in the archive doesn't touch what the ledger remembers
    await env.run(C.show, { id: b.id })
    expect(env.state.values.get('budget.shown')).toEqual(before)
    expect(env.log.error).not.toHaveBeenCalled()
  })
})

