// @vitest-environment node
// The balances source (`reports.balances`): each account's balance at a date by the navigator's rule, against the
// registers and `chart().totals`; before and after an archive, accounts it removed included; today's figure and what
// is dated after it. See docs/reporting-design.md, "How things stood: the balances source".
import { describe, expect, it } from 'vitest'
import { BALANCES_SOURCE, type ReportParameters, type ReportSpec } from '@tessera/reports-api'
import { account, run, setupReports, table, type ReportsEnv } from './harness'

function balanceSpec(rows = 'account', dates = true): ReportSpec {
  return {
    specVersion: 1, source: BALANCES_SOURCE,
    parameters: { asOf: dates ? { ends: { from: '2026-01-01', to: '2026-06-30' } } : { at: 'today' }, scope: { kind: 'ledger' }, currency: 'CAD' },
    query: {
      rows: { dimension: rows, ...(rows === 'byType' || rows === 'byPlace' ? { depth: 'all' as const } : {}), sort: 'natural' },
      ...(dates && { columns: { dimension: 'date', grain: 'month' as const } }),
      measures: [{ measure: 'balance' }]
    },
    presentation: { show: 'table', table: { totals: { row: true } } }
  }
}
const balances = (env: ReportsEnv, parameters: ReportParameters = {}, spec = balanceSpec()) => env.reports.runSpec(spec, parameters)

/** A few accounts with transactions across 2026: a loan, a card, a closed one, a future-dated cheque. */
async function ledger() {
  const env = await setupReports({ today: () => '2026-06-15' })
  const t = (id: string) => env.accounts.transactions(id)
  const chq = await env.accounts.createAccount(account('Chequing', null, { openingBalance: 200000 }))
  const card = await env.accounts.createAccount(account('Card', null, { type: 'creditCard', openingBalance: -30000 }))
  const loan = await env.accounts.createAccount(account('Car Loan', null, { type: 'loan', openingBalance: -1500000, openingDate: '2026-03-10' }))
  const old = await env.accounts.createAccount(account('Old Savings', null, { type: 'savings', openingBalance: 5000 }))
  await t(chq.id).createMany([
    { date: '2026-01-15', amount: -12000 }, { date: '2026-02-15', amount: 350000 }, { date: '2026-04-01', amount: -40000, transferAccountId: loan.id },
    { date: '2026-06-10', amount: -8000 }, { date: '2026-06-20', amount: -1000 }, { date: '2026-09-01', amount: -55000, number: '101' }
  ])
  const v = await t(card.id).create({ date: '2026-02-02', amount: -9900 })
  await t(card.id).setVoided([v.id], true)
  await t(card.id).create({ date: '2026-05-05', amount: -4400 })
  await t(old.id).create({ date: '2026-01-20', amount: -5000 })
  await env.accounts.closeAccount(old.id, { closedOn: '2026-01-31' })
  return { env, t, chq, card, loan, old }
}

