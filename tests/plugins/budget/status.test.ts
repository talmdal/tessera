// @vitest-environment node
// A budget's status: which rows it shows and their figures, through the real service, accounts and ledger session.
// The worked cases are docs/budget-design.md's ("Actuals"), as written.
import { describe, expect, it } from 'vitest'
import type { BudgetStatus, StatusRow } from '@tessera/budget-api'
import { budgetInput, household, monthly, setupBudget, type BudgetEnv } from './harness'

const MARCH = { from: '2027-03', to: '2027-03' }
const find = (status: BudgetStatus, label: string, group?: string) => {
  const row = status.rows.find(r => r.label === label && (group === undefined || r.group === group))
  if (!row) throw new Error(`no row ${label}: ${status.rows.map(r => r.label).join(', ')}`)
  return row
}
const figures = (row: StatusRow) => [row.figures.budget, row.figures.actual, row.figures.remaining]

/** The worked cases: the budget Household over Personal, and March 2027's transactions. */
async function workedCases(env: BudgetEnv) {
  const h = await household(env)
  const { category, t, pchq, sav, visa, usVisa, bchq, rchq } = h
  const budget = await env.budgets.create(budgetInput({ subLedgerId: h.personal.id }))
  const food = await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Food') }, plan: monthly(15000) })
  const groceries = await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Groceries') }, plan: monthly(65000) })
  const pay = await env.budgets.addLine(budget.id, { target: { kind: 'transfer', accountId: bchq.id, direction: 'in' }, plan: monthly(300000, '2027-01', { due: '2027-01-25' }) })
  // Nine groceries on chequing and the Visa, 598.30 in all
  for (const [i, amount] of [-6000, -7000, -5500, -8000, -6230, -7100, -6400, -6600, -7000].entries()) {
    await t(i % 2 === 0 ? pchq.id : visa.id).create({ date: `2027-03-0${i + 1}`, amount, categoryId: category('Groceries') })
  }
  await t(visa.id).create({ date: '2027-03-10', amount: -4500, categoryId: category('Dining out') })
  await t(visa.id).create({ date: '2027-03-11', amount: 2000, categoryId: category('Dining out') })
  await t(bchq.id).create({ date: '2027-03-25', amount: -300000, transferAccountId: pchq.id })         // the owner's pay
  await t(pchq.id).create({ date: '2027-03-12', amount: -50000, transferAccountId: sav.id })           // to savings, inside
  await t(pchq.id).create({ date: '2027-03-13', amount: -12000, transferAccountId: rchq.id })          // to Rentals, outside
  const phone = await t(pchq.id).create({ date: '2027-03-14', amount: -8000, categoryId: category('Phone') })
  await t(pchq.id).setVoided([phone.id], true)
  await t(pchq.id).create({ date: '2027-03-15', amount: -4100 })                                      // a balance adjustment
  await t(pchq.id).create({ date: '2027-03-16', amount: 15000, categoryId: category('Gifts received') })
  await t(visa.id).create({ date: '2027-03-17', amount: -8620, categoryId: category('Entertainment') })
  await t(usVisa.id).create({ date: '2027-03-18', amount: -30000, categoryId: category('Travel') })
  await t(pchq.id).create({ date: '2027-04-01', amount: -150000, number: '104' })                     // cheque 104, April
  return { ...h, budget, food, groceries, pay }
}

