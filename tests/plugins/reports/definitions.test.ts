// @vitest-environment node
// The seven reports the reports plugin ships, each run on ledgers built in the test, with its figures written out as
// docs/reporting-design.md's worked examples write them: every example figure in the note is produced here. And the
// identities across reports: Cash Flow's opening + net + opened = closing; Spending by Payee's total is Spending by
// Category's; every option of every definition validates against its source. See "The eight reports".
import { describe, expect, it } from 'vitest'
import { definitionProblems, type ReportResult } from '@tessera/reports-api'
import { BALANCES_CONTRIBUTION } from '../../../plugins/reports/src/privileged/balances'
import { DEFINITIONS } from '../../../plugins/reports/src/privileged/definitions'
import { FLOWS_CONTRIBUTION } from '../../../plugins/reports/src/privileged/flows'
import { ASSETS, LIABILITIES, household, mortgaged } from './examples'
import { account, headings, run, setupReports, table } from './harness'

const YEAR_2026 = { period: { from: '2026-01-01', to: '2026-12-31' } }
const plain = (s: string) => s.replace(/[\u2009\u202f\u00a0]/g, ' ')
const byLabel = (result: ReportResult, label: string) => result.rows.find(r => r.label === label)!

describe('the shipped definitions', () => {
  it('are seven, each valid against its source with every option\'s every value, naming nothing in a ledger', () => {
    expect(DEFINITIONS.map(d => d.id)).toEqual([
      'reports.incomeVsExpenses', 'reports.spendingByCategory', 'reports.spendingByPayee', 'reports.categoryTrends', 'reports.cashFlow',
      'reports.netWorth', 'reports.accountBalances'
    ])
    for (const definition of DEFINITIONS) {
      const source = definition.spec.source === FLOWS_CONTRIBUTION.id ? FLOWS_CONTRIBUTION : BALANCES_CONTRIBUTION
      expect(definitionProblems(definition, source, 'reports'), definition.id).toEqual([])
    }
  })

  it('are all offered, in their groups, with no warning', async () => {
    const env = await setupReports()
    expect(env.reports.definitions().map(d => [d.group.label, d.label, d.available])).toEqual([
      ['Income and Spending', 'Income vs Expenses', true], ['Income and Spending', 'Spending by Category', true],
      ['Income and Spending', 'Spending by Payee', true], ['Income and Spending', 'Category Trends', true], ['Income and Spending', 'Cash Flow', true],
      ['Net Worth and Balances', 'Net Worth', true], ['Net Worth and Balances', 'Account Balances', true]
    ])
    expect(env.log.warn).not.toHaveBeenCalled()
  })
})

describe('1. Income vs Expenses', () => {
  it('gives the note\'s January to March 2026: income and expenses by top-level category, months across, and Net income', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'incomeVsExpenses', { period: { from: '2026-01-01', to: '2026-03-31' } })
    expect(plain(result.subtitle)).toBe(plain(`${result.subtitle.split(' · ')[0]} · Whole ledger · CAD`))
    expect(headings(result)).toEqual([...result.columns.slice(0, 3).map(c => c.label), 'Total'])
    expect(table(result)).toEqual([
      ['Income', '—', '—', '—', '—'],
      ['  Salary', '4200.00', '4200.00', '4200.00', '12600.00'],
      ['  Interest', '12.40', '11.85', '12.10', '36.35'],
      ['Total income', '4212.40', '4211.85', '4212.10', '12636.35'],
      ['Expenses', '—', '—', '—', '—'],
      ['  Housing', '1500.00', '1500.00', '1500.00', '4500.00'],
      ['  Food', '812.35', '745.10', '862.15', '2419.60'],
      ['  Transportation', '140.00', '140.00', '175.00', '455.00'],
      ['  Uncategorised', '—', '—', '41.00', '41.00'],
      ['Total expenses', '2452.35', '2385.10', '2578.15', '7415.60'],
      ['Net income', '1760.05', '1826.75', '1633.95', '5220.75']
    ])
    // Over the whole ledger the RRSP transfer is inside: no transfers, so no Net after transfers, which would repeat it
    expect(result.rows.some(r => r.label.startsWith('Transfers') || r.label === 'Net after transfers')).toBe(false)
    // Grouped bars of income and expenses, with the net as a line
    expect(result.chart?.series.map(s => [s.label, s.as, s.values])).toEqual([
      ['Income', 'bar', [421240, 421185, 421210]], ['Expenses', 'bar', [245235, 238510, 257815]], ['Net income', 'line', [176005, 182675, 163395]]
    ])
  })

  it('offers totals only, every category, quarters, no chart, and leaving transfers out', async () => {
    const env = await setupReports()
    await household(env)
    const q1 = { period: { from: '2026-01-01', to: '2026-03-31' } }
    expect(table(await run(env, 'incomeVsExpenses', q1, { detail: 'groups' }))).toEqual([
      ['Income', '4212.40', '4211.85', '4212.10', '12636.35'], ['Expenses', '2452.35', '2385.10', '2578.15', '7415.60'], ['Net income', '1760.05', '1826.75', '1633.95', '5220.75']
    ])
    const all = await run(env, 'incomeVsExpenses', q1, { detail: 'all' })
    expect(table(all).slice(4, 9).map(r => r[0])).toEqual(['Expenses', '  Housing', '    Rent', '  Food', '    Groceries'])
    const quarters = await run(env, 'incomeVsExpenses', YEAR_2026, { columns: 'quarter' })
    expect(headings(quarters)).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026', 'Total'])
    expect(byLabel(quarters, 'Net income').values[0]).toBe(522075)
    expect((await run(env, 'incomeVsExpenses', q1, { chart: 'none' })).chart).toBeUndefined()
    // Over the everyday accounts the RRSP contribution is a transfer out; leaving transfers out drops it
    const everyday = { ...q1, scope: { kind: 'types' as const, types: ['chequing' as const, 'savings' as const, 'creditCard' as const] } }
    expect(byLabel(await run(env, 'incomeVsExpenses', everyday), 'Net after transfers').values).toEqual([176005, 182675, 13395, 372075])
    expect((await run(env, 'incomeVsExpenses', everyday, { withoutTransfers: true })).rows.some(r => r.label === 'Transfers out')).toBe(false)
  })
})

