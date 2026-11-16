// @vitest-environment node
// Fill from History (docs/budget-design.md, "Filling a budget from history"): suggestions from the months before the
// lines start, and `fill`, which saves them all or none.
import { describe, expect, it } from 'vitest'
import { divideRounding } from '../../../plugins/budget/src/privileged/suggest'
import { budgetInput, household, monthly, setupBudget } from './harness'

describe('the one division', () => {
  it('rounds up, down or to the nearest exactly, as BigInt does, for any safe amount', () => {
    let seed = 9
    const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const cases: [number, number][] = [[0, 1], [1, 1], [7, 2], [5, 10], [15, 10], [Number.MAX_SAFE_INTEGER, 7], [Number.MAX_SAFE_INTEGER - 1, 2]]
    for (let i = 0; i < 5000; i++) cases.push([Math.floor(r() * Number.MAX_SAFE_INTEGER), 1 + Math.floor(r() * 24 * 100000)])
    for (const [n, d] of cases) {
      const q = BigInt(n) / BigInt(d), rest = BigInt(n) % BigInt(d)
      expect(divideRounding(n, d, 'down'), `${n} ÷ ${d}`).toBe(Number(q))
      expect(divideRounding(n, d, 'up'), `${n} ÷ ${d}`).toBe(Number(rest > 0n ? q + 1n : q))
      expect(divideRounding(n, d, 'nearest'), `${n} ÷ ${d}`).toBe(Number(rest * 2n >= BigInt(d) ? q + 1n : q))
    }
  })
})

async function history() {
  const env = await setupBudget()
  const h = await household(env)
  const budget = await env.budgets.create(budgetInput({ subLedgerId: h.personal.id }))
  const { t, pchq, visa, bchq, category } = h
  // Twelve months, March 2026 to February 2027: groceries every month, salary every month, insurance once
  for (let i = 0; i < 12; i++) {
    const month = `${2026 + Math.floor((i + 2) / 12)}-${String((i + 2) % 12 + 1).padStart(2, '0')}`
    await t(visa.id).create({ date: `${month}-05`, amount: -(60000 + i * 127), categoryId: category('Groceries') })
    await t(pchq.id).create({ date: `${month}-20`, amount: 455000 + i * 11, categoryId: category('Salary') })
    await t(bchq.id).create({ date: `${month}-25`, amount: -100000, transferAccountId: pchq.id })         // the owner's pay
  }
  await t(pchq.id).create({ date: '2026-03-15', amount: -118700, categoryId: category('Home insurance') })
  await t(pchq.id).create({ date: '2026-05-15', amount: 500, categoryId: category('Dining out') })          // only a refund
  await t(pchq.id).create({ date: '2026-06-01', amount: -999 })                                             // uncategorised
  await t(pchq.id).create({ date: '2026-02-10', amount: -500000, categoryId: category('Travel') })          // before the months looked at
  return { env, budget, ...h }
}

