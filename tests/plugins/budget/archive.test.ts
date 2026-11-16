// @vitest-environment node
// Archives and budgets (docs/budget-design.md, "Archives: past actuals stay true"): with the real ledger session,
// accounts and budget on a memory engine, every month's actual is the same before and after File › Archive Ledger…,
// transfers included, because the budget keeps the totals of what the accounts plugin removes.
import { describe, expect, it } from 'vitest'
import type { ClearingStatus } from '@tessera/accounts-api'
import { BUDGET_COLLECTIONS, type Budget, type BudgetStatus } from '@tessera/budget-api'
import { collectionsOf, type StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { rowRef } from '../../../plugins/budget/src/renderer/gridModel'
import { BudgetViewSupport } from '../../../plugins/budget/src/privileged/viewSupport'
import { file } from '../ledger/harness'
import { budgetInput, monthly, setupBudget } from './harness'

const NOW = () => new Date(2026, 10, 10, 12)
const YEARS = [2022, 2023, 2024, 2025, 2026]

function random(seed: number) {
  let s = seed
  const next = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const int = (n: number) => Math.floor(next() * n)
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)], date: (from = 2022, years = 5) => new Date(Date.UTC(from, 0, 1) + int(365 * years - 40) * 86400000).toISOString().slice(0, 10) }
}

/**
 * A ledger with Personal and Business sub-ledgers and an account directly in the ledger; transactions from 2022 to
 * 2026 of every status, voids, uncategorised ones and transfers, some across the sub-ledgers; a closed account in
 * Business holding only settled history with a zero balance (an archive removes it); and three budgets, over the whole
 * ledger, Personal and Business, with lines on some categories and on the accounts outside each.
 */
async function randomLedger(seed: number) {
  const env = await setupBudget({ now: NOW })
  const r = random(seed)
  const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
  const business = await env.session.createSubLedger({ name: 'Business', parentId: null })
  const make = (name: string, subLedgerId: string | null, over = {}) => env.accounts.createAccount({ name, type: 'chequing', subLedgerId, currency: 'CAD', openingDate: '2021-01-01', openingBalance: 0, ...over })
  const accounts = [await make('Chequing', personal.id), await make('Savings', personal.id), await make('Visa', personal.id, { type: 'creditCard' }),
    await make('Business Chequing', business.id), await make('Cash', null)]
  const old = await make('Old Card', business.id, { type: 'creditCard' })
  const categories = await env.accounts.categories.list()
  const stamp = '2022-01-01T00:00:00.000Z'
  const status = (): ClearingStatus => r.next() < 0.7 ? 'reconciled' : r.pick(['uncleared', 'electronic', 'cleared'] as const)
  const docs: StoredTransaction[] = []
  for (let i = 0; i < 150; i++) {
    const a = r.pick(accounts), date = r.date(), amount = r.int(60000) - 45000, voided = r.next() < 0.05
    if (r.next() < 0.2) {
      const b = r.pick(accounts.filter(o => o.id !== a.id)), transferId = `t${seed}-${i}`
      docs.push({ accountId: a.id, date, amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, transferId, transferAccountId: b.id })
      docs.push({ accountId: b.id, date, amount: -amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, transferId, transferAccountId: a.id })
    } else {
      docs.push({ accountId: a.id, date, amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, ...(r.next() < 0.9 && { categoryId: r.pick(categories).id }) })
    }
  }
  // The old card: settled 2022 history that brings it to zero, then closed
  const settled = Array.from({ length: 4 }, () => ({ accountId: old.id, date: r.date(2022, 1), amount: -(1000 + r.int(5000)), status: 'reconciled' as const, voided: false, createdAt: stamp, updatedAt: stamp, categoryId: r.pick(categories).id }))
  settled.push({ accountId: old.id, date: '2022-12-20', amount: -settled.reduce((s, x) => s + x.amount, 0), status: 'reconciled', voided: false, createdAt: stamp, updatedAt: stamp, categoryId: r.pick(categories).id })
  docs.push(...settled)
  await env.session.database('accounts').transaction(async tx => { await collectionsOf(tx).transactions.insertMany(docs) })
  await env.accounts.closeAccount(old.id)

  const budgets: Budget[] = []
  for (const [name, subLedgerId] of [['Everything', null], ['Personal', personal.id], ['Business', business.id]] as const) {
    const b = await env.budgets.create(budgetInput({ name, subLedgerId }))
    for (const c of categories) if (r.next() < 0.3) await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: c.id }, plan: monthly(r.int(40000), r.pick(['2021-01', '2023-06'])) })
    for (const a of [...accounts, old]) await env.budgets.addLine(b.id, { target: { kind: 'transfer', accountId: a.id, direction: r.pick(['in', 'out'] as const) }, plan: monthly(1000, '2021-01') }).catch(() => undefined)
    budgets.push(b)
  }
  const archive = (before: string) => env.session.runArchive({
    before, copy: { path: file(`Tessera Backups/Archives/Home (archive before ${before}).tesserabkp`), takenAt: NOW().toISOString() }
  })
  /**
   * Every budget's rows and totals, year by year, month by month: what must not change. A transfer line is known by its
   * line, not its label: an account the archive removes is then "(deleted account)", as the design says.
   */
  const snapshot = async () => {
    const all: Record<string, unknown> = {}
    for (const b of budgets) for (const year of YEARS) {
      const { rows, totals } = await env.budgets.status(b.id, { from: `${year}-01`, to: `${year}-12` }, { byMonth: true })
      all[`${b.name} ${year}`] = {
        rows: rows.map(row => row.kind === 'transferLine' || row.kind === 'deletedAccount' ? { ...row, kind: 'transfer', label: row.lineId } : row),
        totals
      }
    }
    return all
  }
  return { env, r, budgets, old, business, archive, snapshot }
}