describe('2. Spending by Category', () => {
  it('gives the note\'s 2026: each category\'s spending and share, Uncategorised last, shares rounded down', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'spendingByCategory', YEAR_2026)
    expect(result.subtitle).toBe('2026 · Whole ledger · CAD')
    expect(headings(result)).toEqual(['Spending', 'Share'])
    expect(table(result)).toEqual([
      ['Housing', '18420.00', '45.2 %'], ['Food', '9875.20', '24.2 %'], ['Transportation', '4310.50', '10.5 %'], ['Utilities', '3204.80', '7.8 %'],
      ['Entertainment', '1986.40', '4.8 %'], ['Health', '1104.60', '2.7 %'], ['Gifts', '702.15', '1.7 %'], ['Clothing', '498.25', '1.2 %'],
      ['Education', '234.00', '0.5 %'], ['Uncategorised', '412.00', '1.0 %'], ['Total', '40747.90', '100.0 %']
    ])
    // Rounded down, the shares add to a little under 100 %: 99.6 % here
    expect(result.rows.slice(0, -1).reduce((n, r) => n + Math.floor(r.values[1]! / 10), 0)).toBe(996)
    // Eight slices: the seven largest, and Other for Clothing, Uncategorised and Education
    expect(result.chart?.categories).toEqual(['Housing', 'Food', 'Transportation', 'Utilities', 'Entertainment', 'Health', 'Gifts', 'Other (3)'])
    expect(result.chart?.series[0].values.at(-1)).toBe(49825 + 41200 + 23400)
  })

  it('shows a refund lowering spending, a category refunded more than charged as negative, and spent and refunded apart', async () => {
    const env = await setupReports()
    const chq = await env.accounts.createAccount(account('Chequing', null))
    const cats = await env.accounts.categories.list()
    const id = (name: string) => cats.find(c => c.name === name)!.id
    await env.accounts.transactions(chq.id).createMany([
      { date: '2026-02-01', amount: -10000, categoryId: id('Clothing') }, { date: '2026-02-10', amount: 2500, categoryId: id('Clothing') },
      { date: '2026-02-11', amount: 3000, categoryId: id('Travel') }
    ])
    const result = await run(env, 'spendingByCategory', YEAR_2026, { refunds: true })
    expect(headings(result)).toEqual(['Spent', 'Refunded', 'Spending', 'Share'])
    expect(table(result)).toEqual([['Personal', '100.00', '25.00', '75.00', '166.6 %'], ['Travel', '0.00', '30.00', '-30.00', '-66.7 %'], ['Total', '100.00', '55.00', '45.00', '100.0 %']])
    expect(result.chart?.series[0].label).toBe('Spending')
  })

  it('compares with last year: the earlier figure, labelled with its year, and the change', async () => {
    const env = await setupReports()
    const chq = await env.accounts.createAccount(account('Chequing', null, { openingDate: '2024-01-01' }))
    const food = (await env.accounts.categories.list()).find(c => c.name === 'Food')!.id
    await env.accounts.transactions(chq.id).createMany([{ date: '2025-05-01', amount: -8000, categoryId: food }, { date: '2026-05-01', amount: -9000, categoryId: food }])
    const result = await run(env, 'spendingByCategory', { ...YEAR_2026, compare: 'previousYear' })
    expect(headings(result)).toEqual(['Spending', 'Share', '2025', 'Change'])
    expect(table(result)).toEqual([['Food', '90.00', '100.0 %', '80.00', '10.00'], ['Total', '90.00', '100.0 %', '80.00', '10.00']])
    expect(result.compared).toEqual({ from: '2025-01-01', to: '2025-12-31' })
  })
})