describe('suggestions', () => {
  it('average whole months, rounding expenses up and income down to the step; a category seen once is yearly, in its month', async () => {
    const { env, budget, category, bchq } = await history()
    const suggestions = await env.budgets.suggest(budget.id, { months: 12, start: '2027-03', step: 1000 })
    expect(suggestions.map(s => [s.label, s.group, s.frequency, s.due, s.total, s.average, s.amount])).toEqual([
      ['Salary', 'income', 'monthly', '2027-03', 5460726, 455061, 455000],
      ['Business Chequing', 'income', 'monthly', '2027-03', 1200000, 100000, 100000],
      ['Housing : Home insurance', 'expense', 'yearly', '2026-03', 118700, 9892, 119000],
      ['Food : Groceries', 'expense', 'monthly', '2027-03', 728382, 60699, 61000]
    ].sort((a, b) => (a[1] === b[1] ? 0 : a[1] === 'income' ? -1 : 1) || (b[4] as number) - (a[4] as number)))
    expect(suggestions.find(s => s.label === 'Business Chequing')?.target).toEqual({ kind: 'transfer', accountId: bchq.id, direction: 'in' })
    expect(suggestions.find(s => s.label === 'Salary')?.target).toEqual({ kind: 'category', categoryId: category('Salary') })
    // Nothing is saved
    expect(await env.budgets.lines(budget.id)).toEqual([])
  })

  it('say which ones have a line already, and look only at the months asked for', async () => {
    const { env, budget, category } = await history()
    const line = await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Groceries') }, plan: monthly(65000) })
    const three = await env.budgets.suggest(budget.id, { months: 3, start: '2027-03', step: 100 })
    expect(three.find(s => s.label === 'Food : Groceries')).toMatchObject({ existingLineId: line.id, existingPlan: monthly(65000), total: 60000 * 3 + 127 * (9 + 10 + 11), amount: 61300 })
    expect(three.find(s => s.label === 'Housing : Home insurance')).toBeUndefined()       // not in the last three months
    expect((await env.budgets.suggest(budget.id, { months: 12, start: '2027-03', step: 100 })).find(s => s.label === 'Housing : Home insurance')).toBeDefined()
  })

  it('refuse months outside 1 to 24, a start that isn\'t a month, and a step under 1', async () => {
    const { env, budget } = await history()
    const bad = (options: object) => env.budgets.suggest(budget.id, { months: 12, start: '2027-03', step: 1000, ...options }).then(() => 'ok', (e: { field: string }) => e.field)
    expect(await bad({ months: 0 })).toBe('months')
    expect(await bad({ months: 25 })).toBe('months')
    expect(await bad({ start: '2027' })).toBe('start')
    expect(await bad({ step: 0 })).toBe('step')
  })
})

describe('fill', () => {
  it('adds a line for each target without one, and a plan from the month for each with one, in one go', async () => {
    const { env, budget, category } = await history()
    const groceries = await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Groceries') }, plan: monthly(65000, '2027-01') })
    const suggestions = await env.budgets.suggest(budget.id, { months: 12, start: '2027-03', step: 1000 })
    env.budgetChanges.length = 0
    const filled = await env.budgets.fill(budget.id, suggestions.map(s => ({ target: s.target, plan: { from: '2027-03', amount: s.amount, frequency: s.frequency, due: s.due } })))
    expect(filled).toHaveLength(4)
    const lines = await env.budgets.lines(budget.id)
    expect(lines).toHaveLength(4)
    expect(lines.find(l => l.id === groceries.id)!.plans.map(p => [p.from, p.amount])).toEqual([['2027-01', 65000], ['2027-03', 61000]])
    expect(env.budgetChanges).toEqual([{ budgets: [], deleted: [], lines: [budget.id], actuals: false }])
    // The insurance, a yearly line due in March, is planned for March 2027
    const status = await env.budgets.status(budget.id, { from: '2027-03', to: '2027-03' })
    expect(status.rows.find(r => r.label === 'Home insurance')?.figures.budget).toBe(119000)
  })

  it('saves nothing when any line is wrong', async () => {
    const { env, budget, category, sav } = await history()
    const good = { target: { kind: 'category' as const, categoryId: category('Groceries') }, plan: monthly(1) }
    await expect(env.budgets.fill(budget.id, [good, { target: { kind: 'transfer', accountId: sav.id, direction: 'in' }, plan: monthly(1) }]))
      .rejects.toMatchObject({ code: 'INVALID', field: 'lines[1].target' })
    await expect(env.budgets.fill(budget.id, [good, { target: { kind: 'category', categoryId: category('Salary') }, plan: { ...monthly(1), amount: -1 } }])).rejects.toMatchObject({ field: 'lines[1].amount' })
    await expect(env.budgets.fill(budget.id, [good, good])).rejects.toMatchObject({ field: 'lines[1].target' })
    expect(await env.budgets.lines(budget.id)).toEqual([])
    expect(await env.budgets.fill(budget.id, [])).toEqual([])
  })
})
