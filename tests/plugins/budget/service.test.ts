// @vitest-environment node
// `budget.service`'s rules: budgets, lines and plans, the limits, conflicts, read-only ledgers and no ledger, and what
// it announces. Through a real ledger session and accounts service (memory engine).
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META } from '@tessera/ledger-api'
import { BUDGET_AMOUNT_MAX, BUDGET_COLLECTIONS, BUDGET_LINES_MAX, type BudgetLine } from '@tessera/budget-api'
import type { StoredLine } from '../../../plugins/budget/src/privileged/store'
import { DIR } from '../ledger/harness'
import { budgetInput, categoryNamed, household, monthly, setupBudget } from './harness'

const error = (work: Promise<unknown>) => work.then(() => 'ok', (e: { code: string, field?: string, message: string }) => `${e.code} ${e.field ?? ''}`.trim())

describe('budgets', () => {
  it('are created with their fields checked, listed by name, and read back', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create({ name: '  Household ', subLedgerId: h.personal.id, currency: 'cad', yearStartMonth: 4, notes: ' For the house ' })
    expect(b).toMatchObject({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 4, notes: 'For the house', createdAt: '2026-11-15T12:00:00.000Z' })
    expect(b).not.toHaveProperty('nameKey')
    await env.budgets.create(budgetInput({ name: 'Business' }))
    expect((await env.budgets.list()).map(x => x.name)).toEqual(['Business', 'Household'])
    expect(await env.budgets.get(b.id)).toEqual(b)
    expect(await env.budgets.get('nope')).toBeUndefined()
  })

  it('refuse a name taken (ignoring case), a bad name, a sub-ledger that doesn\'t exist, an unknown currency and a year start outside 1 to 12', async () => {
    const env = await setupBudget()
    await env.budgets.create(budgetInput())
    expect(await error(env.budgets.create(budgetInput({ name: 'HOUSEHOLD' })))).toBe('DUPLICATE_NAME name')
    expect(await error(env.budgets.create(budgetInput({ name: '  ' })))).toBe('INVALID name')
    expect(await error(env.budgets.create(budgetInput({ name: 'a/b' })))).toBe('INVALID name')
    expect(await error(env.budgets.create(budgetInput({ name: 'x', subLedgerId: 'nope' })))).toBe('NOT_FOUND subLedgerId')
    expect(await error(env.budgets.create(budgetInput({ name: 'x', currency: 'XYZ' })))).toBe('INVALID currency')
    expect(await error(env.budgets.create(budgetInput({ name: 'x', yearStartMonth: 13 })))).toBe('INVALID yearStartMonth')
    expect(await error(env.budgets.create(budgetInput({ name: 'x', notes: 'x'.repeat(2001) })))).toBe('INVALID notes')
  })

  it('change only the fields given, keep their name unique, and refuse a stale revision', async () => {
    const env = await setupBudget()
    const b = await env.budgets.create(budgetInput({ notes: 'n' }))
    await env.budgets.create(budgetInput({ name: 'Other' }))
    const renamed = await env.budgets.update(b.id, { name: 'Home' }, { expectedRev: b.rev })
    expect(renamed).toMatchObject({ name: 'Home', currency: 'CAD', notes: 'n', createdAt: b.createdAt })
    expect(await error(env.budgets.update(b.id, { name: 'other' }))).toBe('DUPLICATE_NAME name')
    expect(await error(env.budgets.update(b.id, { yearStartMonth: 6 }, { expectedRev: b.rev }))).toBe('CONFLICT')
    expect(await env.budgets.update(b.id, { name: 'home' })).toMatchObject({ name: 'home' })     // its own name, recased
    expect(await env.budgets.update(b.id, { notes: null as unknown as string })).not.toHaveProperty('notes')
    expect(await error(env.budgets.update('nope', { name: 'x' }))).toBe('NOT_FOUND budgetId')
  })

  it('duplicate with every line, plan and month\'s own amount, under a new name; delete with their lines', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput())
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(150000), notes: 'Lease' })
    await env.budgets.changeLine(line.id, { apply: 'only', month: '2027-12', amount: 0 })
    const copy = await env.budgets.duplicate(b.id, 'Lean year')
    expect(copy).toMatchObject({ name: 'Lean year', subLedgerId: null, currency: 'CAD' })
    const [copied] = await env.budgets.lines(copy.id)
    expect(copied).toMatchObject({ budgetId: copy.id, target: line.target, plans: line.plans, overrides: { '2027-12': 0 }, notes: 'Lease' })
    expect(copied.id).not.toBe(line.id)
    expect(await error(env.budgets.duplicate(b.id, 'household'))).toBe('DUPLICATE_NAME name')

    await env.budgets.delete(b.id)
    expect(await env.budgets.get(b.id)).toBeUndefined()
    expect(await env.session.database('budget').collection(BUDGET_COLLECTIONS.lines).count({ budgetId: b.id })).toBe(0)
    expect(await env.budgets.lines(copy.id)).toHaveLength(1)
    expect(await error(env.budgets.delete(b.id))).toBe('NOT_FOUND budgetId')
  })
})

