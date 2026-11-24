// @vitest-environment node
// The archive invariant, for reports: File › Archive Ledger… changes no report of any period. Flows come from what is
// left in the ledger and the totals accounts kept of what it removed (payees included); balances at month ends from
// balance history, an account the archive removed included. See docs/reporting-design.md, "Archived months".
import { describe, expect, it } from 'vitest'
import type { ReportParameters, ReportResult } from '@tessera/reports-api'
import { household, proprietor } from './examples'
import { account, run, setupReports, type ReportsEnv } from './harness'

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (m: number) => new Date(Date.UTC(2026, m, 0)).getUTCDate()
const month = (m: number) => ({ from: `2026-${pad(m)}-01`, to: `2026-${pad(m)}-${lastDay(m)}` })
const PERIODS = [
  ...Array.from({ length: 12 }, (_, i) => month(i + 1)),
  { from: '2026-01-01', to: '2026-03-31' }, { from: '2026-04-01', to: '2026-06-30' }, { from: '2026-01-01', to: '2026-06-30' },
  { from: '2026-05-01', to: '2026-08-31' }, { from: '2026-01-01', to: '2026-12-31' }
]

/** A result as the user sees it, less what says when it was worked out. An account the archive removed is marked so. */
const figures = (r: ReportResult) => ({
  columns: r.columns, subtitle: r.subtitle,
  rows: r.rows.map(x => ({ ...x, label: x.label.replace(' (archived)', '') })),
  chart: r.chart && {
    ...r.chart, categories: r.chart.categories.map(c => c.replace(' (archived)', '')),
    series: r.chart.series.map(s => ({ ...s, label: s.label.replace(' (archived)', '') }))
  }
})

/** Every flows report over every period (and some options), and Net Worth and Account Balances at month ends. */
async function everything(env: ReportsEnv, extra: ReportParameters = {}) {
  const out: Record<string, unknown> = {}
  for (const period of PERIODS) {
    const p = { period, ...extra }
    const key = `${period.from}..${period.to}`
    out[`ive ${key}`] = figures(await run(env, 'incomeVsExpenses', p, { detail: 'all' }))
    out[`sbc ${key}`] = figures(await run(env, 'spendingByCategory', p, { detail: 'all', refunds: true }))
    out[`sbp ${key}`] = figures(await run(env, 'spendingByPayee', p, { '@top': 'all' }))
    out[`cash ${key}`] = figures(await run(env, 'cashFlow', p))
    out[`trends ${key}`] = figures(await run(env, 'categoryTrends', p, { detail: 'all' }))
  }
  out.netWorth = figures(await run(env, 'netWorth', { asOf: { ends: { from: '2025-12-01', to: '2026-12-31' } }, ...extra }, { detail: 'accounts' }))
  out.netWorthPlaces = figures(await run(env, 'netWorth', { asOf: { ends: { from: '2025-12-01', to: '2026-12-31' } }, ...extra }, { detail: 'subLedgers' }))
  for (const m of [1, 3, 6, 9]) out[`balances ${m}`] = figures(await run(env, 'accountBalances', { asOf: { date: month(m).to }, ...extra }, { includeClosed: true }))
  return out
}

/** Reconciles everything dated before `before`, except every seventh transaction, which stays in the ledger. */
async function settle(env: ReportsEnv, before: string) {
  for (const a of await env.accounts.list()) {
    const t = env.accounts.transactions(a.id)
    const ids = (await t.list()).filter((x, i) => x.date < before && i % 7 !== 3).map(x => x.id)
    if (ids.length > 0) await t.setStatus(ids, 'reconciled', { confirm: ['reconciled'] })
  }
}

describe('reports through an archive', () => {
  it('are the same for every period, by category and by payee, and at every month end: the household archived before July', async () => {
    const env = await setupReports()
    await household(env)
    // A card used in the first months, paid off and closed: the archive removes it
    const old = await env.accounts.createAccount(account('Old Card', null, { type: 'creditCard', openingBalance: -2000 }))
    const food = (await env.accounts.categories.list()).find(c => c.name === 'Groceries')!.id
    const chq = (await env.accounts.list()).find(a => a.name === 'Chequing')!
    await env.accounts.transactions(old.id).createMany([
      { date: '2026-01-09', amount: -3000, categoryId: food, payee: 'FreshCo' }, { date: '2026-02-09', amount: -1500, categoryId: food, payee: 'Market' }
    ])
    await env.accounts.transactions(chq.id).create({ date: '2026-03-01', amount: -6500, transferAccountId: old.id })
    await settle(env, '2026-07-01')
    await env.accounts.closeAccount(old.id, { closedOn: '2026-03-02' })
    const before = await everything(env)

    const outcome = await env.archive('2026-07-01')
    expect(outcome.count).toBeGreaterThan(200)
    expect(await env.accounts.get(old.id)).toBeUndefined()

    const after = await everything(env)
    for (const key of Object.keys(before)) expect(after[key], key).toEqual(before[key])
  })

  it('are the same side by side and over each sub-ledger, the owner\'s pay among what was archived', async () => {
    const env = await setupReports()
    const { personal } = await proprietor(env)
    await settle(env, '2026-04-01')
    const side = { compare: 'subLedgers' as const }
    const over = { scope: { kind: 'subLedger' as const, subLedgerId: personal.id } }
    const read = async () => ({
      side: figures(await run(env, 'incomeVsExpenses', { period: month(3), ...side })),
      over: figures(await run(env, 'incomeVsExpenses', { period: month(3), ...over })),
      cash: figures(await run(env, 'cashFlow', { period: month(3), ...side })),
      worth: figures(await run(env, 'netWorth', { asOf: { ends: { from: '2026-01-01', to: '2026-06-30' } } }, { detail: 'subLedgers' }))
    })
    const before = await read()
    await env.archive('2026-04-01')
    expect(await read()).toEqual(before)
  })
})
