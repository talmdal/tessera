// @vitest-environment node
// Budget vs Actual (phase R5), the first report another plugin adds: the budget plugin's source over its status, and
// its definition, through the reports plugin's points. What matters: the report's figures are the status's, row for
// row and month by month, for a month, the year to date and the year, with the budget view's own example (March 2027
// of Household, docs/budget-design.md, "The budget view") figure for figure; drilling lists what the budget's
// Transactions dialog lists; it is offered only while a budget exists; either plugin works without the other.
import { describe, expect, it } from 'vitest'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS as BC, BUDGET_REPORTS, type Budget, type BudgetStatus, type LinePlan, type StatusRow
} from '@tessera/budget-api'
import {
  REPORTS_CHANNELS, REPORTS_SERVICE, ratio, showCommandOf,
  type ReportParameters, type ReportResult, type ReportsCatalog, type ReportsService
} from '@tessera/reports-api'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import type { MenuNode, SubmenuNode } from '../../../shared/menus/types'
import { reportCsv } from '../../../plugins/reports/src/privileged/csv'
import { household, setup, type Env } from './app'

const plan = (amount: number, over: Partial<LinePlan> = {}): LinePlan => ({ from: '2027-01', amount, frequency: 'monthly', due: '2027-01', ...over })
const MARCH = { period: { from: '2027-03-01', to: '2027-03-31' } }

/**
 * The budget view's example: Household over Personal, in CAD, and March 2027's transactions (with January and February
 * for the year to date).
 */
async function example(env: Env) {
  const h = await household(env)
  const { category, pchq } = h
  const budget = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
  const line = (name: string, p: LinePlan) => env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category(name) }, plan: p })
  await line('Salary', plan(210000, { frequency: 'twiceAMonth', due: '2027-01-05', secondDay: 19 }))
  await line('Interest', plan(1500))
  await env.budgets.addLine(budget.id, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'in' }, plan: plan(300000, { due: '2027-01-25' }) })
  await line('Groceries', plan(65000))
  await line('Food', plan(15000))
  await line('Rent', plan(150000, { due: '2027-01-01' }))
  await line('Home insurance', plan(120000, { frequency: 'yearly', due: '2027-03-15' }))
  await line('Public transit', plan(3500, { frequency: 'weekly', due: '2027-03-01', from: '2027-03' }))
  const t = env.accounts.transactions(pchq.id)
  const march = [
    { date: '2027-03-05', amount: 210000, categoryId: category('Salary'), payee: 'Northwind Ltd' },
    { date: '2027-03-19', amount: 210000, categoryId: category('Salary'), payee: 'Northwind Ltd' },
    { date: '2027-03-31', amount: 1240, categoryId: category('Interest') },
    { date: '2027-03-16', amount: 15000, categoryId: category('Gifts received') },
    ...[-20000, -19830, -20000].map((amount, i) => ({ date: `2027-03-0${i + 2}`, amount, categoryId: category('Groceries'), payee: 'FreshCo' })),
    { date: '2027-03-09', amount: -26385, categoryId: category('Dining out'), payee: 'Corner Café' },
    { date: '2027-03-01', amount: -150000, categoryId: category('Rent'), payee: 'Riverside Properties' },
    { date: '2027-03-15', amount: -118700, categoryId: category('Home insurance') },
    ...[-3500, -3500, -3500, -3500].map((amount, i) => ({ date: `2027-03-${String(1 + i * 7).padStart(2, '0')}`, amount, categoryId: category('Public transit') })),
    { date: '2027-03-20', amount: -8620, categoryId: category('Entertainment') },
    { date: '2027-03-22', amount: -4100 }
  ]
  await t.createMany([
    ...march,
    // The months before, for the year to date
    { date: '2027-01-05', amount: 420000, categoryId: category('Salary') }, { date: '2027-02-05', amount: 400000, categoryId: category('Salary') },
    { date: '2027-01-10', amount: -70000, categoryId: category('Groceries') }, { date: '2027-02-10', amount: -61000, categoryId: category('Groceries') }
  ])
  // The owner's pay, from Business: a transfer into the budget's scope
  await env.accounts.transactions(h.bchq.id).create({ date: '2027-03-25', amount: -300000, transferAccountId: pchq.id })
  await env.accounts.transactions(h.usVisa.id).create({ date: '2027-03-18', amount: -30000, categoryId: category('Travel') })
  await env.idle()
  return { ...h, budget }
}

