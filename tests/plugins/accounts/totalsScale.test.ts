// @vitest-environment node
// Transaction totals at scale (docs/budget-design.md, Phase B1): ten years of a busy household, 100,000 transactions
// in 15 accounts, a tenth of them transfers. A year's totals through the service, and an archive's totals of what it
// removes, within CPU-time budgets. The budget spike measured a year at 42 to 49 ms, and an archive's totals at 0.21 to
// 0.39 s in all, on a slow VM; the budgets leave room for slower machines and a loaded test run. CPU time, unlike the clock, isn't stretched by other test files running alongside.
import { describe, expect, it } from 'vitest'
import type { TransactionTotal } from '@tessera/accounts-api'
import { planArchive, removedTotals, TOTALS_YIELD_EVERY } from '../../../plugins/accounts/src/privileged/archiveCore'
import { collectionsOf, type StoredAccount, type StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { setupAccounts } from './harness'

const YEAR_BUDGET_MS = 250
// Measured at 12 to 40 ms between turns, and 50 to 90 ms by the clock for the stretch with a young-generation garbage
// collection in it (the rows built are promoted), which no smaller step would split. CPU time counts the collector's
// parallel threads too, so under a full test run that stretch has taken 99 to 201 ms, with the whole taking 245 to
// 535 ms: no fixed limit holds for it. A loop that never yielded would do it all in one stretch. So a typical stretch
// must stay short, and the longest must be less than half of the whole
const TYPICAL_TURN_BUDGET_MS = 50
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
      transactions.push({ id, accountId: a.id, date, amount, status, voided, createdAt: stamp, updatedAt: stamp, ...(r() < 0.97 && { categoryId: categoryIds[Math.floor(r() * categoryIds.length)] }) })
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
    expect(median).toBeLessThan(TYPICAL_TURN_BUDGET_MS)
    expect(longest).toBeLessThan(gaps.reduce((sum, g) => sum + g, 0) / 2)
  })
})
