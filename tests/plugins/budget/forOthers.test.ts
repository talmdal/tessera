// @vitest-environment node
// budget.service as another plugin uses it (docs/plugin-creation.md, "Using budgets from another plugin"): a reports
// plugin requiring it reads a month's status, works out when a line is due with @tessera/budget-api's own arithmetic,
// follows onDidChange, reads the Budget page's settings, and shows a budget with budget.show.
import { describe, expect, it } from 'vitest'
import {
  BUDGET_COMMANDS, BUDGET_CONTEXT_KEYS, BUDGET_SERVICE, BUDGET_SETTINGS_ID, dueDates, planFor, plannedAmount,
  type BudgetChange, type BudgetService, type BudgetSettings
} from '@tessera/budget-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { household, setup } from './app'

async function reports() {
  const env = await setup()
  // A plugin that declares what it requires, as its manifest would
  const context = createPluginContext('reports', env.runtime, { requires: ['budget.service'] }).context
  const budgets = context.services.get<BudgetService>(BUDGET_SERVICE)
  return { env, context, budgets }
}

describe('budget.service, for other plugins', () => {
  it('gives a month\'s status, and the days each line falls due, from the same arithmetic as the view', async () => {
    const { env, budgets } = await reports()
    await env.open()
    const h = await household(env)
    const b = await budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    const pay = await budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Salary') }, plan: { from: '2027-01', amount: 210000, frequency: 'everyTwoWeeks', due: '2027-01-08' } })
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-04-02', amount: 210000, categoryId: h.category('Salary') })
    const april = await budgets.status(b.id, { from: '2027-04', to: '2027-04' })
    const row = april.rows.find(r => r.lineId === pay.id)!
    expect(row.figures).toEqual({ budget: 630000, actual: 210000, remaining: 420000 })
    expect(row.due).toEqual([2, 16, 30])
    const [line] = await budgets.lines(b.id)
    expect(plannedAmount(line, '2027-04')).toBe(630000)
    expect(dueDates(planFor(line.plans, '2027-04')!, '2027-04')).toEqual(['2027-04-02', '2027-04-16', '2027-04-30'])
  })

  it('says what changed: its own writes at once, and that actuals changed when the ledger did', async () => {
    const { env, budgets } = await reports()
    await env.open()
    const h = await household(env)
    const heard: BudgetChange[] = []
    const subscription = budgets.onDidChange(c => heard.push(c))
    const b = await budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Rent') }, plan: { from: '2027-01', amount: 1, frequency: 'monthly', due: '2027-01' } })
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-03-01', amount: -100 })
    expect(heard).toEqual([
      { budgets: [b.id], deleted: [], lines: [], actuals: false },
      { budgets: [], deleted: [], lines: [b.id], actuals: false },
      { budgets: [], deleted: [], lines: [], actuals: true }
    ])
    subscription.dispose()
    await env.session.close()
    expect(heard).toHaveLength(3)
  })

  it('warns as the Budget page says, which other plugins can read but not change', async () => {
    const { env, context, budgets } = await reports()
    const settings = context.settings.read<BudgetSettings>(BUDGET_SETTINGS_ID)
    expect(settings.get()).toMatchObject({ warnAtPercent: 90, statusBar: true })
    await env.open()
    const h = await household(env)
    const b = await budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Fuel') }, plan: { from: '2027-01', amount: 10000, frequency: 'monthly', due: '2027-01' } })
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-03-01', amount: -8000, categoryId: h.category('Fuel') })
    const fuel = async () => (await budgets.status(b.id, { from: '2027-03', to: '2027-03' })).rows.find(r => r.label === 'Fuel')?.warning
    expect(await fuel()).toBeUndefined()
    await env.runtime.settings.commit([{ id: BUDGET_SETTINGS_ID, value: { ...settings.get(), warnAtPercent: 75 } }])
    expect(settings.get()?.warnAtPercent).toBe(75)
    expect(await fuel()).toBe('near')
    expect((settings as unknown as { update?: unknown }).update).toBeUndefined()        // a reader has no way to change them
  })

  it('shows a budget with budget.show, whatever the view showed', async () => {
    const { env, budgets } = await reports()
    await env.open()
    const a = await budgets.create({ name: 'A', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    const b = await budgets.create({ name: 'B', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    expect(env.key(BUDGET_CONTEXT_KEYS.shown)).toBe(a.id)
    expect(await env.run(BUDGET_COMMANDS.show, { id: b.id })).toBe(true)
    expect(env.key(BUDGET_CONTEXT_KEYS.shown)).toBe(b.id)
    expect(env.reveals).toContain('budget.view')
    expect(await env.run(BUDGET_COMMANDS.show, { id: 'gone' })).toBe(false)
  })
})