const reportsOf = (env: Env) => env.runtime.services.get<ReportsService>(REPORTS_SERVICE)
const run = (env: Env, budget: Budget, parameters: ReportParameters = MARCH, options?: Record<string, string | boolean>) =>
  reportsOf(env).run({ definitionId: BUDGET_REPORTS.vsActual }, { ...parameters, source: { budget: budget.id } }, options)

/** The status rows a report shows, as its rows: every row but a line with nothing (the budget view leaves those out). */
const shownRows = (status: BudgetStatus) => status.rows.filter(r => r.figures.budget !== 0 || r.figures.actual !== 0 || r.kind === 'subtotal')
const figures = (row: StatusRow | undefined) => row ? [row.figures.budget, row.figures.actual, row.figures.remaining] : undefined
const members = (result: ReportResult) => result.rows.filter(r => !['heading', 'net'].includes(r.kind) && !r.id.startsWith('total:'))

/** The report's rows and figures against the status's, row for row: labels in order, then Budget, Actual, Remaining, % used. */
function sameAsStatus(result: ReportResult, status: BudgetStatus) {
  const rows = shownRows(status)
  expect(members(result).map(r => r.label)).toEqual(rows.map(r => r.label))
  members(result).forEach((r, i) => {
    const s = rows[i]
    expect(r.values, r.label).toEqual([s.figures.budget, s.figures.actual, s.figures.remaining, ratio(s.figures.actual, s.figures.budget)])
  })
  const row = (id: string) => result.rows.find(r => r.id === id)!
  expect(row('total:income').values.slice(0, 3)).toEqual(figures({ figures: status.totals.income } as StatusRow))
  expect(row('total:expense').values.slice(0, 3)).toEqual(figures({ figures: status.totals.expenses } as StatusRow))
  expect(row('net:0').values).toEqual([status.totals.net.budget, status.totals.net.actual, status.totals.net.remaining, null])
}