describe('the worked cases', () => {
  it('put each transaction where the design says', async () => {
    const env = await setupBudget()
    const { budget, category, bchq, rchq, usVisa, food, groceries, pay } = await workedCases(env)
    const status = await env.budgets.status(budget.id, MARCH)

    expect(status.rows.map(r => [r.kind, r.group, r.depth, r.label])).toEqual([
      ['transferLine', 'income', 0, 'Transfers from Business Chequing'],
      ['other', 'income', 0, 'Other income'],
      ['subtotal', 'expense', 0, 'Food'],
      ['line', 'expense', 1, 'Groceries'],
      ['parentLine', 'expense', 1, 'Food (other)'],
      ['other', 'expense', 0, 'Other expenses'],
      ['otherTransfers', 'expense', 0, 'Other transfers out'],
      ['uncategorised', 'expense', 0, 'Uncategorised']
    ])
    expect(figures(find(status, 'Groceries'))).toEqual([65000, 59830, 5170])
    expect(figures(find(status, 'Food (other)'))).toEqual([15000, 2500, 12500])         // dining out 45.00 less a 20.00 refund
    expect(figures(find(status, 'Food'))).toEqual([80000, 62330, 17670])
    expect(figures(find(status, 'Transfers from Business Chequing'))).toEqual([300000, 300000, 0])
    expect(find(status, 'Other income')).toMatchObject({ figures: { budget: 0, actual: 15000, remaining: -15000 }, breakdown: [{ id: category('Gifts received'), label: 'Gifts received', actual: 15000 }] })
    expect(find(status, 'Other expenses').breakdown).toEqual([{ id: category('Entertainment'), label: 'Entertainment', actual: 8620 }])
    expect(find(status, 'Other transfers out')).toMatchObject({ figures: { actual: 12000 }, breakdown: [{ id: rchq.id, label: 'Rental Chequing', actual: 12000 }] })
    expect(figures(find(status, 'Uncategorised'))).toEqual([0, 4100, -4100])
    expect(status.notCounted).toEqual([{ accountId: usVisa.id, name: 'US Visa', currency: 'USD' }])
    // Ids, and the days a line falls due in the month
    expect(find(status, 'Groceries')).toMatchObject({ lineId: groceries.id, categoryId: category('Groceries'), due: [] })
    expect(find(status, 'Food (other)')).toMatchObject({ lineId: food.id })
    expect(find(status, 'Transfers from Business Chequing')).toMatchObject({ lineId: pay.id, accountId: bchq.id, due: [25] })

    expect(status.totals).toEqual({
      income: { budget: 300000, actual: 315000, remaining: -15000 },
      expenses: { budget: 80000, actual: 87050, remaining: -7050 },
      net: { budget: 220000, actual: 227950, remaining: 7950 }      // 79.50 ahead of the plan
    })
    expect(status.archived).toBeUndefined()

    // Cheque 104, entered in March and dated 1 April, is April's
    const april = await env.budgets.status(budget.id, { from: '2027-04', to: '2027-04' })
    expect(figures(find(april, 'Uncategorised'))).toEqual([0, 150000, -150000])
  })

  it('give the net\'s Remaining as how far the month is ahead of the plan: expenses\' remaining less income\'s', async () => {
    const env = await setupBudget()
    const { budget } = await workedCases(env)
    const { totals } = await env.budgets.status(budget.id, MARCH)
    expect(totals.net.remaining).toBe(totals.expenses.remaining - totals.income.remaining)
    expect(totals.net.remaining).toBe(totals.net.actual - totals.net.budget)
  })
})

