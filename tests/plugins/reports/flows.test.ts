// @vitest-environment node
// The flows source (`reports.flows`): what counts, case by case, against the real accounts service. The rule is the
// budget's, generalised to a report's scope. Every counted transaction is in exactly one row, archived ones included;
// a period that cuts an archived month in two leaves that month's archived part out, and says so.
// See docs/reporting-design.md, "What counts: the flows source".
import { describe, expect, it } from 'vitest'
import { FLOWS_SOURCE, type ReportParameters, type ReportSpec } from '@tessera/reports-api'
import { accountScope } from '@tessera/accounts-api'
import { countsFor, piecesOf } from '../../../plugins/reports/src/privileged/flows'
import { account, category, setupReports, table, type ReportsEnv } from './harness'

/** Flows by `flow` (every level) or another dimension, with money in, money out and counts. */
function flowSpec(rows = 'flow', over: Partial<ReportSpec['query']> = {}): ReportSpec {
  return {
    specVersion: 1, source: FLOWS_SOURCE,
    parameters: { period: { from: '2026-01-01', to: '2026-12-31' }, scope: { kind: 'ledger' }, currency: 'CAD' },
    query: {
      rows: { dimension: rows, ...(rows === 'flow' || rows === 'category' ? { depth: 'all' as const } : {}), sort: 'label' },
      measures: [{ measure: 'amount' }, { measure: 'moneyIn' }, { measure: 'moneyOut' }, { measure: 'count' }], ...over
    },
    presentation: { show: 'table', table: { totals: { row: true } } }
  }
}
const flows = (env: ReportsEnv, parameters: ReportParameters = {}, spec = flowSpec()) => env.reports.runSpec(spec, parameters)

async function ledger() {
  const env = await setupReports()
  const chq = await env.accounts.createAccount(account('Chequing', null, { openingBalance: 100000 }))
  const sav = await env.accounts.createAccount(account('Savings', null, { type: 'savings' }))
  const cats = await env.accounts.categories.list()
  const cat = (name: string) => cats.find(c => c.name === name)!.id
  const t = (id: string) => env.accounts.transactions(id)
  return { env, chq, sav, cat, t }
}

