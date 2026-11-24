// @vitest-environment node
// Show Transactions (phase R3): the transactions behind a figure, listed by the flows source with the same rules that
// made the figure. The test that matters: for every figure that can be listed in the five flows reports over the
// household's year, the transactions listed (and what archives hold) add up to exactly the figure. Then what each
// kind of row and column stands for (a parent's own, Other, a month, a running total, the period compared with, a
// sub-ledger side by side), the heading's picks, the limit, archived months, and what can't be listed.
import { describe, expect, it } from 'vitest'
import { DRILL_ROWS_MAX, type ColumnDrill, type ReportParameters, type ReportResult, type ResultRow } from '@tessera/reports-api'
import { household, proprietor } from './examples'
import { account, category, run, setupReports, type ReportsEnv } from './harness'

const YEAR = { period: { from: '2026-01-01', to: '2026-12-31' } } satisfies ReportParameters

/** The transactions behind a figure of a shipped report, as Show Transactions asks for them. */
const listed = (env: ReportsEnv, id: string, parameters: ReportParameters, row: ResultRow, column: ColumnDrill, options: Record<string, string | boolean> = {}) =>
  env.reports.transactions({ definitionId: `reports.${id}` }, parameters, options, row.drill!, column, row.currency)

/** Every figure of money (or count) that can be listed, in the columns given (default all), checked against its list. */
async function checkEvery(env: ReportsEnv, id: string, parameters: ReportParameters, result: ReportResult, columns?: number[]) {
  let checked = 0
  for (const row of result.rows) {
    if (!row.drill) continue
    for (const c of columns ?? result.columns.keys()) {
      const column = result.columns[c]
      const value = row.values[c]
      if (!column.drill || value === null || column.unit === 'percent') continue
      const found = await listed(env, id, parameters, row, column.drill)
      const what = `${id}: ${row.label} × ${column.group ?? ''} ${column.label}`
      if (column.unit === 'count') expect(found.total, what).toBe(value)
      else expect(found.transactions.reduce((sum, t) => sum + t.amount, 0) + (found.archived?.amount ?? 0), what).toBe(value)
      expect(found.total, what).toBe(found.transactions.length)
      checked++
    }
  }
  return checked
}

describe('the transactions behind every figure add up to it', () => {
  it.each([
    ['incomeVsExpenses', [0, 2, 11, 12]],
    ['spendingByCategory', undefined],
    ['categoryTrends', [0, 5, 12]],
    ['cashFlow', [2, 12]]
  ] as const)('in %s over the household’s year', async (id, columns) => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, id, YEAR)
    expect(await checkEvery(env, id, YEAR, result, columns ? [...columns] : undefined)).toBeGreaterThanOrEqual(10)
  })

  it('in Spending by Payee: the top payees, Other payees and No payee, by amount and by count', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'spendingByPayee', YEAR)
    const rows = result.rows.filter(r => r.kind === 'other' || r.kind === 'none' || r.kind === 'total' || result.rows.indexOf(r) < 5)
    expect(rows.map(r => r.kind)).toEqual(expect.arrayContaining(['other', 'none', 'total']))
    expect(await checkEvery(env, 'spendingByPayee', YEAR, { ...result, rows })).toBeGreaterThanOrEqual(rows.length * 2)
  })
})