describe('which line a transaction counts toward', () => {
  async function food() {
    const env = await setupBudget()
    const h = await household(env)
    const budget = await env.budgets.create(budgetInput())
    return { env, ...h, budget }
  }

  it('a category\'s own line; else its nearest parent\'s; else Other, by the category\'s kind', async () => {
    const { env, budget, category, t, pchq } = await food()
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Food') }, plan: monthly(50000) })
    await t(pchq.id).create({ date: '2027-03-02', amount: -1000, categoryId: category('Groceries') })
    await t(pchq.id).create({ date: '2027-03-03', amount: -2000, categoryId: category('Food') })
    await t(pchq.id).create({ date: '2027-03-04', amount: -4000, categoryId: category('Fuel') })
    await t(pchq.id).create({ date: '2027-03-05', amount: 8000, categoryId: category('Interest') })
    const status = await env.budgets.status(budget.id, MARCH)
    expect(status.rows.map(r => [r.kind, r.label, r.figures.actual])).toEqual([
      ['other', 'Other income', 8000],
      ['line', 'Food', 3000],
      ['other', 'Other expenses', 4000]
    ])
    expect(find(status, 'Other expenses').breakdown).toEqual([{ id: category('Fuel'), label: 'Transportation : Fuel', actual: 4000 }])
  })

  it('a subtotal for a parent with no line of its own, over its children\'s lines', async () => {
    const { env, budget, category, t, pchq } = await food()
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Groceries') }, plan: monthly(60000) })
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Dining out') }, plan: monthly(20000) })
    await t(pchq.id).create({ date: '2027-03-02', amount: -1000, categoryId: category('Groceries') })
    await t(pchq.id).create({ date: '2027-03-03', amount: -2000, categoryId: category('Food') })      // the parent itself: no line
    const status = await env.budgets.status(budget.id, MARCH)
    expect(status.rows.map(r => [r.kind, r.depth, r.label, r.figures.budget, r.figures.actual])).toEqual([
      ['subtotal', 0, 'Food', 80000, 1000],
      ['line', 1, 'Dining out', 20000, 0],
      ['line', 1, 'Groceries', 60000, 1000],
      ['other', 0, 'Other expenses', 0, 2000]
    ])
  })

  it('no line before its first plan\'s month: its category counts under the next line up, or Other', async () => {
    const { env, budget, category, t, pchq } = await food()
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Food') }, plan: monthly(50000, '2027-01') })
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Groceries') }, plan: monthly(30000, '2027-03') })
    await t(pchq.id).create({ date: '2027-02-02', amount: -1000, categoryId: category('Groceries') })
    await t(pchq.id).create({ date: '2027-03-02', amount: -2000, categoryId: category('Groceries') })
    const status = await env.budgets.status(budget.id, { from: '2027-02', to: '2027-03' }, { byMonth: true })
    expect(figures(find(status, 'Food (other)'))).toEqual([100000, 1000, 99000])       // February's groceries
    expect(figures(find(status, 'Groceries'))).toEqual([30000, 2000, 28000])
    expect(find(status, 'Groceries').months!.map(m => [m.budget, m.actual])).toEqual([[0, 0], [30000, 2000]])
  })

  it('a line whose category is gone, as (deleted category), with its budget and no actual', async () => {
    const { env, budget, category, t, pchq } = await food()
    await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: category('Childcare') }, plan: monthly(40000) })
    await t(pchq.id).create({ date: '2027-03-02', amount: -1000, categoryId: category('Childcare') })
    // No category manager yet: remove it as one will
    await env.session.database('accounts').collection('accounts.categories').deleteOne({ id: category('Childcare') })
    const status = await env.budgets.status(budget.id, MARCH)
    expect(status.rows.map(r => [r.kind, r.label, r.figures.budget, r.figures.actual])).toEqual([
      ['deletedCategory', '(deleted category)', 40000, 0],
      ['uncategorised', 'Uncategorised', 0, 1000]
    ])
  })
})

describe('what counts', () => {
  it('the accounts of the budget\'s sub-ledger and every sub-ledger beneath it, closed ones too, and future-dated transactions', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const kids = await env.session.createSubLedger({ name: 'Kids', parentId: h.personal.id })
    const allowance = await env.accounts.createAccount({ name: 'Allowance', type: 'cash', subLedgerId: kids.id, currency: 'CAD', openingDate: '2020-01-01', openingBalance: 0 })
    const budget = await env.budgets.create(budgetInput({ subLedgerId: h.personal.id }))
    await h.t(allowance.id).create({ date: '2027-03-02', amount: -500, categoryId: h.category('Entertainment') })
    await h.t(h.visa.id).create({ date: '2027-03-30', amount: -700, categoryId: h.category('Entertainment') })   // after today
    await h.t(h.bchq.id).create({ date: '2027-03-03', amount: -900, categoryId: h.category('Entertainment') })  // Business: not counted
    await env.accounts.closeAccount(h.visa.id, { confirm: ['closeWithBalance'] })
    const status = await env.budgets.status(budget.id, MARCH)
    expect(find(status, 'Other expenses').figures.actual).toBe(1200)
  })

  it('a whole-ledger budget counts every account in its currency, and names the others', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const budget = await env.budgets.create(budgetInput())
    await h.t(h.bchq.id).create({ date: '2027-03-03', amount: -900, categoryId: h.category('Entertainment') })
    await h.t(h.usVisa.id).create({ date: '2027-03-03', amount: -300, categoryId: h.category('Entertainment') })
    const status = await env.budgets.status(budget.id, MARCH)
    expect(find(status, 'Other expenses').figures.actual).toBe(900)
    expect(status.notCounted.map(n => n.name)).toEqual(['US Visa'])
    // And a budget in US dollars counts only that one
    const usd = await env.budgets.create(budgetInput({ name: 'Travel', currency: 'USD' }))
    expect(find(await env.budgets.status(usd.id, MARCH), 'Other expenses').figures.actual).toBe(300)
  })
})