describe('what counts', () => {
  it('counts every clearing status, future-dated ones in the period, a closed account, and not the opening balance', async () => {
    const { env, chq, cat, t } = await ledger()
    const a = await t(chq.id).create({ date: '2026-02-01', amount: -1000, categoryId: cat('Groceries') })
    const b = await t(chq.id).create({ date: '2026-02-02', amount: -2000, categoryId: cat('Groceries') })
    const c = await t(chq.id).create({ date: '2026-02-03', amount: -3000, categoryId: cat('Groceries') })
    await t(chq.id).setStatus([a.id], 'electronic')
    await t(chq.id).setStatus([b.id], 'cleared')
    await t(chq.id).setStatus([c.id], 'reconciled', { confirm: ['reconciled'] })
    await t(chq.id).create({ date: '2026-12-20', amount: -4000, categoryId: cat('Groceries') })
    await t(chq.id).create({ date: '2026-02-04', amount: -5000, categoryId: cat('Groceries') })
    const old = await env.accounts.createAccount(account('Old', null, { openingBalance: 99999 }))
    await t(old.id).create({ date: '2026-03-01', amount: -500, categoryId: cat('Groceries') })
    await env.accounts.closeAccount(old.id, { confirm: ['closeWithBalance'], closedOn: '2026-04-01' })
    expect(table(await flows(env))).toEqual([
      ['Expenses', '155.00', '0.00', '155.00', '6'], ['  Food', '155.00', '0.00', '155.00', '6'], ['    Groceries', '155.00', '0.00', '155.00', '6'],
      ['Total', '155.00', '0.00', '155.00', '6']
    ])
  })

  it('counts a transaction dated after today that falls in the period, as budgets do; Year to date stops at today', async () => {
    const { env, chq, cat, t } = await ledger()
    await t(chq.id).create({ date: '2027-03-01', amount: -1200, categoryId: cat('Groceries') })
    await t(chq.id).create({ date: '2027-01-10', amount: -300, categoryId: cat('Groceries') })
    expect((await flows(env, { period: { preset: 'thisYear' } })).rows.at(-1)!.values[0]).toBe(1500)
    expect((await flows(env, { period: { preset: 'yearToDate' } })).rows.at(-1)!.values[0]).toBe(300)
  })

  it('leaves voided transactions out', async () => {
    const { env, chq, cat, t } = await ledger()
    const v = await t(chq.id).create({ date: '2026-05-01', amount: -7000, categoryId: cat('Groceries') })
    await t(chq.id).create({ date: '2026-05-02', amount: -100, categoryId: cat('Groceries') })
    await t(chq.id).setVoided([v.id], true)
    expect((await flows(env)).rows.at(-1)!.values).toEqual([100, 0, 100, 1])
  })

  it('lowers spending by a refund and income by a reversal, keeping money in and out apart', async () => {
    const { env, chq, cat, t } = await ledger()
    await t(chq.id).createMany([
      { date: '2026-06-01', amount: -10000, categoryId: cat('Clothing') }, { date: '2026-06-10', amount: 2500, categoryId: cat('Clothing') },
      { date: '2026-06-25', amount: 300000, categoryId: cat('Salary') }, { date: '2026-06-26', amount: -20000, categoryId: cat('Salary') }
    ])
    expect(table(await flows(env))).toEqual([
      ['Income', '2800.00', '3000.00', '200.00', '2'], ['  Salary', '2800.00', '3000.00', '200.00', '2'],
      ['Expenses', '75.00', '25.00', '100.00', '2'], ['  Personal', '75.00', '25.00', '100.00', '2'], ['    Clothing', '75.00', '25.00', '100.00', '2'],
      ['Total', '2875.00', '3025.00', '300.00', '4']
    ])
  })

  it('counts money in and out with no category apart, in with the income and out with the expenses, never netted', async () => {
    const { env, chq, t } = await ledger()
    await t(chq.id).createMany([{ date: '2026-07-01', amount: 5000 }, { date: '2026-07-02', amount: -1200 }, { date: '2026-07-03', amount: -800 }])
    expect(table(await flows(env))).toEqual([
      ['Income', '50.00', '50.00', '0.00', '0'], ['  Uncategorised', '50.00', '50.00', '0.00', '0'],
      ['Expenses', '20.00', '0.00', '20.00', '3'], ['  Uncategorised', '20.00', '0.00', '20.00', '3'],
      ['Total', '70.00', '50.00', '20.00', '3']
    ])
    // A total with money both ways counts once: with the money out (a total doesn't say how many went each way)
    expect(piecesOf({ accountId: 'a', month: '2026-07', categoryId: null, transferAccountId: null, inflow: 5000, outflow: 2000, count: 3 }, new Map(), false)
      .map(p => [p.group, p.amount, p.count])).toEqual([['income', 5000, 0], ['expense', 2000, 3]])
  })

  it('leaves out transfers between the report\'s own accounts, and counts one across the scope by the other account', async () => {
    const { env, chq, sav, t } = await ledger()
    await t(chq.id).create({ date: '2026-08-01', amount: -50000, transferAccountId: sav.id })
    await t(sav.id).create({ date: '2026-09-01', amount: -20000, transferAccountId: chq.id })
    // The whole ledger: both accounts inside, nothing counts
    expect((await flows(env)).rows).toEqual([expect.objectContaining({ label: 'Total', values: [null, null, null, null] })])
    // Chequing alone: money out to Savings, and back in from it
    expect(table(await flows(env, { scope: { kind: 'accounts', accountIds: [chq.id] } }))).toEqual([
      ['Transfers in', '200.00', '200.00', '0.00', '1'], ['  Savings', '200.00', '200.00', '0.00', '1'],
      ['Transfers out', '500.00', '0.00', '500.00', '1'], ['  Savings', '500.00', '0.00', '500.00', '1'],
      ['Total', '700.00', '200.00', '500.00', '2']
    ])
  })

  it('counts one currency at a time, naming the accounts it leaves out', async () => {
    const { env, chq, cat, t } = await ledger()
    const us = await env.accounts.createAccount(account('US Visa', null, { type: 'creditCard', currency: 'USD' }))
    await t(chq.id).create({ date: '2026-02-01', amount: -1000, categoryId: cat('Groceries') })
    await t(us.id).create({ date: '2026-02-01', amount: -7700, categoryId: cat('Groceries') })
    const cad = await flows(env)
    expect(cad.rows.at(-1)!.values[0]).toBe(1000)
    expect(cad.notes).toContainEqual({ tone: 'info', text: 'Not counted: US Visa, in USD.' })
    expect(cad.subtitle.endsWith('· CAD')).toBe(true)
    expect((await flows(env, { currency: 'USD' })).rows.at(-1)!.values[0]).toBe(7700)
    // Most used: the currency most accounts in scope use
    expect((await flows(env, { currency: 'mostUsed' })).currency).toBe('CAD')
    expect((await flows(env, { currency: 'mostUsed', scope: { kind: 'accounts', accountIds: [us.id] } })).currency).toBe('USD')
  })

  it('counts an account over its scope: a sub-ledger and everything beneath it, account types, chosen accounts', async () => {
    const env = await setupReports()
    const home = await env.session.createSubLedger({ name: 'Home', parentId: null })
    const cottage = await env.session.createSubLedger({ name: 'Cottage', parentId: home.id })
    const a = await env.accounts.createAccount(account('Home Chequing', home.id))
    const b = await env.accounts.createAccount(account('Cottage Card', cottage.id, { type: 'creditCard' }))
    const c = await env.accounts.createAccount(account('Cash', null, { type: 'cash' }))
    const food = await category(env, 'Groceries')
    for (const [id, amount] of [[a.id, -100], [b.id, -20], [c.id, -3]] as const) await env.accounts.transactions(id).create({ date: '2026-04-01', amount, categoryId: food })
    const total = async (parameters: ReportParameters) => (await flows(env, parameters)).rows.at(-1)!.values[0]
    expect(await total({})).toBe(123)
    expect(await total({ scope: { kind: 'subLedger', subLedgerId: home.id } })).toBe(120)
    expect(await total({ scope: { kind: 'subLedger', subLedgerId: cottage.id } })).toBe(20)
    expect(await total({ scope: { kind: 'types', types: ['chequing', 'savings', 'creditCard', 'lineOfCredit'] } })).toBe(120)
    expect(await total({ scope: { kind: 'types', types: ['creditCard'], subLedgerId: home.id } })).toBe(20)
    expect(await total({ scope: { kind: 'accounts', accountIds: [c.id, 'gone'] } })).toBe(3)
    expect((await flows(env, { scope: { kind: 'accounts', accountIds: [c.id, 'gone'] } })).notes).toContainEqual({ tone: 'warning', text: '1 account chosen for this report no longer exists.' })
    await expect(flows(env, { scope: { kind: 'subLedger', subLedgerId: 'gone' } })).rejects.toMatchObject({ code: 'NOT_FOUND', field: 'parameters.scope' })
    expect((await flows(env, { scope: { kind: 'subLedger', subLedgerId: home.id } })).subtitle).toBe('2026 · Home and its sub-ledgers · CAD')
    expect((await flows(env, { scope: { kind: 'types', types: ['creditCard'], subLedgerId: home.id } })).subtitle).toBe('2026 · Credit card in Home · CAD')
  })

  it('groups by payee, account, sub-ledger, account type, the other account and its sub-ledger', async () => {
    const { env, chq, sav, cat, t } = await ledger()
    const biz = await env.session.createSubLedger({ name: 'Business', parentId: null })
    const bchq = await env.accounts.createAccount(account('Business Chequing', biz.id))
    await t(chq.id).createMany([
      { date: '2026-02-01', amount: -1000, categoryId: cat('Groceries'), payee: 'FreshCo' },
      { date: '2026-02-02', amount: -500, categoryId: cat('Groceries') },
      { date: '2026-02-03', amount: 30000, transferAccountId: bchq.id }
    ])
    await t(sav.id).create({ date: '2026-02-04', amount: -200, categoryId: cat('Groceries'), payee: 'FreshCo' })
    const by = async (rows: string, parameters: ReportParameters = {}) => table(await flows(env, parameters, flowSpec(rows, { measures: [{ measure: 'amount' }] })))
    expect(await by('payee')).toEqual([['FreshCo', '12.00'], ['No payee', '5.00'], ['Total', '17.00']])
    expect(await by('account')).toEqual([['Chequing', '15.00'], ['Savings', '2.00'], ['Total', '17.00']])
    expect(await by('accountType')).toEqual([['Chequing', '15.00'], ['Savings', '2.00'], ['Total', '17.00']])
    expect(await by('subLedger')).toEqual([['(the ledger)', '17.00'], ['Total', '17.00']])
    const personal = { scope: { kind: 'accounts' as const, accountIds: [chq.id, sav.id] } }
    expect(await by('otherAccount', personal)).toEqual([['Business Chequing', '300.00'], ['(not a transfer)', '17.00'], ['Total', '317.00']])
    expect(await by('otherSubLedger', personal)).toEqual([['Business', '300.00'], ['(the ledger)', '17.00'], ['Total', '317.00']])
  })

  it('filters a tree by the members the heading picks, with everything beneath them', async () => {
    const { env, chq, cat, t } = await ledger()
    await t(chq.id).createMany([
      { date: '2026-02-01', amount: -1000, categoryId: cat('Groceries') }, { date: '2026-02-01', amount: -400, categoryId: cat('Dining out') },
      { date: '2026-02-01', amount: -9000, categoryId: cat('Rent') }
    ])
    const spec = { ...flowSpec('category'), parameters: { ...flowSpec().parameters, choose: ['category'] } }
    expect(table(await env.reports.runSpec(spec, { chosen: { category: [cat('Food')] } }))).toEqual([
      ['Food', '14.00', '0.00', '14.00', '2'], ['  Dining out', '4.00', '0.00', '4.00', '1'], ['  Groceries', '10.00', '0.00', '10.00', '1'],
      ['Total', '14.00', '0.00', '14.00', '2']
    ])
  })
})