const archivedShare = (status: BudgetStatus) => Object.values(status.archived ?? {}).reduce((s, n) => s + Math.abs(n), 0)

describe('archives and budgets', () => {
  it('leave every month\'s actual as it was, transfers included, on random ledgers', async () => {
    let archivedSome = 0, withTransfers = 0
    for (let seed = 1; seed <= 12; seed++) {
      const { env, r, budgets, archive, snapshot } = await randomLedger(seed)
      const before = r.pick(['2023-01-01', '2024-01-01', '2024-07-01', '2025-01-01', '2026-01-01'])
      const was = await snapshot()
      const outcome = await archive(before).catch(err => err as { code: string })
      if ('code' in outcome) continue
      archivedSome++
      expect(await snapshot(), `seed ${seed}, before ${before}`).toEqual(was)
      // And what is shown for the archived years now comes, in part, from the archived months
      const status = await env.budgets.status(budgets[0].id, { from: '2022-01', to: '2022-12' })
      expect(archivedShare(status), `seed ${seed}`).toBeGreaterThan(0)
      const kept = await env.session.database('budget').collection(BUDGET_COLLECTIONS.archivedMonths).find()
      if (kept.some(d => Object.keys(d.transfers as object).length > 0)) withTransfers++
    }
    expect(archivedSome).toBeGreaterThan(8)
    expect(withTransfers).toBeGreaterThan(0)
  })

  it('keep counting a closed account the archive removes, by the sub-ledger and currency it had', async () => {
    const { env, budgets, old, archive, snapshot } = await randomLedger(101)
    const was = await snapshot()
    await archive('2023-01-01')
    expect(await env.accounts.get(old.id)).toBeUndefined()            // removed: closed, nothing left, no balance
    expect(await snapshot()).toEqual(was)
    const business = budgets[2]
    expect((await env.budgets.status(business.id, { from: '2022-01', to: '2022-12' })).totals.expenses.actual).not.toBe(0)
  })

  it('add a second archive to the first', async () => {
    const { archive, snapshot, env } = await randomLedger(7)
    const was = await snapshot()
    await archive('2024-01-01')
    await archive('2025-07-01')
    expect(await snapshot()).toEqual(was)
    const kept = await env.session.database('budget').collection(BUDGET_COLLECTIONS.archivedMonths).find()
    expect(new Set(kept.map(d => `${d.accountId}|${d.month}`)).size).toBe(kept.length)        // one per account and month
  })

  it('leave nothing behind when the archive rolls back', async () => {
    const { env, archive, snapshot } = await randomLedger(3)
    env.session.participateInArchive('zzz', { describe: async () => undefined, archive: async () => { throw new Error('no') } })
    const was = await snapshot()
    await expect(archive('2025-01-01')).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' })
    expect(await env.session.database('budget').collection(BUDGET_COLLECTIONS.archivedMonths).count()).toBe(0)
    expect(await snapshot()).toEqual(was)
  })

  it('announce that actuals changed once the archive is committed', async () => {
    const { env, archive } = await randomLedger(5)
    env.budgetChanges.length = 0
    await archive('2025-01-01')
    expect(env.budgetChanges.some(c => c.actuals)).toBe(true)
  })

  it('leave the transactions behind every row adding up to its actual, less what the archive holds', async () => {
    const { env, budgets, archive } = await randomLedger(11)
    const views = new BudgetViewSupport(env.budgets, env.accounts)
    const check = async (archived: boolean) => {
      let rows = 0
      for (const b of budgets) for (const year of [2022, 2025]) {
        const months = { from: `${year}-01`, to: `${year}-12` }
        const status = await env.budgets.status(b.id, months)
        for (const [i, row] of status.rows.entries()) {
          const found = await views.rowTransactions(b.id, rowRef(row), months)
          expect(found.actual, `${b.name} ${year} ${row.label}`).toBe(row.figures.actual)
          expect(found.total + (found.archived?.amount ?? 0), row.label).toBe(row.figures.actual)
          expect(found.archived?.amount ?? 0, row.label).toBe(status.archived?.[i] ?? 0)
          expect(found.total).toBe(found.rows.reduce((sum, r) => sum + r.amount, 0))
          rows++
        }
      }
      expect(rows).toBeGreaterThan(20)
      if (archived) {
        const status = await env.budgets.status(budgets[0].id, { from: '2022-01', to: '2022-12' })
        const i = Number(Object.keys(status.archived ?? {})[0])
        expect((await views.rowTransactions(budgets[0].id, rowRef(status.rows[i]), { from: '2022-01', to: '2022-12' })).archived)
          .toMatchObject({ before: '2025-01-01' })
      }
    }
    await check(false)
    await archive('2025-01-01')
    await check(true)
  })
})