describe('Budget vs Actual', () => {
  it('gives the budget view’s March, figure for figure, and its layout: income, expenses, their totals and the net', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget, usVisa } = await example(env)
    const result = await run(env, budget)
    expect(result).toMatchObject({ title: 'Budget vs Actual', subtitle: 'March 2027 · Household · Personal · CAD', currency: 'CAD' })
    expect(result.columns.map(c => [c.label, c.unit])).toEqual([['Budget', 'money'], ['Actual', 'money'], ['Remaining', 'money'], ['% used', 'percent']])
    const lines = result.rows.map(r => [`${'  '.repeat(r.depth - 1)}${r.label}`, ...r.values.slice(0, 3).map(v => v === null ? '' : (v / 100).toFixed(2))])
    expect(lines).toEqual([
      // In the budget view's order: categories by name (the design's drawing put Salary first)
      ['Income', '', '', ''],
      ['  Interest', '15.00', '12.40', '2.60'],
      ['  Salary', '4200.00', '4200.00', '0.00'],
      ['  Transfers from Business Chequing', '3000.00', '3000.00', '0.00'],
      ['  Other income', '0.00', '150.00', '-150.00'],
      ['Total income', '7215.00', '7362.40', '-147.40'],
      ['Expenses', '', '', ''],
      ['  Food', '800.00', '862.15', '-62.15'],
      ['    Groceries', '650.00', '598.30', '51.70'],
      ['    Food (other)', '150.00', '263.85', '-113.85'],
      ['  Housing', '2700.00', '2687.00', '13.00'],
      ['    Home insurance', '1200.00', '1187.00', '13.00'],
      ['    Rent', '1500.00', '1500.00', '0.00'],
      ['  Transportation', '175.00', '140.00', '35.00'],
      ['    Public transit', '175.00', '140.00', '35.00'],
      ['  Other expenses', '0.00', '86.20', '-86.20'],
      ['  Uncategorised', '0.00', '41.00', '-41.00'],
      ['Total expenses', '3675.00', '3816.35', '-141.35'],
      ['Net', '3540.00', '3546.05', '6.05']
    ])
    // Red where the budget view is red: expenses' negative figures and the net's; never income's
    const bad = (label: string) => result.rows.find(r => r.label === label)?.negativeIsBad === true
    expect(['Food', 'Food (other)', 'Other expenses', 'Uncategorised', 'Total expenses', 'Net'].every(bad)).toBe(true)
    expect(['Other income', 'Total income', 'Salary'].some(bad)).toBe(false)
    // % used, to a tenth, rounded down
    expect(result.rows.find(r => r.label === 'Food (other)')!.values[3]).toBe(17590)
    expect(result.notes).toEqual([{ tone: 'info', text: 'Not counted: US Visa, in USD.' }])
    expect(usVisa).toBeDefined()
    // The chart: budget beside actual, for the expense lines
    expect(result.chart).toEqual({
      kind: 'groupedBar', categories: ['Food', 'Housing', 'Transportation', 'Other expenses', 'Uncategorised'], unit: 'money',
      series: [
        { key: 'm0', label: 'Budget', values: [80000, 270000, 17500, 0, 0], as: 'bar' },
        { key: 'm1', label: 'Actual', values: [86215, 268700, 14000, 8620, 4100], as: 'bar' }
      ]
    })
  })

  it.each([
    ['a month', { from: '2027-03', to: '2027-03' }],
    ['the year to date', { from: '2027-01', to: '2027-03' }],
    ['the year', { from: '2027-01', to: '2027-12' }]
  ])('equals the status row for row over %s', async (_name, months) => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const status = await env.budgets.status(budget.id, months)
    const result = await run(env, budget, { period: { from: `${months.from}-01`, to: `${months.to}-31` } })
    sameAsStatus(result, status)
  })

  it('equals the status month by month, with months across and their total, in each figure', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const months = { from: '2027-01', to: '2027-03' }
    const status = await env.budgets.status(budget.id, months, { byMonth: true })
    for (const [figure, index] of [['budget', 0], ['actual', 1], ['remaining', 2]] as const) {
      const result = await run(env, budget, { period: { from: '2027-01-01', to: '2027-03-31' } }, { layout: figure })
      expect(result.columns.map(c => c.label)).toEqual(['Jan 2027', 'Feb 2027', 'Mar 2027', 'Total'])
      const rows = status.rows.filter(r => r.months!.some(m => m.budget !== 0 || m.actual !== 0) || r.kind === 'subtotal')
      expect(members(result).map(r => r.label)).toEqual(rows.map(r => r.label))
      members(result).forEach((r, i) => {
        const wanted = rows[i].months!.map(m => [m.budget, m.actual, m.remaining][index])
        expect(r.values, `${figure} ${r.label}`).toEqual([...wanted, [rows[i].figures.budget, rows[i].figures.actual, rows[i].figures.remaining][index]])
      })
      const net = result.rows.find(r => r.kind === 'net')!
      expect(net.values, figure).toEqual([...status.monthlyTotals!.map(t => [t.net.budget, t.net.actual, t.net.remaining][index]),
        [status.totals.net.budget, status.totals.net.actual, status.totals.net.remaining][index]])
      expect(result.chart).toBeUndefined()
    }
  })

  it('shows the expense lines alone when asked, with no net', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const result = await run(env, budget, MARCH, { expensesOnly: true })
    expect(result.rows[0].label).toBe('Expenses')
    expect(result.rows.some(r => r.kind === 'net' || r.label === 'Income')).toBe(false)
  })

  it('takes a period of whole months, saying so when the one chosen cuts a month', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const result = await run(env, budget, { period: { from: '2027-03-10', to: '2027-03-20' } })
    expect(result.period).toEqual({ from: '2027-03-01', to: '2027-03-31' })
    expect(result.notes).toContainEqual({ tone: 'info', text: '“Budget” is kept by whole months, so this shows March 2027.' })
    await expect(run(env, budget, { period: { from: '2025-01-01', to: '2027-03-31' } })).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })
})

