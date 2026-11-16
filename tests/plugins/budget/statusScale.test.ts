// @vitest-environment node
// A budget's status at scale: a year, month by month (the year grid), over ten years of a busy household, 100,000
// transactions in 15 accounts across three sub-ledgers, with a line for every starter category and five transfer
// lines. Everything a status does: the scope, the accounts' totals for the year, the archived months, and the rows. The design estimated 60 to 90 ms for the year view's
// refresh at 100,000 (docs/budget-design.md, Phase B0 results); the budget leaves room for slower machines and a loaded
// run. CPU time, as the other scale tests measure, isn't stretched by other test files running alongside.
import { describe, expect, it } from 'vitest'
import type { StoredAccount, StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { collectionsOf } from '../../../plugins/accounts/src/privileged/store'
import { budgetInput, monthly, setupBudget } from './harness'

const BUDGET_MS = 500
const TRANSACTIONS = 100_000

const cpuSince = (start: NodeJS.CpuUsage) => { const used = process.cpuUsage(start); return (used.user + used.system) / 1000 }

describe('a budget\'s status at scale', () => {
  it(`gives a year, month by month, over ${TRANSACTIONS.toLocaleString('en-US')} transactions within ${BUDGET_MS} ms of CPU time`, { timeout: 60_000 }, async () => {
    const env = await setupBudget()
    const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
    const business = await env.session.createSubLedger({ name: 'Business', parentId: null })
    const categories = await env.accounts.categories.list()
    let seed = 11
    const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const subLedgers = [null, personal.id, business.id]
    const accounts: (StoredAccount & { id: string })[] = Array.from({ length: 15 }, (_, i) => ({
      id: `acct-${i}`, subLedgerId: subLedgers[i % 3], name: `Account ${i}`, nameKey: `account ${i}`, type: 'chequing', currency: 'CAD',
      openingDate: '2017-01-01', openingBalance: 0, closed: false, order: i
    }))
    const stamp = '2017-01-01T00:00:00.000Z'
    const transactions: (StoredTransaction & { id: string })[] = []
    while (transactions.length < TRANSACTIONS) {
      const a = accounts[Math.floor(r() * 15)], date = new Date(Date.UTC(2017, 0, 1) + Math.floor(r() * 3650) * 86400000).toISOString().slice(0, 10)
      const id = `t${transactions.length}`, amount = Math.round((r() - 0.85) * 20000)
      if (r() < 0.05) {
        const b = accounts[(accounts.indexOf(a) + 1 + Math.floor(r() * 14)) % 15]
        transactions.push({ id, accountId: a.id, date, amount, status: 'cleared', voided: false, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: b.id })
        transactions.push({ id: `${id}b`, accountId: b.id, date, amount: -amount, status: 'cleared', voided: false, createdAt: stamp, updatedAt: stamp, transferId: id, transferAccountId: a.id })
      } else {
        transactions.push({ id, accountId: a.id, date, amount, status: 'cleared', voided: false, createdAt: stamp, updatedAt: stamp, categoryId: categories[Math.floor(r() * categories.length)].id })
      }
    }
    await env.session.database('accounts').transaction(async tx => {
      const c = collectionsOf(tx)
      await c.accounts.insertMany(accounts)
      await c.transactions.insertMany(transactions)
    })
    const budget = await env.budgets.create(budgetInput({ subLedgerId: personal.id }))
    await env.budgets.fill(budget.id, categories.map(c => ({ target: { kind: 'category' as const, categoryId: c.id }, plan: monthly(50000, '2026-01') })))
    await env.budgets.fill(budget.id, accounts.filter(a => a.subLedgerId !== personal.id).slice(0, 5).map(a => ({ target: { kind: 'transfer' as const, accountId: a.id, direction: 'in' as const }, plan: monthly(1000, '2026-01') })))

    const lines = (await env.budgets.lines(budget.id)).length                  // every starter category (42) and 5 transfer lines
    const year = { from: '2026-01', to: '2026-12' }
    await env.budgets.status(budget.id, year, { byMonth: true })              // warm
    const times: number[] = []
    let rows = 0
    for (let i = 0; i < 3; i++) {
      const start = process.cpuUsage()
      rows = (await env.budgets.status(budget.id, year, { byMonth: true })).rows.length
      times.push(cpuSince(start))
    }
    const ms = times.sort((a, b) => a - b)[1]
    console.log(`[scale] budget status: a year month by month, ${TRANSACTIONS.toLocaleString('en-US')} transactions, ${lines} lines, ${rows} rows, in ${ms.toFixed(0)} ms of CPU time`)
    expect(rows).toBeGreaterThan(lines)
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
