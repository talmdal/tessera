// @vitest-environment node
// The status bar's gentle warning: "Budget: 2 lines over" while the budget shown has expense lines over their budget in
// the current month, worded for one line and for several, with which ones in its tooltip; gone once none is over, for
// another month, or when the Budget page turns it off. Its item, as the shell resolves and draws it.
import { describe, expect, it, vi } from 'vitest'
import { formatAmount } from '@tessera/accounts-api'
import { BUDGET_COMMANDS as C, BUDGET_CONTEXT_KEYS as K, BUDGET_SETTINGS_ID } from '@tessera/budget-api'
import { evaluateWhen, parseWhen } from '../../../shared/context/when'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { household, setup } from './app'
import { monthly } from './harness'

/** The text as the shell draws it: each `{key}` replaced with the key's value (ItemStrip). */
const drawn = (text: string, keys: (key: string) => unknown) => text.replace(/{([^{}]+)}/g, (_m, key: string) => String(keys(key.trim()) ?? ''))

async function overspending() {
  const env = await setup()
  await env.open()
  const h = await household(env)
  const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
  const line = (name: string, amount: number) => env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category(name) }, plan: monthly(amount) })
  await line('Groceries', 60000); await line('Fuel', 10000); await line('Rent', 150000); await line('Salary', 400000)
  const spend = (date: string, amount: number, name: string) => env.accounts.transactions(h.pchq.id).create({ date, amount, categoryId: h.category(name) })
  await env.idle()
  return { env, h, b, spend }
}

describe('the status bar\'s warning', () => {
  it('is a text item the shell accepts, shown only while there is something to say, which shows the budget', async () => {
    const env = await setup()
    const contributions = env.runtime.extensions.getContributions('shell.bar.items').filter(c => c.contributor === 'budget')
    const { items, diagnostics } = resolveBarItems(contributions)
    expect(diagnostics).toEqual([])
    expect(items).toEqual([expect.objectContaining({
      kind: 'text', id: 'budget.status.over', slot: 'shell.bottom', icon: 'Warning', text: `{${K.statusText}}`, when: K.statusText,
      tooltip: `{${K.statusDetail}}`, command: C.show
    })])
    const when = parseWhen(items[0].when!)
    expect(evaluateWhen(when, () => undefined)).toBe(false)
    expect(evaluateWhen(when, key => key === K.statusText ? 'Budget: 1 line over' : undefined)).toBe(true)
  })

  it('counts this month\'s expense lines over budget, one or several, and names them, the worst first', async () => {
    const { env, spend } = await overspending()
    expect(env.key(K.statusText)).toBeUndefined()
    await spend('2027-03-05', -60001, 'Groceries')
    await spend('2027-03-06', -9000, 'Fuel')                 // near, not over
    await spend('2027-03-07', 500000, 'Salary')              // more income than planned is no warning
    await spend('2027-02-10', -999999, 'Rent')               // another month
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 1 line over')
    expect(env.key(K.statusDetail)).toBe(`Household, March 2027: Groceries ${formatAmount(1, 'CAD')} over`)
    expect(drawn(`{${K.statusText}}`, k => env.key(k))).toBe('Budget: 1 line over')

    await spend('2027-03-20', -2000, 'Fuel')
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 2 lines over')
    expect(env.key(K.statusDetail)).toBe(`Household, March 2027: Fuel ${formatAmount(1000, 'CAD')} over; Groceries ${formatAmount(1, 'CAD')} over`)
  })

  it('goes once nothing is over, and when the page turns it off', async () => {
    const { env, spend } = await overspending()
    const over = await spend('2027-03-05', -70000, 'Groceries')
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 1 line over')
    const settings = env.runtime.settings
    await settings.commit([{ id: BUDGET_SETTINGS_ID, value: { ...settings.snapshot(BUDGET_SETTINGS_ID)!.value, statusBar: false } }])
    await env.idle()
    expect(env.key(K.statusText)).toBeUndefined()
    expect(env.key(K.statusDetail)).toBeUndefined()
    await settings.commit([{ id: BUDGET_SETTINGS_ID, value: { ...settings.snapshot(BUDGET_SETTINGS_ID)!.value, statusBar: true } }])
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 1 line over')
    await env.accounts.transactions(over.accountId).delete([over.id])
    await env.idle()
    expect(env.key(K.statusText)).toBeUndefined()
  })

  it('follows the budget shown, and the ledger', async () => {
    const { env, h, spend } = await overspending()
    await spend('2027-03-05', -70000, 'Groceries')
    const business = await env.budgets.create({ name: 'Business', subLedgerId: h.business.id, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 1 line over')
    await env.run(C.show, { id: business.id })
    await env.idle()
    expect(env.key(K.statusText)).toBeUndefined()
    await env.session.close()
    await env.idle()
    expect(env.key(K.statusText)).toBeUndefined()
    expect(env.log.error).not.toHaveBeenCalled()
  })

  it('moves on to the new month when the app is left open over the end of one', async () => {
    let today = '2027-03-31'
    const env = await setup({ today: () => today, monthCheckMs: 10 })
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(60000) })
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-03-05', amount: -70000, categoryId: h.category('Groceries') })
    await env.idle()
    expect(env.key(K.statusText)).toBe('Budget: 1 line over')
    // Midnight: April has nothing over, and nothing changed to prompt a refresh
    today = '2027-04-01'
    await vi.waitFor(() => expect(env.key(K.statusText)).toBeUndefined())
  })
})