describe('transfers with an account the ledger no longer knows', () => {
  it('judge the other side by the sub-ledger its archived total kept, as the budget does', () => {
    const scope = accountScope({ kind: 'subLedger', subLedgerId: 'biz' }, [{ id: 'biz', parentId: null, name: 'Business', order: 0 }], [{ id: 'b1', name: 'B', subLedgerId: 'biz', currency: 'CAD', type: 'chequing' }], 'CAD')
    const placed = new Map([['b1', { id: 'b1', name: 'B', type: 'chequing' as const, currency: 'CAD', subLedgerId: 'biz', openingDate: '2020-01-01', openingBalance: 0, closed: false, removed: false }]])
    const total = (transferSubLedgerId: string | null) => ({ accountId: 'b1', transferAccountId: 'gone', transferSubLedgerId })
    expect(countsFor(total('biz'), scope, placed, 'CAD')).toBe(false)
    expect(countsFor(total(null), scope, placed, 'CAD')).toBe(true)
    expect(countsFor({ accountId: 'b1', transferAccountId: null }, scope, placed, 'USD')).toBe(false)
    // An account known only from its archived total: where and in what it was
    expect(countsFor({ accountId: 'old', transferAccountId: null, currency: 'CAD', subLedgerId: 'biz' }, scope, placed, 'CAD')).toBe(true)
    expect(countsFor({ accountId: 'old', transferAccountId: null, currency: 'USD', subLedgerId: 'biz' }, scope, placed, 'CAD')).toBe(false)
  })
})