describe('3. Spending by Payee', () => {
  it('gives the note\'s 2026 with the top 5: the rest as Other payees, No payee last, the total Spending by Category\'s', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'spendingByPayee', YEAR_2026, { '@top': '5' })
    expect(headings(result)).toEqual(['Spending', 'Transactions', 'Share'])
    expect(table(result)).toEqual([
      ['Riverside Properties', '18000.00', '12', '44.1 %'], ['FreshCo', '4812.33', '52', '11.8 %'], ['City Hydro', '1490.20', '12', '3.6 %'],
      ['Esso', '1322.75', '31', '3.2 %'], ['Corner Café', '684.50', '57', '1.6 %'], ['Other payees (143)', '14201.72', '412', '34.8 %'],
      ['No payee', '236.40', '9', '0.5 %'], ['Total', '40747.90', '585', '100.0 %']
    ])
    expect(result.notes).toEqual([{ tone: 'info', text: 'Showing the top 5 of 148 payees.' }])
    const byCategory = await run(env, 'spendingByCategory', YEAR_2026)
    expect(byLabel(result, 'Total').values[0]).toBe(byLabel(byCategory, 'Total').values[0])
    // Horizontal bars of the top ten (here, of the seven rows)
    expect(result.chart).toMatchObject({ kind: 'bar', horizontal: true, categories: ['Riverside Properties', 'FreshCo', 'City Hydro', 'Esso', 'Corner Café', 'Other payees (143)', 'No payee'] })
  })

  it('keeps the top 25 by default, or every payee, and lists who paid the user for income', async () => {
    const env = await setupReports()
    await household(env)
    expect((await run(env, 'spendingByPayee', YEAR_2026)).rows.filter(r => r.kind === 'member')).toHaveLength(25)
    const every = await run(env, 'spendingByPayee', YEAR_2026, { '@top': 'all' })
    expect(every.rows.filter(r => r.kind === 'member')).toHaveLength(148)
    expect(byLabel(every, 'Total').values.slice(0, 2)).toEqual([4074790, 585])
    const income = await run(env, 'spendingByPayee', YEAR_2026, { what: 'income' })
    expect(headings(income)).toEqual(['Income', 'Transactions', 'Share'])
    expect(table(income)).toEqual([['Northwind Ltd', '50400.00', '12', '99.7 %'], ['No payee', '144.35', '12', '0.2 %'], ['Total', '50544.35', '24', '100.0 %']])
  })
})