describe('a budget\'s currency', () => {
  it('can change to one with other decimals only while the budget has no lines: its amounts would mean other amounts', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput())
    expect(await env.budgets.update(b.id, { currency: 'JPY' })).toMatchObject({ currency: 'JPY' })      // no lines yet
    await env.budgets.update(b.id, { currency: 'CAD' })
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(65000) })
    await expect(env.budgets.update(b.id, { currency: 'JPY' })).rejects.toMatchObject({
      code: 'INVALID', field: 'currency',
      message: '“Household” is planned in CAD, which has 2 decimal places; JPY has no decimal places, so its amounts would change. Make a new budget to plan in JPY.'
    })
    expect((await env.budgets.get(b.id))?.currency).toBe('CAD')
    // The same decimals: the amounts keep their meaning as numbers, as the Properties dialog says
    expect(await env.budgets.update(b.id, { currency: 'USD' })).toMatchObject({ currency: 'USD' })
  })

  it('takes only a budget\'s own fields from a patch', async () => {
    const env = await setupBudget()
    const b = await env.budgets.create(budgetInput())
    const updated = await env.budgets.update(b.id, { name: 'Home', nameKey: 'sneaky', createdAt: 'then' } as never)
    expect(updated).toMatchObject({ name: 'Home', createdAt: b.createdAt })
    expect(await env.budgets.list()).toEqual([updated])
  })
})

describe('lines', () => {
  it('are one per category and one per account transferred with, in each budget', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput({ subLedgerId: h.personal.id }))
    const other = await env.budgets.create(budgetInput({ name: 'Other', subLedgerId: h.personal.id }))
    const rent = { kind: 'category' as const, categoryId: h.category('Rent') }
    await env.budgets.addLine(b.id, { target: rent, plan: monthly(150000) })
    expect(await error(env.budgets.addLine(b.id, { target: rent, plan: monthly(1) }))).toBe('DUPLICATE_LINE target')
    await expect(env.budgets.addLine(b.id, { target: rent, plan: monthly(1) })).rejects.toMatchObject({ message: '“Rent” already has a line in this budget.' })
    await env.budgets.addLine(other.id, { target: rent, plan: monthly(1) })            // another budget may
    await env.budgets.addLine(b.id, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'in' }, plan: monthly(300000) })
    // One line per account, whichever way
    await expect(env.budgets.addLine(b.id, { target: { kind: 'transfer', accountId: h.bchq.id, direction: 'out' }, plan: monthly(1) }))
      .rejects.toMatchObject({ code: 'DUPLICATE_LINE', message: 'Transfers with “Business Chequing” already have a line in this budget.' })
    expect((await env.budgets.lines(b.id)).map(l => l.target.kind)).toEqual(['category', 'transfer'])
  })

  it('refuse a category or account that doesn\'t exist, a transfer inside the scope or in another currency, and a bad plan', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput({ subLedgerId: h.business.id }))
    const add = (target: unknown, plan = monthly(100)) => error(env.budgets.addLine(b.id, { target: target as never, plan }))
    expect(await add({ kind: 'category', categoryId: 'nope' })).toBe('NOT_FOUND target')
    expect(await add({ kind: 'transfer', accountId: 'nope', direction: 'in' })).toBe('NOT_FOUND target')
    expect(await add({ kind: 'transfer', accountId: h.bchq.id, direction: 'in' })).toBe('INVALID target')       // inside Business
    expect(await add({ kind: 'transfer', accountId: h.usVisa.id, direction: 'in' })).toBe('INVALID target')     // USD
    expect(await add({ kind: 'transfer', accountId: h.pchq.id, direction: 'sideways' })).toBe('INVALID target')
    expect(await add({ kind: 'tag' })).toBe('INVALID target')
    const rent = { kind: 'category', categoryId: h.category('Rent') }
    expect(await add(rent, { ...monthly(100), amount: -1 })).toBe('INVALID amount')
    expect(await add(rent, { ...monthly(100), amount: BUDGET_AMOUNT_MAX + 1 })).toBe('INVALID amount')
    expect(await add(rent, { ...monthly(100), frequency: 'weekly' })).toBe('INVALID due')
    expect(await add(rent, { ...monthly(100), from: '2027' })).toBe('INVALID from')
    expect(await error(env.budgets.addLine('nope', { target: rent as never, plan: monthly(1) }))).toBe('NOT_FOUND budgetId')
    // Only what a plan is, is kept
    const line = await env.budgets.addLine(b.id, { target: rent as never, plan: { ...monthly(100), extra: 'x' } as never })
    expect(line.plans).toEqual([monthly(100)])
  })

  it(`are at most ${BUDGET_LINES_MAX} to a budget`, async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput())
    await env.session.database('budget').collection<StoredLine>(BUDGET_COLLECTIONS.lines).insertMany(Array.from({ length: BUDGET_LINES_MAX }, (_, i) =>
      ({ budgetId: b.id, target: { kind: 'category' as const, categoryId: `made-up-${i}` }, plans: [monthly(1)] })))
    expect(await error(env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(1) }))).toBe('INVALID target')
  })
})

