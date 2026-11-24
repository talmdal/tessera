// @vitest-environment node
// Reports at scale: ten years of a busy household, 100,000 transactions in 15 accounts (a twentieth transfers, 300
// payees), as the accounts and budget spikes shaped them. A year's report of each kind, through `reports.service`, in
// CPU time (which other test files running alongside don't stretch). The design's goal is a year's report in under a
// quarter of a second; R0 measured the engine at its limits within 50 ms, and balance history for 120 month ends at
// 187 to 291 ms by the clock. See docs/reporting-design.md, "Goals" and Phase R0 results.
import { describe, expect, it } from 'vitest'
import { collectionsOf, type StoredAccount, type StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { run, setupReports } from './harness'

const TRANSACTIONS = 100_000
/** A year's report of flows. Measured below; the budget leaves room for slower machines and a loaded run. */
const YEAR_BUDGET_MS = 500
/** Net Worth over ten years: 120 month ends of every account. */
const TEN_YEARS_BUDGET_MS = 1000

const threadUsage = (process as { threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage
const cpuUsage = (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => threadUsage ? threadUsage.call(process, previous) : process.cpuUsage(previous)
const cpuSince = (start: NodeJS.CpuUsage) => { const used = cpuUsage(start); return (used.user + used.system) / 1000 }

/** A deterministic random source (mulberry32). */
function random(seed: number) {
  let s = seed
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function busyLedger(categoryIds: string[]) {
  const r = random(7)
  const types = ['chequing', 'savings', 'creditCard', 'chequing', 'mortgage'] as const
  const accounts: (StoredAccount & { id: string })[] = Array.from({ length: 15 }, (_, i) => ({
    id: `acct-${i}`, subLedgerId: null, name: `Account ${i}`, nameKey: `account ${i}`, type: types[i % types.length],
    currency: 'CAD', openingDate: '2017-01-01', openingBalance: 100000, closed: false, order: i
  }))
  const stamp = '2017-01-01T00:00:00.000Z'
  const transactions: (StoredTransaction & { id: string })[] = []
  const day = () => new Date(Date.UTC(2017, 0, 1) + Math.floor(r() * 3650) * 86400000).toISOString().slice(0, 10)
  while (transactions.length < TRANSACTIONS) {
    const a = accounts[Math.floor(r() * accounts.length)], date = day(), amount = Math.round((r() - 0.85) * 20000)
    const status = 'cleared', voided = r() < 0.01
    const id = `t${transactions.length}`
    if (r() < 0.05) {
      const b = accounts[(accounts.indexOf(a) + 1 + Math.floor(r() * 14)) % 15]
      transactions.push({ id, accountId: a.id, date, amount, status, voided, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: b.id })
      transactions.push({ id: `${id}b`, accountId: b.id, date, amount: -amount, status, voided, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: a.id })
    } else {
      const category = r() < 0.97 ? Math.floor(r() * categoryIds.length) : undefined
      const payeeId = transactions.length % 20 === 0 ? undefined : `payee-${((category ?? 0) * 7 + transactions.length % 3) % 300}`
      transactions.push({ id, accountId: a.id, date, amount, status, voided, createdAt: stamp, updatedAt: stamp, ...(category !== undefined && { categoryId: categoryIds[category] }), ...(payeeId && { payeeId }) })
    }
  }
  return { accounts, transactions }
}

describe('reports at scale', () => {
  it(`run a year of each flows report, and ten years of net worth, at ${TRANSACTIONS.toLocaleString('en-US')} transactions, within budget`, async () => {
    const env = await setupReports()
    const categoryIds = (await env.accounts.categories.list()).map(c => c.id)
    const { accounts, transactions } = busyLedger(categoryIds)
    await env.session.database('accounts').transaction(async tx => {
      const c = collectionsOf(tx)
      await c.accounts.insertMany(accounts)
      await c.transactions.insertMany(transactions)
      await c.payees.insertMany(Array.from({ length: 300 }, (_, i) => ({ id: `payee-${i}`, name: `Payee ${i}`, nameKey: `payee ${i}` })))
    })
    const year = { period: { from: '2026-01-01', to: '2026-12-31' } }
    // The least of five: a loaded machine only ever adds time, even CPU time (cores shared with other test files), so
    // the least is the best measure of what a report costs. (The median of three failed now and then under the whole
    // suite: Cash Flow at 721 ms, against 187 ms alone.)
    const least = async (work: () => Promise<unknown>) => {
      await work()                                           // warm
      const times: number[] = []
      for (let i = 0; i < 5; i++) { const start = cpuUsage(); await work(); times.push(cpuSince(start)) }
      return Math.min(...times)
    }
    const timings: [string, number][] = []
    for (const [id, options] of [
      ['incomeVsExpenses', { detail: 'all' }], ['spendingByCategory', { detail: 'all' }], ['spendingByPayee', { '@top': 'all' }],
      ['categoryTrends', {}], ['cashFlow', {}]
    ] as const) {
      timings.push([id, await least(() => run(env, id, year, options))])
    }
    const side = await least(() => run(env, 'incomeVsExpenses', { ...year, compare: 'subLedgers' }))
    const tenYears = await least(() => run(env, 'netWorth', { asOf: { ends: { from: '2017-01-01', to: '2026-12-31' } } }, { detail: 'accounts' }))
    console.log(`[scale] reports at ${TRANSACTIONS.toLocaleString('en-US')}, CPU time: ${timings.map(([id, ms]) => `${id} ${ms.toFixed(0)} ms`).join(', ')}; side by side ${side.toFixed(0)} ms; net worth, 120 month ends, ${tenYears.toFixed(0)} ms`)

    const payees = await run(env, 'spendingByPayee', year, { '@top': 'all' })
    expect(payees.rows.filter(r => r.kind === 'member').length).toBeGreaterThan(100)
    for (const [id, ms] of timings) expect(ms, id).toBeLessThan(YEAR_BUDGET_MS)
    expect(tenYears).toBeLessThan(TEN_YEARS_BUDGET_MS)
  })
})