describe('Budget vs Actual as CSV (R6)', () => {
  it('is written by the reports\' Export Report… as the budget view reads: lines by their paths, exact amounts, % used as a decimal', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const csv = reportCsv(await run(env, budget), { rowsLabel: 'Line' })
    expect(csv.text.split('\r\n').filter(Boolean)).toEqual([
      'Line,Budget,Actual,Remaining,% used',
      'Income,,,,',
      'Income : Interest,15.00,12.40,2.60,82.66',
      'Income : Salary,4200.00,4200.00,0.00,100.00',
      'Income : Transfers from Business Chequing,3000.00,3000.00,0.00,100.00',
      'Income : Other income,0.00,150.00,-150.00,',
      'Total income,7215.00,7362.40,-147.40,102.04',
      'Expenses,,,,',
      'Expenses : Food,800.00,862.15,-62.15,107.76',
      'Expenses : Food : Groceries,650.00,598.30,51.70,92.04',
      'Expenses : Food : Food (other),150.00,263.85,-113.85,175.90',
      'Expenses : Housing,2700.00,2687.00,13.00,99.51',
      'Expenses : Housing : Home insurance,1200.00,1187.00,13.00,98.91',
      'Expenses : Housing : Rent,1500.00,1500.00,0.00,100.00',
      'Expenses : Transportation,175.00,140.00,35.00,80.00',
      'Expenses : Transportation : Public transit,175.00,140.00,35.00,80.00',
      'Expenses : Other expenses,0.00,86.20,-86.20,',
      'Expenses : Uncategorised,0.00,41.00,-41.00,',
      'Total expenses,3675.00,3816.35,-141.35,103.84',
      'Net,3540.00,3546.05,6.05,'
    ])
  })
})

describe('the transactions behind an actual', () => {
  it('are what the budget’s own Transactions dialog lists, for a line, a subtotal, a parent’s own line and Other', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    const ref = { definitionId: BUDGET_REPORTS.vsActual }
    const parameters = { ...MARCH, source: { budget: budget.id } }
    const result = await reportsOf(env).run(ref, parameters)
    const actual = result.columns[1].drill!
    expect(actual).toEqual({ measure: 'actual' })
    // The plan, what is left and the per cent have nothing behind them to list
    expect([result.columns[0].drill, result.columns[2].drill, result.columns[3].drill]).toEqual([undefined, undefined, undefined])
    await env.run('reports.show', ref)
    const status = await env.budgets.status(budget.id, { from: '2027-03', to: '2027-03' })
    const statusRow = (label: string) => status.rows.find(r => r.label === label)!

    /** What a dialog was given: the report's, or the budget's own. */
    const dialogInput = async (command: string, args: unknown) => {
      env.prompts.show.mockClear()
      await env.run(command, args)
      return env.prompts.show.mock.calls[0][1] as any
    }
    const fromReport = async (label: string) => {
      const row = result.rows.find(r => r.label === label)!
      const input = await dialogInput('reports.transactions', { ref, parameters, options: {}, row: row.drill, column: actual, currency: 'CAD', label, columnLabel: 'March 2027', figure: row.values[1] })
      return { figure: row.values[1], listed: input.result.transactions.map((t: { id: string, amount: number }) => [t.id, t.amount]) }
    }
    const fromBudget = async (label: string) => {
      const s = statusRow(label)
      const row = { kind: s.kind, group: s.group, ...(s.lineId && { lineId: s.lineId }), ...(s.categoryId && { categoryId: s.categoryId }) }
      const input = await dialogInput(BC.transactions, { budgetId: budget.id, row, months: { from: '2027-03', to: '2027-03' }, label, period: 'March 2027' })
      return input.rows.map((t: { transactionId: string, amount: number }) => [t.transactionId, t.amount])
    }
    for (const label of ['Groceries', 'Food', 'Food (other)', 'Home insurance', 'Other expenses', 'Uncategorised', 'Other income', 'Transfers from Business Chequing']) {
      const report = await fromReport(label)
      expect(report.listed, label).toEqual(await fromBudget(label))
      expect(report.listed.reduce((sum: number, [, amount]: [string, number]) => sum + amount, 0), label).toBe(report.figure)
    }
    // A group's total, and the net (expenses taking away), add up to their figures too
    for (const label of ['Total income', 'Total expenses', 'Net']) {
      const report = await fromReport(label)
      expect(report.listed.reduce((sum: number, [, amount]: [string, number]) => sum + amount, 0), label).toBe(report.figure)
    }
  })
})

