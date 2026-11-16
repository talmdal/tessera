// @vitest-environment node
// Transfers across a budget's scope (docs/budget-design.md, "Transfers across the budget's scope", decided in review,
// Q4): a transfer counts for a budget exactly when one of its accounts is in the scope and the other isn't, from the
// side inside, as income or an expense.
import { describe, expect, it } from 'vitest'
import type { BudgetStatus } from '@tessera/budget-api'
import { budgetInput, household, monthly, setupBudget } from './harness'

const MARCH = { from: '2027-03', to: '2027-03' }
const rowsOf = (status: BudgetStatus) => status.rows.map(r => [r.kind, r.group, r.label, r.figures.actual])

async function owner() {
  const env = await setupBudget()
  const h = await household(env)
  // The business pays its owner 3,000.00 in March
  await h.t(h.bchq.id).create({ date: '2027-03-25', amount: -300000, transferAccountId: h.pchq.id })
  const personal = await env.budgets.create(budgetInput({ name: 'Household', subLedgerId: h.personal.id }))
  const business = await env.budgets.create(budgetInput({ name: 'Business', subLedgerId: h.business.id }))
  const everything = await env.budgets.create(budgetInput({ name: 'Everything', subLedgerId: null }))
  return { env, ...h, personal, business, everything }
}

describe('the owner\'s pay', () => {
  it('is an expense for the Business budget, income for the Personal one, and nothing for the whole ledger\'s', async () => {
    const { env, personal, business, everything } = await owner()
    expect(rowsOf(await env.budgets.status(business.id, MARCH))).toEqual([['otherTransfers', 'expense', 'Other transfers out', 300000]])
    expect(rowsOf(await env.budgets.status(personal.id, MARCH))).toEqual([['otherTransfers', 'income', 'Other transfers in', 300000]])
    expect(rowsOf(await env.budgets.status(everything.id, MARCH))).toEqual([])
  })

  it('counts toward a line of transfers from, or to, the other account', async () => {
    const { env, personal, business, bchq, pchq } = await owner()
    await env.budgets.addLine(personal.id, { target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: monthly(300000) })
    await env.budgets.addLine(business.id, { target: { kind: 'transfer', accountId: pchq.id, direction: 'out' }, plan: monthly(250000) })
    expect(rowsOf(await env.budgets.status(personal.id, MARCH))).toEqual([['transferLine', 'income', 'Transfers from Business Chequing', 300000]])
    const b = await env.budgets.status(business.id, MARCH)
    expect(rowsOf(b)).toEqual([['transferLine', 'expense', 'Transfers to Personal Chequing', 300000]])
    expect(b.rows[0]).toMatchObject({ figures: { budget: 250000, remaining: -50000 }, warning: 'over' })
  })

  it('nets a repayment against the line, both ways, as a category nets a refund', async () => {
    const { env, personal, bchq, pchq, t } = await owner()
    await t(pchq.id).create({ date: '2027-03-28', amount: -40000, transferAccountId: bchq.id })         // some paid back
    await env.budgets.addLine(personal.id, { target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: monthly(300000) })
    expect(rowsOf(await env.budgets.status(personal.id, MARCH))).toEqual([['transferLine', 'income', 'Transfers from Business Chequing', 260000]])
  })

  it('without a line, goes in Other transfers in or out by which way each went', async () => {
    const { env, personal, bchq, pchq, rchq, t } = await owner()
    await t(pchq.id).create({ date: '2027-03-28', amount: -40000, transferAccountId: bchq.id })
    await t(pchq.id).create({ date: '2027-03-29', amount: -12000, transferAccountId: rchq.id })
    const status = await env.budgets.status(personal.id, MARCH)
    expect(rowsOf(status)).toEqual([
      ['otherTransfers', 'income', 'Other transfers in', 300000],
      ['otherTransfers', 'expense', 'Other transfers out', 52000]
    ])
    expect(status.rows[1].breakdown).toEqual([
      { id: bchq.id, label: 'Business Chequing', actual: 40000 },
      { id: rchq.id, label: 'Rental Chequing', actual: 12000 }
    ])
  })
})

describe('transfers inside the scope', () => {
  it('count nowhere: chequing to savings is the budget\'s own money', async () => {
    const { env, personal, pchq, sav, t } = await owner()
    await t(pchq.id).create({ date: '2027-03-12', amount: -50000, transferAccountId: sav.id })
    const status = await env.budgets.status(personal.id, MARCH)
    expect(status.totals.net.actual).toBe(300000)                   // only the owner's pay
  })

  it('are refused as lines', async () => {
    const { env, personal, sav } = await owner()
    await expect(env.budgets.addLine(personal.id, { target: { kind: 'transfer', accountId: sav.id, direction: 'out' }, plan: monthly(1000) }))
      .rejects.toMatchObject({ code: 'INVALID', field: 'target', message: '“Savings” is one of this budget’s accounts: moving money to it or from it isn’t income or spending.' })
  })
})

describe('the other account, judged where it is now', () => {
  it('moved into the scope: its transfers stay inside, and its line shows nothing, for every month', async () => {
    const { env, personal, bchq } = await owner()
    await env.budgets.addLine(personal.id, { target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: monthly(300000) })
    await env.accounts.moveAccount(bchq.id, (await env.budgets.get(personal.id))!.subLedgerId)
    const status = await env.budgets.status(personal.id, MARCH)
    expect(rowsOf(status)).toEqual([['transferLine', 'income', 'Transfers from Business Chequing', 0]])
  })

  it('deleted: its line is (deleted account), and the other sides of its transfers are uncategorised', async () => {
    const { env, personal, bchq } = await owner()
    await env.budgets.addLine(personal.id, { target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: monthly(300000) })
    await env.accounts.deleteAccount(bchq.id)
    expect(rowsOf(await env.budgets.status(personal.id, MARCH))).toEqual([
      ['deletedAccount', 'income', '(deleted account)', 0],
      ['uncategorised', 'income', 'Uncategorised', 300000]
    ])
  })
})