describe('figures', () => {
  it('warn for expense lines reaching the share, or over their budget; never for income', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const budget = await env.budgets.create(budgetInput())
    const line = (name: string, amount: number) => env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: h.category(name) }, plan: monthly(amount) })
    await line('Rent', 100000); await line('Fuel', 10000); await line('Phone', 10000); await line('Salary', 100000)
    await h.t(h.pchq.id).create({ date: '2027-03-01', amount: -89900, categoryId: h.category('Rent') })    // 89.9 %
    await h.t(h.pchq.id).create({ date: '2027-03-01', amount: -9000, categoryId: h.category('Fuel') })     // 90 %
    await h.t(h.pchq.id).create({ date: '2027-03-01', amount: -10001, categoryId: h.category('Phone') })   // over
    await h.t(h.pchq.id).create({ date: '2027-03-01', amount: 200000, categoryId: h.category('Salary') })  // income: more came in
    const status = await env.budgets.status(budget.id, MARCH)
    expect(['Rent', 'Fuel', 'Phone', 'Salary'].map(name => find(status, name).warning)).toEqual([undefined, 'near', 'over', undefined])
    expect(find(status, 'Transportation').warning).toBe('near')          // a subtotal warns too
    // A line stopped with a plan of 0, and spent on all the same, is over its budget; one with nothing spent is not
    const stopped = await line('Internet', 5000)
    await env.budgets.changeLine(stopped.id, { apply: 'from', plan: monthly(0, '2027-03') })
    await line('Water', 0)
    await h.t(h.pchq.id).create({ date: '2027-03-02', amount: -1, categoryId: h.category('Internet') })
    const withStopped = await env.budgets.status(budget.id, MARCH)
    expect(find(withStopped, 'Internet').warning).toBe('over')
    expect(find(withStopped, 'Water').warning).toBeUndefined()
    const at80 = await env.budgets.status(budget.id, MARCH, { warnAtPercent: 80 })
    expect(find(at80, 'Rent').warning).toBe('near')
    expect(figures(find(status, 'Salary'))).toEqual([100000, 200000, -100000])
  })

  it('follow the plan\'s frequency, a month\'s own amount, and due days, month by month', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const budget = await env.budgets.create(budgetInput())
    const pay = await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: h.category('Salary') }, plan: { from: '2027-01', amount: 210000, frequency: 'everyTwoWeeks', due: '2027-01-08' } })
    await env.budgets.changeLine(pay.id, { apply: 'only', month: '2027-02', amount: 1 })
    const status = await env.budgets.status(budget.id, { from: '2027-01', to: '2027-04' }, { byMonth: true })
    expect(find(status, 'Salary').months!.map(m => m.budget)).toEqual([420000, 1, 420000, 630000])
    expect(find(status, 'Salary').ownMonths).toEqual(['2027-02'])   // what the year grid marks with a dot
    expect(find(status, 'Salary').due).toBeUndefined()       // only for a single month
    expect(status.monthlyTotals!.map(t => t.income.budget)).toEqual([420000, 1, 420000, 630000])
    expect(find(await env.budgets.status(budget.id, { from: '2027-03', to: '2027-04' }), 'Salary')).not.toHaveProperty('ownMonths')
    expect(find(await env.budgets.status(budget.id, { from: '2027-04', to: '2027-04' }), 'Salary').due).toEqual([2, 16, 30])
  })

  it('refuse months that aren\'t YYYY-MM, run backwards, or number more than 24, and a share outside 1 to 100', async () => {
    const env = await setupBudget()
    const budget = await env.budgets.create(budgetInput())
    const bad = (work: Promise<unknown>) => work.then(() => 'ok', (e: { code: string, field?: string }) => `${e.code} ${e.field}`)
    expect(await bad(env.budgets.status(budget.id, { from: '2027-3', to: '2027-03' }))).toBe('INVALID months')
    expect(await bad(env.budgets.status(budget.id, { from: '2027-04', to: '2027-03' }))).toBe('INVALID months')
    expect(await bad(env.budgets.status(budget.id, { from: '2025-01', to: '2027-01' }))).toBe('INVALID months')
    expect(await bad(env.budgets.status(budget.id, { from: '2025-02', to: '2027-01' }))).toBe('ok')
    expect(await bad(env.budgets.status(budget.id, MARCH, { warnAtPercent: 0 }))).toBe('INVALID warnAtPercent')
    expect(await bad(env.budgets.status('nope', MARCH))).toBe('NOT_FOUND budgetId')
  })
})