describe('what a figure stands for', () => {
  it('a net lists income as it adds and expenses as they take away, so the list adds up to the net', async () => {
    const env = await setupReports()
    await household(env)
    const parameters = { period: { from: '2026-03-01', to: '2026-03-31' } }
    const result = await run(env, 'incomeVsExpenses', parameters)
    const net = result.rows.find(r => r.kind === 'net')!
    expect(net.drill).toEqual({ keys: ['income', 'expense'], signed: true })
    const found = await listed(env, 'incomeVsExpenses', parameters, net, result.columns[0].drill!)
    const salary = found.transactions.find(t => t.payee === 'Northwind Ltd')!
    const rent = found.transactions.find(t => t.payee === 'Riverside Properties')!
    expect([salary.amount, rent.amount]).toEqual([420000, -150000])
    expect(found.transactions.reduce((s, t) => s + t.amount, 0)).toBe(net.values[0])
  })

  it('a parent’s own row lists what is in the parent alone, not its children', async () => {
    const env = await setupReports()
    const chq = await env.accounts.createAccount(account('Chequing', null))
    const food = await category(env, 'Food')
    const groceries = await category(env, 'Food : Groceries')
    await env.accounts.transactions(chq.id).createMany([
      { date: '2026-03-02', amount: -5000, categoryId: food, payee: 'Market' },
      { date: '2026-03-03', amount: -7000, categoryId: groceries, payee: 'FreshCo' }
    ])
    const parameters = { period: { from: '2026-03-01', to: '2026-03-31' } }
    const result = await run(env, 'spendingByCategory', parameters, { detail: 'all' })
    const own = result.rows.find(r => r.kind === 'own')!
    const parent = result.rows.find(r => r.label === 'Food')!
    expect(own).toMatchObject({ label: 'Food (other)', drill: { keys: [food], own: true } })
    const ownList = await listed(env, 'spendingByCategory', parameters, own, result.columns[0].drill!, { detail: 'all' })
    expect(ownList.transactions.map(t => [t.payee, t.amount])).toEqual([['Market', 5000]])
    const all = await listed(env, 'spendingByCategory', parameters, parent, result.columns[0].drill!, { detail: 'all' })
    expect(all.transactions.map(t => t.payee)).toEqual(['Market', 'FreshCo'])
  })

  it('a month’s column lists that month; the total column the period; a running total up to its month', async () => {
    const env = await setupReports()
    const { cat } = await household(env)
    const result = await run(env, 'categoryTrends', { period: { from: '2026-01-01', to: '2026-06-30' } })
    const food = result.rows.find(r => r.drill?.keys?.[0] !== undefined && r.label === 'Food')!
    expect(result.columns[2].drill).toEqual({ measure: 'amount', months: ['2026-03'] })
    const march = await listed(env, 'categoryTrends', { period: { from: '2026-01-01', to: '2026-06-30' } }, food, result.columns[2].drill!)
    expect(new Set(march.transactions.map(t => t.date.slice(0, 7)))).toEqual(new Set(['2026-03']))
    const upToMarch = await listed(env, 'categoryTrends', { period: { from: '2026-01-01', to: '2026-06-30' } }, food, { measure: 'amount', months: ['2026-01', '2026-02', '2026-03'] })
    expect(upToMarch.transactions.reduce((s, t) => s + t.amount, 0)).toBe(food.values.slice(0, 3).reduce((a, b) => a! + b!, 0))
    expect(cat.groceries).toBeDefined()
  })

  it('a compared column lists the period compared with', async () => {
    const env = await setupReports()
    await household(env)
    const parameters: ReportParameters = { period: { from: '2026-07-01', to: '2026-12-31' }, compare: 'previousPeriod' }
    const result = await run(env, 'spendingByCategory', parameters)
    const compared = result.columns.findIndex(c => c.drill?.compared)
    expect(compared).toBeGreaterThan(0)
    const housing = result.rows.find(r => r.label === 'Housing')!
    const found = await listed(env, 'spendingByCategory', parameters, housing, result.columns[compared].drill!)
    expect(found.transactions.every(t => t.date >= '2026-01-01' && t.date <= '2026-06-30')).toBe(true)
    expect(found.transactions.reduce((s, t) => s + t.amount, 0)).toBe(housing.values[compared])
    // A change isn't a sum of transactions: it can't be listed
    expect(result.columns.find(c => c.label === 'Change')!.drill).toBeUndefined()
  })

  it('a sub-ledger’s column, side by side, lists that sub-ledger’s: a transfer between two counts in each', async () => {
    const env = await setupReports()
    await proprietor(env)
    const parameters: ReportParameters = { period: { from: '2026-03-01', to: '2026-03-31' }, compare: 'subLedgers' }
    const result = await run(env, 'incomeVsExpenses', parameters)
    expect(result.columns.map(c => c.drill?.scope)).toEqual([0, 1, 2])
    expect(await checkEvery(env, 'incomeVsExpenses', parameters, result)).toBeGreaterThan(5)
  })

  it('the heading’s picks narrow every list as they narrow the figures', async () => {
    const env = await setupReports()
    const { cat } = await household(env)
    const food = (await env.accounts.categories.list()).find(c => c.name === 'Food')!.id
    const parameters: ReportParameters = { ...YEAR, chosen: { category: [food] } }
    const result = await run(env, 'categoryTrends', parameters)
    expect(result.rows.filter(r => r.kind === 'member').map(r => r.label)).toEqual(['Food'])
    const row = result.rows.find(r => r.label === 'Food')!
    const found = await listed(env, 'categoryTrends', parameters, row, result.columns[4].drill!)
    expect(found.transactions.reduce((s, t) => s + t.amount, 0)).toBe(row.values[4])
    expect(new Set(found.transactions.map(t => t.label))).toEqual(new Set(['Food : Groceries', 'Food : Dining out']))
    expect(cat.dining).toBeDefined()
  })
})

