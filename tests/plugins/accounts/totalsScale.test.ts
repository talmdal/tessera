// @vitest-environment node
// Transaction totals at scale (docs/budget-design.md, Phase B1): ten years of a busy household, 100,000 transactions
// in 15 accounts, a tenth of them transfers. A year's totals through the service, and an archive's totals of what it
// removes, within CPU-time budgets. The budget spike measured a year at 42 to 49 ms, and an archive's totals at 0.21 to
// 0.39 s in all, on a slow VM; the budgets leave room for slower machines and a loaded test run. CPU time, unlike the clock, isn't stretched by other test files running alongside.
import { describe, expect, it } from 'vitest'
import type { TransactionTotal } from '@tessera/accounts-api'
import { keepArchived, planArchive, removedTotals, TOTALS_YIELD_EVERY } from '../../../plugins/accounts/src/privileged/archiveCore'
import { collectionsOf, type StoredAccount, type StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { setupAccounts } from './harness'

const YEAR_BUDGET_MS = 250
/**
 * 120 month ends over every account, reports' Net Worth. Phase R0 measured 187 to 291 ms by the clock at 100,000 (and
 * 254 here, alone), almost all of it the one `find` that reads every transaction; the navigator's `chart()` takes 0.41
 * to 0.46 s on the same ledger. By CPU time on a Node without per-thread CPU time (before 23.9), the collector's helper
 * threads count too, after this file's other work: 538 ms was seen. The budget is for that, not the design's 500 ms
 * by the clock.
 */
const HISTORY_BUDGET_MS = 750
// Measured at 12 to 40 ms between turns, and 50 to 90 ms by the clock for the stretch with a young-generation garbage
// collection in it (the rows built are promoted), which no smaller step would split. CPU time counts the collector's
// parallel threads too, so under a full test run that stretch has taken 99 to 201 ms, with the whole taking 245 to
// 535 ms: no fixed limit holds for it. A loop that never yielded would do it all in one stretch. So a typical stretch
// must be a small share of the whole, and the longest less than half of it. (A typical stretch was held to 50 ms until
// reports' R3, the first time the whole suite ran: on a machine whose speed varied threefold between runs, CPU time
// itself doubled under load, and the keep's median stretch took 51 to 58 ms, with the whole at 908 ms. A share holds
// whatever the machine's speed.)
/** The most of the whole a typical (median) stretch may take: with 16 stretches or so, a fifth is three times the norm. */
const TYPICAL_TURN_SHARE = 1 / 5
const TRANSACTIONS = 100_000

/**
 * This thread's CPU time, where Node can tell it (23.9 and later), else the process's: the process's counts the garbage
 * collector's helper threads, which on a busy machine can spin for several times the work.
 */
const threadUsage = (process as { threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage
const cpuUsage = (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => threadUsage ? threadUsage.call(process, previous) : process.cpuUsage(previous)

/** CPU time since `start` (a `cpuUsage()`), in milliseconds. */
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

/** Accounts and transactions shaped like the budget spike's ledgers: 2017 to 2026, three sub-ledgers, transfers. */
function busyLedger(categoryIds: string[]) {
  const r = random(7)
  const subLedgers = [null, 'personal', 'business', 'rentals']
  const accounts: (StoredAccount & { id: string })[] = Array.from({ length: 15 }, (_, i) => ({
    id: `acct-${i}`, subLedgerId: subLedgers[i % 4], name: `Account ${i}`, nameKey: `account ${i}`, type: 'chequing',
    currency: 'CAD', openingDate: '2017-01-01', openingBalance: 0, closed: false, order: i
  }))
  const stamp = '2017-01-01T00:00:00.000Z'
  const transactions: (StoredTransaction & { id: string })[] = []
  const day = () => new Date(Date.UTC(2017, 0, 1) + Math.floor(r() * 3600) * 86400000).toISOString().slice(0, 10)
  while (transactions.length < TRANSACTIONS) {
    const a = accounts[Math.floor(r() * accounts.length)], date = day(), amount = Math.round((r() - 0.85) * 20000)
    const status = date < '2026-10-01' && r() < 0.975 ? 'reconciled' : 'cleared', voided = r() < 0.01
    const id = `t${transactions.length}`
    if (r() < 0.05) {
      const b = accounts[(accounts.indexOf(a) + 1 + Math.floor(r() * 14)) % 15]
      transactions.push({ id, accountId: a.id, date, amount, status, voided, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: b.id })
      transactions.push({ id: `${id}b`, accountId: b.id, date, amount: -amount, status, voided, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: a.id })
    } else {
      const category = r() < 0.97 ? Math.floor(r() * categoryIds.length) : undefined
      // 300 payees, each keeping mostly to a few categories as real ones do (R0): by position, drawing nothing random
      const payeeId = transactions.length % 20 === 0 ? undefined : `payee-${((category ?? 0) * 7 + transactions.length % 3) % 300}`
      transactions.push({ id, accountId: a.id, date, amount, status, voided, createdAt: stamp, updatedAt: stamp, ...(category !== undefined && { categoryId: categoryIds[category] }), ...(payeeId && { payeeId }) })
    }
  }
  return { accounts, transactions }
}

describe('transaction totals at scale', () => {
  it(`totals a year of ${TRANSACTIONS.toLocaleString('en-US')} transactions within ${YEAR_BUDGET_MS} ms of CPU time`, async () => {
    const { service, session } = await setupAccounts()
    const categoryIds = (await service.categories.list()).map(c => c.id)
    const { accounts, transactions } = busyLedger(categoryIds)
    await session.database('accounts').transaction(async tx => {
      const c = collectionsOf(tx)
      await c.accounts.insertMany(accounts)
      await c.transactions.insertMany(transactions)
    })
    const year = { from: '2026-01-01', to: '2026-12-31', includeTransfers: true }

    await service.transactionTotals(year)                    // warm
    const times: number[] = []
    let totals: TransactionTotal[] = []
    for (let i = 0; i < 3; i++) {
      const start = cpuUsage()
      totals = await service.transactionTotals(year)
      times.push(cpuSince(start))
    }
    const ms = times.sort((a, b) => a - b)[1]
    const inYear = transactions.filter(t => !t.voided && t.date >= year.from && t.date <= year.to)
    console.log(`[scale] transactionTotals: a year of ${TRANSACTIONS.toLocaleString('en-US')} (${inYear.length.toLocaleString('en-US')} in it), ${totals.length.toLocaleString('en-US')} rows, in ${ms.toFixed(0)} ms of CPU time`)

    expect(totals.reduce((n, t) => n + t.count, 0)).toBe(inYear.length)
    expect(totals.reduce((n, t) => n + t.inflow - t.outflow, 0)).toBe(inYear.reduce((n, t) => n + t.amount, 0))
    expect(ms).toBeLessThan(YEAR_BUDGET_MS)
  })

  it(`totals a year of ${TRANSACTIONS.toLocaleString('en-US')} transactions by payee, and gives 120 month ends of balances, within budget`, async () => {
    const { service, session } = await setupAccounts()
    const categoryIds = (await service.categories.list()).map(c => c.id)
    const { accounts, transactions } = busyLedger(categoryIds)
    await session.database('accounts').transaction(async tx => {
      const c = collectionsOf(tx)
      await c.accounts.insertMany(accounts)
      await c.transactions.insertMany(transactions)
    })
    const year = { from: '2026-01-01', to: '2026-12-31', includeTransfers: true, byPayee: true }
    const dates = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2017, i + 1, 0)).toISOString().slice(0, 10))
    const median = async (work: () => Promise<unknown>) => {
      await work()                                           // warm
      const times: number[] = []
      for (let i = 0; i < 3; i++) { const start = cpuUsage(); await work(); times.push(cpuSince(start)) }
      return times.sort((a, b) => a - b)[1]
    }

    const byPayee = await service.transactionTotals(year)
    const payeeMs = await median(() => service.transactionTotals(year))
    const points = await service.balanceHistory({ dates })
    const historyMs = await median(() => service.balanceHistory({ dates }))
    console.log(`[scale] transactionTotals by payee: a year of ${TRANSACTIONS.toLocaleString('en-US')}, ${byPayee.length.toLocaleString('en-US')} rows, in ${payeeMs.toFixed(0)} ms of CPU time; balanceHistory: ${dates.length} month ends of ${accounts.length} accounts in ${historyMs.toFixed(0)} ms`)

    const inYear = transactions.filter(t => !t.voided && t.date >= year.from && t.date <= year.to)
    expect(byPayee.reduce((n, t) => n + t.count, 0)).toBe(inYear.length)
    expect(payeeMs).toBeLessThan(YEAR_BUDGET_MS)
    // The last month end's balances are the accounts' balances from every transaction to then
    const last = dates[dates.length - 1]
    const expected = transactions.filter(t => !t.voided && t.date <= last).reduce((n, t) => n + t.amount, 0)
    expect(points.filter(p => p.date === last).reduce((n, p) => n + p.balance, 0)).toBe(expected)
    expect(points).toHaveLength(accounts.length * dates.length)
    expect(historyMs).toBeLessThan(HISTORY_BUDGET_MS)
  })

  it(`keeps what an archive removes from ${TRANSACTIONS.toLocaleString('en-US')} transactions, in short stretches between turns`, async () => {
    const { service, session } = await setupAccounts()
    const { accounts, transactions } = busyLedger((await service.categories.list()).map(c => c.id))
    const data = { accounts: accounts.map(a => ({ ...a, rev: 1 })), transactions: transactions.map(t => ({ ...t, rev: 1 })), reconciliations: [] }
    const plan = planArchive(data, '2026-01-01', { removeClosedAccounts: true })

    const gaps: number[] = []
    let last = cpuUsage()
    const start = cpuUsage()
    await session.database('accounts').transaction(tx => keepArchived(collectionsOf(tx), data, plan, async () => { gaps.push(cpuSince(last)); last = cpuUsage() }))
    gaps.push(cpuSince(last))
    const all = cpuSince(start)
    const months = await session.database('accounts').collection('accounts.archivedMonths').count()
    console.log(`[scale] keepArchived: ${plan.remove.length.toLocaleString('en-US')} removed, ${months.toLocaleString('en-US')} months kept, ${gaps.length - 1} turns, ${all.toFixed(0)} ms of CPU time, at most ${Math.max(...gaps).toFixed(0)} ms between turns [${gaps.map(g => g.toFixed(0)).join(', ')}]`)

    expect(gaps.length - 1).toBeGreaterThanOrEqual(Math.floor(data.transactions.length / TOTALS_YIELD_EVERY))
    const stretches = gaps.slice(0, -1)
    expect([...stretches].sort((x, y) => x - y)[Math.floor(stretches.length / 2)]).toBeLessThan(all * TYPICAL_TURN_SHARE)
    expect(Math.max(...gaps)).toBeLessThan(all / 2)
  })

  it(`totals what an archive removes from ${TRANSACTIONS.toLocaleString('en-US')} transactions in short stretches between turns, none of them most of the work`, async () => {
    const { accounts, transactions } = busyLedger(Array.from({ length: 120 }, (_, i) => `cat-${i}`))
    const data = { accounts: accounts.map(a => ({ ...a, rev: 1 })), transactions: transactions.map(t => ({ ...t, rev: 1 })), reconciliations: [] }
    const plan = planArchive(data, '2026-01-01', { removeClosedAccounts: true })
    expect(plan.remove.length).toBeGreaterThan(80_000)

    const gaps: number[] = [], walls: number[] = []
    let last = cpuUsage(), lastWall = performance.now()
    const totals = await removedTotals(data, plan, async () => {
      gaps.push(cpuSince(last)); walls.push(performance.now() - lastWall); last = cpuUsage(); lastWall = performance.now()
    })
    gaps.push(cpuSince(last)); walls.push(performance.now() - lastWall)
    const longest = Math.max(...gaps)
    console.log(`[scale] removedTotals: ${plan.remove.length.toLocaleString('en-US')} removed, ${totals.length.toLocaleString('en-US')} rows, ${gaps.length - 1} turns, ${gaps.reduce((a, b) => a + b, 0).toFixed(0)} ms of CPU time in all, at most ${longest.toFixed(0)} ms between turns [${gaps.map(g => g.toFixed(0)).join(', ')}]; by the clock [${walls.map(g => g.toFixed(0)).join(', ')}]`)

    expect(gaps.length - 1).toBe(Math.floor(data.transactions.length / TOTALS_YIELD_EVERY))
    const removed = new Set(plan.remove)
    expect(totals.reduce((n, t) => n + t.count, 0)).toBe(transactions.filter(t => removed.has(t.id) && !t.voided).length)
    const stretches = gaps.slice(0, -1)
    const median = [...stretches].sort((x, y) => x - y)[Math.floor(stretches.length / 2)]
    const whole = gaps.reduce((sum, g) => sum + g, 0)
    expect(median).toBeLessThan(whole * TYPICAL_TURN_SHARE)
    expect(longest).toBeLessThan(whole / 2)
  })
})