describe('balances at dates', () => {
  it('agree with each register\'s running balance on each date, voids left out, none before an account opened', async () => {
    const { env, t, chq, card, loan, old } = await ledger()
    const result = await balances(env, {}, { ...balanceSpec(), query: { ...balanceSpec().query, filters: [] } })
    const dates = (result.period as { dates: string[] }).dates
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-15'])
    for (const a of [chq, card, loan, old]) {
      const { rows } = await t(a.id).register()
      const expected = dates.map(d => d < a.openingDate ? null : rows.filter(r => r.transaction.date <= d).at(-1)?.balance ?? a.openingBalance)
      expect(result.rows.find(r => r.label === a.name)?.values, a.name).toEqual(expected)
    }
  })

  it('leave out closed accounts holding nothing, as the navigator hides them, unless asked for', async () => {
    const { env } = await ledger()
    const open = await run(env, 'accountBalances', { asOf: { date: '2026-02-28' } })
    expect(open.rows.map(r => r.label)).toEqual(['Chequing', 'Card', 'Total'])
    const all = await run(env, 'accountBalances', { asOf: { date: '2026-02-28' } }, { includeClosed: true })
    expect(all.rows.map(r => r.label)).toEqual(['Chequing', 'Card', 'Old Savings', 'Total'])
    // Before it closed it is shown, with something in it or not
    expect((await run(env, 'accountBalances', { asOf: { date: '2026-01-10' } })).rows.map(r => r.label)).toContain('Old Savings')
    expect((await run(env, 'accountBalances', { asOf: { date: '2026-01-25' } })).rows.find(r => r.label === 'Old Savings')?.values).toEqual([0])
  })

  it('match the navigator\'s totals at a date after every transaction: net worth is a plain sum', async () => {
    const { env } = await ledger()
    const chart = await env.accounts.chart()
    const result = await run(env, 'netWorth', { asOf: { date: '2026-12-31' } })
    expect(result.rows.find(r => r.label === 'Net worth')?.values).toEqual([chart.totals.CAD])
  })

  it('as of today leave out what is dated after it, which the navigator adds, and say how many', async () => {
    const { env } = await ledger()
    const today = await run(env, 'accountBalances')
    expect(today.rows.find(r => r.label === 'Chequing')?.values).toEqual([200000 - 12000 + 350000 - 40000 - 8000])
    expect(today.notes.map(n => n.text)).toContainEqual(expect.stringMatching(/^2 transactions dated after .* aren’t included\.$/))
  })

  it('group assets and liabilities by type, and sub-ledgers as the navigator lays them out', async () => {
    const { env } = await ledger()
    expect(table(await balances(env, {}, balanceSpec('byType', false)))).toEqual([
      ['Assets', '4900.00'], ['  Chequing', '4900.00'], ['    Chequing', '4900.00'], ['  Savings', '0.00'], ['    Old Savings', '0.00'],
      ['Liabilities', '-14944.00'], ['  Credit card', '-344.00'], ['    Card', '-344.00'], ['  Loan', '-14600.00'], ['    Car Loan', '-14600.00'],
      ['Total', '-10044.00']
    ])
    const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
    const chqId = (await env.accounts.list()).find(a => a.name === 'Chequing')!.id
    await env.accounts.moveAccount(chqId, personal.id)
    expect(table(await balances(env, {}, balanceSpec('byPlace', false)))).toEqual([
      ['Personal', '4900.00'], ['  Chequing', '4900.00'], ['Card', '-344.00'], ['Car Loan', '-14600.00'], ['Old Savings', '0.00'], ['Total', '-10044.00']
    ])
  })
})

describe('balances and archives', () => {
  it('are the same at every month end after an archive, an account it removed included, marked', async () => {
    const env = await setupReports({ today: () => '2026-12-31' })
    const t = (id: string) => env.accounts.transactions(id)
    const chq = await env.accounts.createAccount(account('Chequing', null, { openingBalance: 100000, openingDate: '2024-01-01' }))
    const visa = await env.accounts.createAccount(account('Old Visa', null, { type: 'creditCard', openingBalance: -30000, openingDate: '2024-01-01' }))
    const charge = await t(visa.id).create({ date: '2024-02-01', amount: -5000 })
    const paid = await t(chq.id).create({ date: '2024-06-30', amount: -35000, transferAccountId: visa.id })
    const later = await t(chq.id).create({ date: '2025-03-15', amount: -1234 })
    const mid = await t(chq.id).create({ date: '2025-06-10', amount: -2000 })
    await t(visa.id).setStatus([charge.id, (await t(visa.id).list()).find(x => x.transferId === paid.transferId)!.id], 'reconciled', { confirm: ['reconciled'] })
    await t(chq.id).setStatus([paid.id, later.id, mid.id], 'reconciled', { confirm: ['reconciled'] })
    await env.accounts.closeAccount(visa.id, { closedOn: '2024-07-01' })
    const spec = balanceSpec()
    const when = { asOf: { ends: { from: '2024-01-01', to: '2025-12-31' } } }
    const withClosed = { ...spec, query: { ...spec.query, filters: [] } }
    const before = await balances(env, when, withClosed)
    const net = await run(env, 'netWorth', when)
    await env.archive('2025-07-01')
    expect(await env.accounts.get(visa.id)).toBeUndefined()
    const after = await balances(env, when, withClosed)
    expect(after.rows.map(r => [r.label.replace(' (archived)', ''), r.values])).toEqual(before.rows.map(r => [r.label, r.values]))
    expect(after.rows.map(r => r.label)).toContain('Old Visa (archived)')
    expect((await run(env, 'netWorth', when)).rows.map(r => r.values)).toEqual(net.rows.map(r => r.values))
    // Inside an archived month, a date is answered as of the month's end, and said
    const midMonth = await balances(env, { asOf: { date: '2025-03-01' } }, { ...balanceSpec('account', false), query: { ...balanceSpec('account', false).query, filters: [] } })
    expect(midMonth.rows.find(r => r.label === 'Chequing')?.values).toEqual([100000 - 35000 - 1234])
    expect(midMonth.notes.map(n => n.text)).toContain('Balances on dates inside a month an archive removed transactions from are as of that month’s end: archived totals are kept by month.')
  })
})