describe('listing', () => {
  it('lists in date order, at most the limit, saying how many there are', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'spendingByCategory', YEAR)
    const total = result.rows.find(r => r.kind === 'total')!
    const found = await listed(env, 'spendingByCategory', YEAR, total, result.columns[0].drill!)
    expect(found.transactions.map(t => t.date)).toEqual([...found.transactions.map(t => t.date)].sort())
    expect(found.total).toBeLessThanOrEqual(DRILL_ROWS_MAX)
    const few = await env.flows.transactions({
      sourceId: 'reports.flows', period: YEAR.period, currency: 'CAD', filters: [{ dimension: 'group', in: ['expense'] }], parameters: {},
      key: { keys: {} }, measure: 'amount', limit: 10
    })
    expect(few.transactions).toHaveLength(10)
    expect(few.total).toBe(found.total)
  })

  it('says how much of a figure archived months hold, which can’t be listed', async () => {
    const env = await setupReports()
    await household(env)
    // Reconciled before April, so the archive takes it
    for (const a of await env.accounts.list()) {
      const t = env.accounts.transactions(a.id)
      const ids = (await t.list()).filter(x => x.date < '2026-04-01').map(x => x.id)
      if (ids.length > 0) await t.setStatus(ids, 'reconciled', { confirm: ['reconciled'] })
    }
    await env.archive('2026-04-01')
    const parameters = { period: { from: '2026-01-01', to: '2026-06-30' } }
    const result = await run(env, 'spendingByCategory', parameters)
    const food = result.rows.find(r => r.label === 'Food')!
    const found = await listed(env, 'spendingByCategory', parameters, food, result.columns[0].drill!)
    expect(found.archived).toEqual({ amount: expect.any(Number), before: '2026-04-01' })
    expect(found.transactions.every(t => t.date >= '2026-04-01')).toBe(true)
    expect(found.transactions.reduce((s, t) => s + t.amount, 0) + found.archived!.amount).toBe(food.values[0])
  })
})

describe('what can’t be listed', () => {
  it('balances have no list, and a balance report’s figures carry no drill', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'netWorth')
    expect(result.rows.every(r => r.drill === undefined)).toBe(true)
    expect(result.columns.every(c => c.drill === undefined)).toBe(true)
    await expect(env.reports.transactions({ definitionId: 'reports.netWorth' }, {}, {}, { keys: ['asset'] }, { measure: 'balance' }))
      .rejects.toMatchObject({ code: 'NO_SOURCE' })
  })

  it('a figure that no run of the report would have is refused as invalid', async () => {
    const env = await setupReports()
    await household(env)
    const ref = { definitionId: 'reports.incomeVsExpenses' }
    const row = { keys: ['income'] }
    for (const column of [
      { measure: 'balance' }, { measure: 'amount', months: ['2026-13'] }, { measure: 'amount', months: [] }, { measure: 'amount', scope: 3 },
      { measure: 'amount', months: ['2030-01'] }
    ] as ColumnDrill[]) {
      await expect(env.reports.transactions(ref, YEAR, {}, row, column), JSON.stringify(column)).rejects.toMatchObject({ code: 'INVALID' })
    }
    await expect(env.reports.transactions(ref, YEAR, {}, { keys: 'income' } as never, { measure: 'amount' })).rejects.toMatchObject({ code: 'INVALID' })
  })
})