describe('4. Net Worth', () => {
  it('gives the note\'s month ends, January to June 2026: assets, liabilities, and net worth their plain sum', async () => {
    const env = await setupReports()
    await mortgaged(env)
    const result = await run(env, 'netWorth', { asOf: { ends: { from: '2026-01-01', to: '2026-06-30' } } })
    expect(plain(result.subtitle)).toMatch(/^Month ends, .* · Whole ledger · CAD$/)
    expect(result.period).toEqual({ dates: ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'] })
    expect(table(result)).toEqual([
      ['Assets', '48210.55', '49876.20', '51102.85', '53640.10', '54980.45', '56311.70'],
      ['Liabilities', '-212430.18', '-211905.62', '-211388.07', '-210842.55', '-210301.90', '-209770.33'],
      ['Net worth', '-164219.63', '-162029.42', '-160285.22', '-157202.45', '-155321.45', '-153458.63']
    ])
    // The change over the five months
    const net = byLabel(result, 'Net worth').values as number[]
    expect(net[5] - net[0]).toBe(1076100)
    expect(net).toEqual(ASSETS.map((a, i) => a + LIABILITIES[i]))
    expect(result.chart?.series.map(s => [s.label, s.as])).toEqual([['Assets', 'bar'], ['Liabilities', 'bar'], ['Net worth', 'line']])
    expect(result.rows.every(r => r.negativeIsBad)).toBe(true)
  })

  it('ends at today, offers quarter ends, types and accounts, and sub-ledgers', async () => {
    const env = await setupReports({ today: () => '2026-05-20' })
    await mortgaged(env)
    const result = await run(env, 'netWorth', { asOf: { ends: { preset: 'thisYear' } } })
    expect(result.period).toEqual({ dates: ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-20'] })
    expect((await run(env, 'netWorth', { asOf: { ends: { preset: 'thisYear' } } }, { points: 'quarter' })).period).toEqual({ dates: ['2026-03-31', '2026-05-20'] })
    expect(table(await run(env, 'netWorth', { asOf: { date: '2026-02-28' } }, { detail: 'accounts' }))).toEqual([
      ['Assets', '49876.20'], ['  Chequing', '49876.20'], ['    Chequing', '49876.20'],
      ['Liabilities', '-211905.62'], ['  Mortgage', '-211905.62'], ['    Mortgage', '-211905.62'], ['Net worth', '-162029.42']
    ])
  })
})

describe('5. Account Balances', () => {
  it('lays out the sub-ledger tree down to each account, with totals per sub-ledger and for the ledger', async () => {
    const env = await setupReports()
    const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
    const kids = await env.session.createSubLedger({ name: 'Kids', parentId: personal.id })
    await env.accounts.createAccount(account('Chequing', personal.id, { openingBalance: 150000 }))
    await env.accounts.createAccount(account('Piggy Bank', kids.id, { type: 'savings', openingBalance: 2500 }))
    await env.accounts.createAccount(account('Visa', personal.id, { type: 'creditCard', openingBalance: -45000 }))
    await env.accounts.createAccount(account('Cash', null, { type: 'cash', openingBalance: 6000 }))
    const closed = await env.accounts.createAccount(account('Old Savings', null, { type: 'savings', openingBalance: 0 }))
    await env.accounts.closeAccount(closed.id, { closedOn: '2026-01-10' })
    const result = await run(env, 'accountBalances')
    expect(result.subtitle).toBe(`${result.subtitle.split(' · ')[0]} · Whole ledger · CAD`)
    expect(table(result)).toEqual([
      ['Personal', '1075.00'], ['  Kids', '25.00'], ['    Piggy Bank', '25.00'], ['  Chequing', '1500.00'], ['  Visa', '-450.00'],
      ['Cash', '60.00'], ['Total', '1135.00']
    ])
    // Closed accounts holding nothing are left out unless asked for
    expect(table(await run(env, 'accountBalances', {}, { includeClosed: true })).map(r => r[0])).toContain('Old Savings')
    expect(table(await run(env, 'accountBalances', {}, { groupBy: 'types' })).map(r => r[0])).toEqual([
      'Assets', '  Chequing', '    Chequing', '  Savings', '    Piggy Bank', '  Cash', '    Cash', 'Liabilities', '  Credit card', '    Visa', 'Total'
    ])
  })

  it('offers each account in its own currency, with a total per currency, and a date to compare with', async () => {
    const env = await setupReports()
    const chq = await env.accounts.createAccount(account('Chequing', null, { openingBalance: 100000, openingDate: '2025-01-01' }))
    await env.accounts.createAccount(account('US Savings', null, { type: 'savings', currency: 'USD', openingBalance: 70000 }))
    await env.accounts.transactions(chq.id).create({ date: '2026-06-01', amount: 25000 })
    const all = await run(env, 'accountBalances', { currency: 'all' })
    expect(all.currency).toBeNull()
    expect(all.rows.map(r => [r.label, r.currency, r.values[0]])).toEqual([
      ['Chequing', 'CAD', 125000], ['US Savings', 'USD', 70000], ['Total (CAD)', 'CAD', 125000], ['Total (USD)', 'USD', 70000]
    ])
    const mostUsed = await run(env, 'accountBalances')
    expect(mostUsed.notes).toContainEqual({ tone: 'info', text: 'Not counted: US Savings, in USD.' })
    const compared = await run(env, 'accountBalances', { compare: { asOf: { date: '2025-12-31' } } })
    expect(compared.columns.map(c => c.label)).toEqual(['Balance', compared.columns[1].label, 'Change'])
    expect(table(compared)).toEqual([['Chequing', '1250.00', '1000.00', '250.00'], ['Total', '1250.00', '1000.00', '250.00']])
  })
})

describe('6. Cash Flow', () => {
  it('gives the note\'s March 2026 over the everyday accounts: the RRSP contribution is money out', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'cashFlow', { period: { from: '2026-03-01', to: '2026-03-31' } })
    expect(result.subtitle).toBe('March 2026 · Everyday accounts · CAD')
    expect(table(result)).toEqual([
      ['Opening balance', '12645.30', '12645.30'],
      ['Income', '4212.10', '4212.10'], ['  Salary', '4200.00', '4200.00'], ['  Interest', '12.10', '12.10'],
      ['Expenses', '2578.15', '2578.15'], ['  Housing', '1500.00', '1500.00'], ['  Food', '862.15', '862.15'],
      ['  Transportation', '175.00', '175.00'], ['  Uncategorised', '41.00', '41.00'],
      ['Transfers out', '1500.00', '1500.00'], ['  Retirement (RRSP)', '1500.00', '1500.00'],
      ['Net', '133.95', '133.95'],
      ['Closing balance', '12779.25', '12779.25']
    ])
  })

  it('holds opening + net + accounts opened = closing, month by month, over any scope', async () => {
    const env = await setupReports()
    const { chq } = await household(env)
    // An account opened in the year, with an opening balance: Accounts opened, that month
    const late = await env.accounts.createAccount(account('High Interest', null, { type: 'savings', openingDate: '2026-08-10', openingBalance: 300000 }))
    await env.accounts.transactions(chq.id).create({ date: '2026-08-12', amount: -50000, transferAccountId: late.id })
    for (const scope of [undefined, { kind: 'ledger' as const }, { kind: 'types' as const, types: ['savings' as const] }]) {
      const result = await run(env, 'cashFlow', { ...YEAR_2026, ...(scope && { scope }) })
      const [opening, net, closing] = ['Opening balance', 'Net', 'Closing balance'].map(label => byLabel(result, label).values as number[])
      const opened = result.rows.find(r => r.label === 'Accounts opened')?.values as number[] | undefined
      for (let c = 0; c < result.columns.length; c++) {
        expect(opening[c] + net[c] + (opened?.[c] ?? 0), `${JSON.stringify(scope)} ${result.columns[c].label}`).toBe(closing[c])
      }
      if (scope?.kind !== 'ledger') expect(opened?.[7]).toBe(300000)
    }
  })
})

describe('8. Category Trends', () => {
  it('gives the note\'s January to June 2026 for Food, in detail: months, a total and an average a month', async () => {
    const env = await setupReports()
    await household(env)
    const food = (await env.accounts.categories.list()).find(c => c.name === 'Food')!.id
    const result = await run(env, 'categoryTrends', { period: { from: '2026-01-01', to: '2026-06-30' }, chosen: { category: [food] } }, { detail: 'all' })
    expect(headings(result).slice(-2)).toEqual(['Total', 'Average a month'])
    expect(table(result)).toEqual([
      ['Food', '812.35', '745.10', '862.15', '782.75', '729.60', '887.00', '4818.95', '803.16'],
      ['  Groceries', '598.30', '611.45', '650.10', '602.75', '633.20', '641.90', '3737.70', '622.95'],
      ['  Dining out', '214.05', '133.65', '212.05', '180.00', '96.40', '245.10', '1081.25', '180.21']
    ])
    expect(result.chart?.series.map(s => [s.label, s.as])).toEqual([['Food', 'line']])
    // Income vs Expenses shows the same Food figures for January to March: the reports share one source
    const ive = await run(env, 'incomeVsExpenses', { period: { from: '2026-01-01', to: '2026-03-31' } })
    expect(byLabel(ive, 'Food').values.slice(0, 3)).toEqual(byLabel(result, 'Food').values.slice(0, 3))
  })

  it('keeps the top six categories and the rest as Other; stacked areas and quarters as options', async () => {
    const env = await setupReports()
    await household(env)
    const result = await run(env, 'categoryTrends', YEAR_2026)
    expect(result.rows.map(r => r.label)).toEqual(['Housing', 'Food', 'Transportation', 'Utilities', 'Entertainment', 'Health', 'Other categories (3)', 'Uncategorised'])
    expect(result.notes).toContainEqual({ tone: 'info', text: 'Showing the top 6 of 9 categories.' })
    const quarters = await run(env, 'categoryTrends', YEAR_2026, { columns: 'quarter', chart: 'areas' })
    expect(headings(quarters)).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026', 'Total', 'Average a quarter'])
    expect(quarters.chart?.series.every(s => s.stack === 'all')).toBe(true)
  })
})
