// @vitest-environment node
// Reporting by sub-ledger, for a household and a small business in one ledger: any report over one sub-ledger; the
// owner's pay a transfer, never income or an expense; sub-ledgers side by side, each column worked out over its own
// sub-ledger, adding up to the whole. The note's March 2026 example, figure for figure.
// See docs/reporting-design.md, "Reporting by sub-ledger".
import { describe, expect, it } from 'vitest'
import type { ReportResult } from '@tessera/reports-api'
import { proprietor } from './examples'
import { account, category, headings, run, setupReports, table } from './harness'

const MARCH = { period: { from: '2026-03-01', to: '2026-03-31' } }
const row = (result: ReportResult, label: string) => result.rows.find(r => r.label === label)?.values

describe('reporting by sub-ledger', () => {
  it('gives the note\'s March 2026 side by side: transfers apart, after Net income, cancelling over the whole', async () => {
    const env = await setupReports()
    await proprietor(env)
    const result = await run(env, 'incomeVsExpenses', { ...MARCH, compare: 'subLedgers' })
    expect(result.subtitle).toBe('March 2026 · Whole ledger, by sub-ledger · CAD')
    expect(headings(result)).toEqual(['Personal', 'Business', 'Whole ledger'])
    expect(table(result)).toEqual([
      ['Income', '—', '—', '—'],
      ['  Consulting fees', '—', '8400.00', '8400.00'],
      ['  Interest', '12.10', '—', '12.10'],
      ['Total income', '12.10', '8400.00', '8412.10'],
      ['Expenses', '—', '—', '—'],
      ['  Housing', '1500.00', '—', '1500.00'],
      ['  Food', '862.15', '—', '862.15'],
      ['  Office and software', '—', '357.40', '357.40'],
      ['  Transportation', '175.00', '—', '175.00'],
      ['  Bank charges', '—', '18.50', '18.50'],
      ['  Uncategorised', '41.00', '—', '41.00'],
      ['Total expenses', '2578.15', '375.90', '2954.05'],
      ['Net income', '-2566.05', '8024.10', '5458.05'],
      ['Transfers in', '—', '—', '—'],
      ['  Business Chequing', '3000.00', '—', '—'],
      ['Total transfers in', '3000.00', '—', '—'],
      ['Transfers out', '—', '—', '—'],
      ['  Personal Chequing', '—', '3000.00', '—'],
      ['Total transfers out', '—', '3000.00', '—'],
      ['Net after transfers', '433.95', '5024.10', '5458.05']
    ])
    expect(result.notes).toContainEqual({ tone: 'info', text: 'Transfers between these sub-ledgers cancel out over the whole.' })
    // Personal's net income is negative: what the household lives on arrives as the owner's pay
    expect(result.rows.find(r => r.label === 'Net income')?.negativeIsBad).toBe(true)
  })

  it('works each column out as the report over that sub-ledger alone, and income, expenses and both nets add up to the whole', async () => {
    const env = await setupReports()
    const { personal, business } = await proprietor(env)
    const side = await run(env, 'incomeVsExpenses', { ...MARCH, compare: 'subLedgers' })
    const alone = await Promise.all([personal, business].map(s => run(env, 'incomeVsExpenses', { ...MARCH, scope: { kind: 'subLedger', subLedgerId: s.id } })))
    const whole = await run(env, 'incomeVsExpenses', MARCH)
    for (const [i, report] of alone.entries()) {
      for (const r of report.rows.filter(x => x.kind !== 'heading')) expect(row(side, r.label)?.[i], `${r.label} in column ${i}`).toEqual(r.values[0])
    }
    for (const label of ['Total income', 'Total expenses', 'Net income', 'Net after transfers']) {
      const v = row(side, label)!
      expect((v[0] ?? 0) + (v[1] ?? 0), label).toBe(v[2])
    }
    expect(row(whole, 'Net income')?.[0]).toBe(row(side, 'Net income')?.[2])
    // Over Personal alone the owner's pay is money in, but not income: no income row holds it
    const over = alone[0]
    expect(table(over).map(r => r[0])).toEqual([
      'Income', '  Interest', 'Total income', 'Expenses', '  Housing', '  Food', '  Transportation', '  Uncategorised', 'Total expenses',
      'Net income', 'Transfers in', '  Business Chequing', 'Total transfers in', 'Net after transfers'
    ])
    expect(row(alone[1], 'Total expenses')).toEqual([37590, 37590])
  })

  it('gives the accounts held directly in the scope a column of their own, and compares sub-ledgers nested two deep', async () => {
    const env = await setupReports()
    const { personal } = await proprietor(env)
    const kids = await env.session.createSubLedger({ name: 'Kids', parentId: personal.id })
    const allowance = await env.accounts.createAccount(account('Allowance', kids.id, { type: 'savings' }))
    const cash = await env.accounts.createAccount(account('Cash', null, { type: 'cash' }))
    const toys = await category(env, 'Toys')
    await env.accounts.transactions(allowance.id).create({ date: '2026-03-12', amount: -1500, categoryId: toys })
    await env.accounts.transactions(cash.id).create({ date: '2026-03-13', amount: -600, categoryId: toys })
    const whole = await run(env, 'spendingByCategory', { ...MARCH, compare: 'subLedgers' })
    expect(headings(whole)).toEqual(['Personal Spending', 'Personal Share', 'Business Spending', 'Business Share', 'Home itself Spending', 'Home itself Share', 'Whole ledger Spending', 'Whole ledger Share'])
    expect(row(whole, 'Toys')).toEqual([1500, 57, null, null, 600, 10000, 2100, 70])
    // Over Personal: Kids beside what Personal holds itself, and Personal in all
    const overPersonal = await run(env, 'spendingByCategory', { ...MARCH, compare: 'subLedgers', scope: { kind: 'subLedger', subLedgerId: personal.id } })
    expect(overPersonal.columns.filter((_, i) => i % 2 === 0).map(c => c.group)).toEqual(['Kids', 'Personal itself', 'Personal and its sub-ledgers'])
    expect(row(overPersonal, 'Toys')).toEqual([1500, 10000, null, null, 1500, 57])
    expect(row(overPersonal, 'Total')?.filter((_, i) => i % 2 === 0)).toEqual([1500, 257815, 259315])
  })

  it('covers everyday accounts in one sub-ledger: the business\'s cash flow, the owner\'s pay going out', async () => {
    const env = await setupReports()
    const { business } = await proprietor(env)
    const result = await run(env, 'cashFlow', { ...MARCH, scope: { kind: 'types', types: ['chequing', 'savings', 'creditCard', 'lineOfCredit'], subLedgerId: business.id } })
    expect(result.subtitle).toBe('March 2026 · Everyday accounts in Business · CAD')
    expect(table(result)).toEqual([
      ['Opening balance', '15000.00', '15000.00'],
      ['Income', '8400.00', '8400.00'], ['  Consulting fees', '8400.00', '8400.00'],
      ['Expenses', '375.90', '375.90'], ['  Office and software', '357.40', '357.40'], ['  Bank charges', '18.50', '18.50'],
      ['Transfers out', '3000.00', '3000.00'], ['  Personal Chequing', '3000.00', '3000.00'],
      ['Net', '5024.10', '5024.10'],
      ['Closing balance', '20024.10', '20024.10']
    ])
    // Side by side, Cash Flow's balances are each sub-ledger's own
    const side = await run(env, 'cashFlow', { ...MARCH, compare: 'subLedgers' })
    expect(headings(side)).toEqual(['Personal', 'Business', 'Everyday accounts'])
    expect(row(side, 'Opening balance')).toEqual([1200000, 1500000, 2700000])
    expect(row(side, 'Closing balance')).toEqual([1243395, 2002410, 3245805])
  })

  it('refuses to compare sub-ledgers over accounts chosen one by one', async () => {
    const env = await setupReports()
    const { pchq } = await proprietor(env)
    await expect(run(env, 'incomeVsExpenses', { ...MARCH, compare: 'subLedgers', scope: { kind: 'accounts', accountIds: [pchq.id] } }))
      .rejects.toMatchObject({ code: 'INVALID', field: 'parameters.compare' })
  })
})