describe('plans', () => {
  async function line() {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput())
    const l = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(65000, '2027-01') })
    return { env, l, b }
  }
  const froms = (l: BudgetLine) => l.plans.map(p => `${p.from} ${p.amount}`)

  it('change from a month on, kept in order, replacing one from the same month; the later ones stay unless asked', async () => {
    const { env, l } = await line()
    let now = await env.budgets.changeLine(l.id, { apply: 'from', plan: monthly(70000, '2027-07') })
    now = await env.budgets.changeLine(l.id, { apply: 'from', plan: monthly(60000, '2026-07') })
    now = await env.budgets.changeLine(l.id, { apply: 'from', plan: monthly(80000, '2027-09') })
    expect(froms(now)).toEqual(['2026-07 60000', '2027-01 65000', '2027-07 70000', '2027-09 80000'])
    now = await env.budgets.changeLine(l.id, { apply: 'from', plan: monthly(75000, '2027-07') })
    expect(froms(now)).toEqual(['2026-07 60000', '2027-01 65000', '2027-07 75000', '2027-09 80000'])
    now = await env.budgets.changeLine(l.id, { apply: 'from', plan: monthly(90000, '2027-03'), replaceLater: true })
    expect(froms(now)).toEqual(['2026-07 60000', '2027-01 65000', '2027-03 90000'])
  })

  it('set one month\'s own amount, and take it away again; refuse a stale revision', async () => {
    const { env, l } = await line()
    const set = await env.budgets.changeLine(l.id, { apply: 'only', month: '2027-12', amount: 90000 }, { expectedRev: l.rev })
    expect(set.overrides).toEqual({ '2027-12': 90000 })
    expect(await error(env.budgets.changeLine(l.id, { apply: 'only', month: '2027-11', amount: 1 }, { expectedRev: l.rev }))).toBe('CONFLICT')
    expect(await env.budgets.changeLine(l.id, { apply: 'only', month: '2027-12', amount: null })).not.toHaveProperty('overrides')
    expect(await error(env.budgets.changeLine(l.id, { apply: 'only', month: '2027-13', amount: 1 }))).toBe('INVALID month')
    expect(await error(env.budgets.changeLine(l.id, { apply: 'only', month: '2027-12', amount: -5 }))).toBe('INVALID amount')
    expect(await error(env.budgets.changeLine(l.id, { apply: 'sometimes' } as never))).toBe('INVALID apply')
    expect(await error(env.budgets.changeLine('nope', { apply: 'only', month: '2027-12', amount: 1 }))).toBe('NOT_FOUND lineId')
  })

  it('change the plan and the notes together, or neither: nothing is written when either is refused', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput())
    const line = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: monthly(100) })
    env.budgetChanges.length = 0
    await expect(env.budgets.editLine(line.id, { change: { apply: 'from', plan: monthly(200, '2027-04') }, notes: 'bad\u0001note' }, { expectedRev: line.rev }))
      .rejects.toMatchObject({ code: 'INVALID', field: 'notes' })
    expect((await env.budgets.lines(b.id))[0]).toEqual(line)            // the plan not changed, the revision the same
    expect(env.budgetChanges).toEqual([])
    const both = await env.budgets.editLine(line.id, { change: { apply: 'from', plan: monthly(200, '2027-04') }, notes: 'Rent goes up' }, { expectedRev: line.rev })
    expect(both).toMatchObject({ rev: line.rev + 1, notes: 'Rent goes up', plans: [{ from: '2027-01', amount: 100 }, { from: '2027-04', amount: 200 }] })
    expect(env.budgetChanges).toEqual([{ budgets: [], deleted: [], lines: [b.id], actuals: false }])     // one write, one event
  })

  it('keep notes, and are deleted with their line', async () => {
    const { env, l, b } = await line()
    expect(await env.budgets.setLineNotes(l.id, ' Costco and the market ')).toMatchObject({ notes: 'Costco and the market' })
    expect(await env.budgets.setLineNotes(l.id, null)).not.toHaveProperty('notes')
    await env.budgets.deleteLine(l.id)
    expect(await env.budgets.lines(b.id)).toEqual([])
    expect(await error(env.budgets.deleteLine(l.id))).toBe('NOT_FOUND lineId')
  })
})