describe('every counted transaction, once', () => {
  it('puts each in exactly one row, and the rows add up to the totals, on random ledgers', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      let s = seed
      const r = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31 }
      const { env, chq, sav, t } = await ledger()
      const card = await env.accounts.createAccount(account('Card', null, { type: 'creditCard' }))
      const categories = await env.accounts.categories.list()
      const ids = [chq.id, sav.id, card.id]
      const drafts = new Map<string, { date: string, amount: number, categoryId?: string, transferAccountId?: string, payee?: string }[]>(ids.map(id => [id, []]))
      for (let i = 0; i < 150; i++) {
        const from = ids[Math.floor(r() * 3)]
        const amount = Math.round((r() - 0.6) * 50000) || 1
        const date = `2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`
        const kind = r()
        if (kind < 0.1) drafts.get(from)!.push({ date, amount, transferAccountId: ids.find(x => x !== from)! })
        else if (kind < 0.2) drafts.get(from)!.push({ date, amount })
        else drafts.get(from)!.push({ date, amount, categoryId: categories[Math.floor(r() * categories.length)].id, ...(r() < 0.7 && { payee: `P${Math.floor(r() * 8)}` }) })
      }
      for (const [id, list] of drafts) await t(id).createMany(list)
      const transactions = (await Promise.all(ids.map(id => t(id).list()))).flat()
      // Over the chequing account and the card: every transaction of theirs counts except transfers between them
      const scope = { kind: 'accounts' as const, accountIds: [chq.id, card.id] }
      const counted = transactions.filter(x => scope.accountIds.includes(x.accountId) && !(x.transferAccountId && scope.accountIds.includes(x.transferAccountId)))
      for (const rows of ['flow', 'category', 'payee', 'account']) {
        const result = await flows(env, { scope }, flowSpec(rows, { measures: [{ measure: 'net' }, { measure: 'count' }] }))
        const total = result.rows.find(x => x.kind === 'total')!.values
        const leaves = result.rows.filter(x => !['subtotal', 'heading', 'total'].includes(x.kind))
        expect(total[1], `seed ${seed}, by ${rows}`).toBe(counted.length)
        expect(leaves.reduce((n, x) => n + (x.values[1] ?? 0), 0), `seed ${seed}, by ${rows}`).toBe(counted.length)
        expect(total[0], `seed ${seed}, by ${rows}`).toBe(counted.reduce((n, x) => n + x.amount, 0))
        expect(leaves.reduce((n, x) => n + (x.values[0] ?? 0), 0), `seed ${seed}, by ${rows}`).toBe(total[0])
      }
    }
  })
})