describe('offered by another plugin', () => {
  /** The Reports menu as the shell draws it. */
  const reportsMenu = (env: Env) => {
    const { menus } = resolveMenus(env.runtime.extensions.getContributions('shell.menus').map(c => c.impl))
    const draw = (nodes: MenuNode[]): unknown[] => nodes.map(n => n.type === 'separator' ? '—' : n.type === 'submenu' ? [n.label, draw(n.children)] : n.label)
    return draw(normalizeMenuNodes((menus.find(m => m.id === 'reports.menu') as SubmenuNode).children))
  }

  it.each(['before', 'after'] as const)('reaches the reports whichever activates first (reports %s the budget): in the tab and the menu, under Budgets', async order => {
    const env = await setup({ reports: order })
    expect(reportsMenu(env)).toContainEqual(['Budgets', ['Budget vs Actual']])
    await env.open()
    const catalog: ReportsCatalog = await env.ask(REPORTS_CHANNELS.catalog)
    expect(catalog.groups.map(g => g.label)).toEqual(['Income and Spending', 'Net Worth and Balances', 'Budgets'])
    expect(catalog.definitions.find(d => d.id === BUDGET_REPORTS.vsActual)).toMatchObject({ label: 'Budget vs Actual', group: BUDGET_REPORTS.group })
    expect(env.log.warn.mock.calls.filter(c => String(c[0]).includes('[reports]'))).toEqual([])
  })

  it('is offered only while the ledger has a budget', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const entry = async () => ((await env.ask(REPORTS_CHANNELS.catalog)) as ReportsCatalog).definitions.find(d => d.id === BUDGET_REPORTS.vsActual)
    expect(await entry()).toMatchObject({ enabled: false })
    expect(env.enabled(showCommandOf(BUDGET_REPORTS.vsActual))).toBe(false)
    const h = await household(env)
    const budget = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    expect(await entry()).toMatchObject({ enabled: true })
    expect(env.enabled(showCommandOf(BUDGET_REPORTS.vsActual))).toBe(true)
    await env.budgets.delete(budget.id)
    await env.idle()
    expect(await entry()).toMatchObject({ enabled: false })
  })

  it('offers the budgets to choose from, the one the budget view shows first', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const h = await household(env)
    const first = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const business = await env.budgets.create({ name: 'Business', subLedgerId: h.business.id, currency: 'CAD', yearStartMonth: 1 })
    await env.run(BC.show, { id: business.id })
    const reply = await env.ask(REPORTS_CHANNELS.members, { ref: { definitionId: BUDGET_REPORTS.vsActual }, parameter: 'budget', parameters: {} })
    expect(reply.value).toEqual([{ id: business.id, label: 'Business', isDefault: true }, { id: first.id, label: 'Household' }])
    // With none chosen, the report is of the budget the view shows
    expect((await reportsOf(env).run({ definitionId: BUDGET_REPORTS.vsActual }, MARCH)).subtitle).toBe('March 2027 · Business · Business · CAD')
  })

  it('shows the budget shown, over the months shown, from the budget view’s Show as Report', async () => {
    const env = await setup({ reports: 'after' })
    await env.open()
    const { budget } = await example(env)
    await env.run(BC.show, { id: budget.id })
    await env.ask(BUDGET_CHANNELS.select, { budgetId: budget.id, month: '2027-03', period: 'yearToDate' })
    const view = await env.ask(BUDGET_CHANNELS.budgets)
    expect(view.reports).toBe(true)
    expect(await env.run(BC.showReport)).toBe(true)
    const catalog: ReportsCatalog = await env.ask(REPORTS_CHANNELS.catalog)
    expect(catalog.shown).toMatchObject({
      ref: { definitionId: BUDGET_REPORTS.vsActual }, parameters: { source: { budget: budget.id }, period: { from: '2027-01-01', to: '2027-03-31' } }
    })
  })

  it('leaves the budget as it was without the reports plugin, and the reports as they were without the budget', async () => {
    const env = await setup()
    await env.open()
    const { budget } = await example(env)
    await env.run(BC.show, { id: budget.id })
    expect((await env.ask(BUDGET_CHANNELS.budgets)).reports).toBe(false)
    expect(await env.run(BC.showReport)).toBe(false)
    expect(env.log.warn.mock.calls).toEqual([])
    expect(env.log.error.mock.calls).toEqual([])
  })
})