// ---- Every counted transaction in exactly one row, on random ledgers

function random(seed: number) {
  let s = seed
  const next = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] }
}

describe('on random ledgers', () => {
  it('every counted transaction is in exactly one row that isn\'t a subtotal, so rows add up to the totals, and the net to the transactions', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const env = await setupBudget()
      const h = await household(env)
      const r = random(seed)
      const all = [h.pchq, h.sav, h.visa, h.usVisa, h.bchq, h.rchq]
      const categories = await env.accounts.categories.list()
      for (let i = 0; i < 80; i++) {
        const a = r.pick(all), date = `2027-0${1 + r.int(3)}-${String(1 + r.int(28)).padStart(2, '0')}`, amount = r.int(40000) - 30000
        const others = all.filter(o => o.id !== a.id && o.currency === a.currency)
        const made = r.next() < 0.2 && others.length > 0
          ? await h.t(a.id).create({ date, amount, transferAccountId: r.pick(others).id })
          : await h.t(a.id).create({ date, amount, ...(r.next() < 0.9 && { categoryId: r.pick(categories).id }) })
        if (r.next() < 0.05) await h.t(a.id).setVoided([made.id], true)
      }
      for (const subLedgerId of [null, h.personal.id, h.business.id]) {
        const budget = await env.budgets.create(budgetInput({ name: `B${seed} ${subLedgerId}`, subLedgerId }))
        for (const c of categories) if (r.next() < 0.25) await env.budgets.addLine(budget.id, { target: { kind: 'category', categoryId: c.id }, plan: monthly(r.int(50000), r.pick(['2027-01', '2027-02', '2027-03'])) })
        for (const a of all) {
          if (r.next() < 0.5) await env.budgets.addLine(budget.id, { target: { kind: 'transfer', accountId: a.id, direction: r.pick(['in', 'out'] as const) }, plan: monthly(1000) }).catch(() => undefined)
        }
        const range = { from: '2027-01', to: '2027-03' }
        const status = await env.budgets.status(budget.id, range, { byMonth: true })
        // The net of what counts, worked out independently from the registers
        const scope = (await env.accounts.list()).filter(a => subLedgerId === null || a.subLedgerId === subLedgerId)
        const inside = new Set(scope.map(a => a.id))
        let net = 0
        for (const a of scope.filter(x => x.currency === 'CAD')) {
          for (const x of await h.t(a.id).list({ from: '2027-01-01', to: '2027-03-31' })) {
            if (x.voided || (x.transferAccountId !== undefined && inside.has(x.transferAccountId))) continue
            net += x.amount
          }
        }
        const label = `seed ${seed}, ${subLedgerId ?? 'ledger'}`
        const counted = status.rows.filter(row => row.kind !== 'subtotal')
        const sumOf = (group: string) => counted.filter(row => row.group === group).reduce((s, row) => s + row.figures.actual, 0)
        expect(sumOf('income') - sumOf('expense'), label).toBe(net)
        expect(status.totals.net.actual, label).toBe(net)
        expect(status.totals.income.actual, label).toBe(sumOf('income'))
        // The months' totals add up to the period's (the year grid's total rows and Total column agree)
        for (const side of ['income', 'expenses', 'net'] as const) for (const f of ['budget', 'actual', 'remaining'] as const) {
          expect(status.monthlyTotals!.reduce((sum, t) => sum + t[side][f], 0), `${label} ${side} ${f}`).toBe(status.totals[side][f])
        }
        // Subtotals are their children's sums
        for (const [i, row] of status.rows.entries()) {
          if (row.kind !== 'subtotal') continue
          const children = []
          for (let j = i + 1; j < status.rows.length && status.rows[j].depth > row.depth; j++) if (status.rows[j].depth === row.depth + 1) children.push(status.rows[j])
          expect(row.figures.actual, `${label}, ${row.label}`).toBe(children.reduce((s, c) => s + c.figures.actual, 0))
          expect(row.figures.budget, `${label}, ${row.label}`).toBe(children.reduce((s, c) => s + c.figures.budget, 0))
        }
      }
    }
  })
})