describe('archived months', () => {
  async function archived() {
    const { env, chq, cat, t } = await ledger()
    const a = await t(chq.id).create({ date: '2025-03-05', amount: -4000, categoryId: cat('Groceries'), payee: 'FreshCo' })
    const b = await t(chq.id).create({ date: '2025-03-20', amount: -1000, categoryId: cat('Groceries'), payee: 'FreshCo' })
    await t(chq.id).create({ date: '2025-03-25', amount: -700, categoryId: cat('Groceries'), payee: 'FreshCo' })   // not reconciled: stays
    await t(chq.id).setStatus([a.id, b.id], 'reconciled', { confirm: ['reconciled'] })
    return { env, chq, cat, t }
  }

  it('reports what archives removed from their kept totals, with what is left, by payee too', async () => {
    const { env } = await archived()
    const march = { period: { from: '2025-03-01', to: '2025-03-31' } }
    const before = table(await flows(env, march, flowSpec('payee', { measures: [{ measure: 'amount' }, { measure: 'count' }] })))
    await env.archive('2025-04-01')
    expect(table(await flows(env, march, flowSpec('payee', { measures: [{ measure: 'amount' }, { measure: 'count' }] })))).toEqual(before)
    expect(before).toEqual([['FreshCo', '57.00', '3'], ['Total', '57.00', '3']])
  })

  it('leaves out the archived part of a month the period cuts in two, and says so', async () => {
    const { env } = await archived()
    await env.archive('2025-04-01')
    const cut = await flows(env, { period: { from: '2025-03-10', to: '2025-12-31' } })
    expect(cut.rows.at(-1)!.values[0]).toBe(700)
    expect(cut.notes.map(n => n.text)).toContainEqual(expect.stringMatching(/^Transactions archived from .* are kept as monthly totals, which this period cuts in two, so they are left out\. Choose whole months to include them\.$/))
  })
})