describe('no ledger, a read-only ledger, and what it announces', () => {
  it('fails with NO_LEDGER while no ledger is open', async () => {
    const env = await setupBudget({ open: false })
    expect(await error(env.budgets.list())).toBe('NO_LEDGER')
    expect(await error(env.budgets.create(budgetInput()))).toBe('NO_LEDGER')
  })

  it('reads budgets from an archive file, opened read-only, and refuses every change', async () => {
    const env = await setupBudget()
    const b = await env.budgets.create(budgetInput())
    const archive = path.join(DIR, 'Tessera Backups', LEDGER_ARCHIVES_FOLDER, 'Home (archive before 2026-01-01).tesserabkp')
    const home = env.session.current!.path
    await (await env.engine.open({ path: home })).snapshot({ path: archive }, { meta: {
      [LEDGER_BACKUP_META.takenAt]: '2026-11-10T17:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: home, [LEDGER_BACKUP_META.takenWith]: 'test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
    } })
    await env.session.open(archive)
    expect(env.session.current?.readOnly).toBe(true)
    expect((await env.budgets.list()).map(x => x.name)).toEqual(['Household'])
    expect(await env.budgets.status(b.id, { from: '2025-01', to: '2025-12' })).toMatchObject({ rows: [] })
    expect(await error(env.budgets.create(budgetInput({ name: 'New' })))).toBe('READ_ONLY')
    expect(await error(env.budgets.update(b.id, { name: 'New' }))).toBe('READ_ONLY')
    expect(await error(env.budgets.delete(b.id))).toBe('READ_ONLY')
  })

  it('announces its own writes, and that actuals changed when transactions, categories, accounts or the tree do', async () => {
    const env = await setupBudget()
    const h = await household(env)
    env.budgetChanges.length = 0
    const b = await env.budgets.create(budgetInput())
    const l = await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: categoryNamed(await env.accounts.categories.list(), 'Rent') }, plan: monthly(1) })
    await env.budgets.deleteLine(l.id)
    await env.budgets.delete(b.id)
    expect(env.budgetChanges).toEqual([
      { budgets: [b.id], deleted: [], lines: [], actuals: false },
      { budgets: [], deleted: [], lines: [b.id], actuals: false },
      { budgets: [], deleted: [], lines: [b.id], actuals: false },
      { budgets: [b.id], deleted: [b.id], lines: [b.id], actuals: false }
    ])
    env.budgetChanges.length = 0
    await h.t(h.pchq.id).create({ date: '2027-03-01', amount: -100 })
    await env.accounts.categories.create('Pets', 'expense')
    await env.session.createSubLedger({ name: 'Pets', parentId: null })
    expect(env.budgetChanges.map(c => c.actuals)).toEqual([true, true, true])
  })
})
