// @vitest-environment node
// The Budget page (Tools › Options… › Budget): its fields and their ranges, the defaults, and every setting followed as
// it changes: Warn at by the view and by budget.service for other plugins, the view's bars and empty lines, Fill from
// History's months and step. The ledger, accounts and budget plugins activated together, as the app runs them.
import { describe, expect, it } from 'vitest'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_DIALOGS, BUDGET_EVENTS, BUDGET_SETTINGS_DEFAULTS, BUDGET_SETTINGS_ID, BUDGET_SETTINGS_PAGE,
  type BudgetSettings, type BudgetsView, type HistoryDialogInput
} from '@tessera/budget-api'
import { BUDGET_SETTINGS } from '../../../plugins/budget/src/privileged/settings'
import { household, setup, type Env } from './app'
import { monthly } from './harness'

const change = (env: Env, patch: Partial<BudgetSettings>) =>
  env.runtime.settings.commit([{ id: BUDGET_SETTINGS_ID, value: { ...env.runtime.settings.snapshot(BUDGET_SETTINGS_ID)!.value, ...patch } }])

describe('the Budget page', () => {
  it('is a page the shell draws, with every setting the design lists, at its default', async () => {
    const env = await setup()
    const page = env.runtime.settings.pages().find(p => p.id === BUDGET_SETTINGS_PAGE)!
    expect(page).toMatchObject({ title: 'Budget', settings: BUDGET_SETTINGS_ID })
    expect(page.fields!.map(f => [f.key, f.kind])).toEqual([
      ['warnAtPercent', 'number'], ['showBars', 'boolean'], ['showEmptyLines', 'boolean'], ['statusBar', 'boolean'],
      ['historyMonths', 'number'], ['roundTo', 'choice']
    ])
    expect(page.fields![0]).toMatchObject({ label: 'Warn at', min: 50, max: 100, integer: true })
    expect(page.fields![5].kind === 'choice' && page.fields![5].options.map(o => o.value)).toEqual([1, 5, 10, 50, 100])
    expect(env.runtime.settings.snapshot(BUDGET_SETTINGS_ID)?.value).toEqual(BUDGET_SETTINGS_DEFAULTS)
    expect(env.log.warn.mock.calls.filter(c => String(c[0]).includes('[settings]'))).toEqual([])
  })

  it('takes only values within their ranges', async () => {
    const env = await setup()
    const refused = async (patch: Partial<BudgetSettings>) => {
      const result = await change(env, patch)
      return result.ok ? [] : result.errors[BUDGET_SETTINGS_ID]
    }
    expect(await refused({ warnAtPercent: 49 })).toContain('Warn at a share from 50 to 100 %.')
    expect(await refused({ warnAtPercent: 100.5 })).toContain('Warn at a share from 50 to 100 %.')
    expect(await refused({ historyMonths: 2 })).toContain('Look at 3 to 24 months of history.')
    expect(await refused({ historyMonths: 25 })).toContain('Look at 3 to 24 months of history.')
    expect(await refused({ roundTo: 7 })).toContain('Round to one of 1, 5, 10, 50, 100.')
    expect(await refused({ statusBar: 'yes' as never })).toHaveLength(1)       // the shell says so first, for a checkbox
    expect(BUDGET_SETTINGS.validate!({ ...BUDGET_SETTINGS_DEFAULTS, statusBar: 'yes' as never })).toEqual(['Say whether to show lines over budget in the status bar with a tick.'])
    expect(await refused({ warnAtPercent: 50, historyMonths: 24, roundTo: 100 })).toEqual([])
  })
})

describe('the settings, followed as they change', () => {
  it('warns at the share the page says, in the view and for other plugins, and tells the views at once', async () => {
    const env = await setup()
    await env.open()
    const h = await household(env)
    const b = await env.budgets.create({ name: 'Household', subLedgerId: h.personal.id, currency: 'CAD', yearStartMonth: 1 })
    await env.budgets.addLine(b.id, { target: { kind: 'category', categoryId: h.category('Groceries') }, plan: monthly(10000) })
    await env.accounts.transactions(h.pchq.id).create({ date: '2027-03-05', amount: -8500, categoryId: h.category('Groceries') })    // 85 %
    await env.idle()
    const march = { from: '2027-03', to: '2027-03' }
    const warning = async () => (await env.ask(BUDGET_CHANNELS.status, { budgetId: b.id, months: march })).value.rows.find((r: { label: string }) => r.label === 'Groceries').warning
    expect(await warning()).toBeUndefined()
    env.events.length = 0
    expect(await change(env, { warnAtPercent: 80 })).toMatchObject({ ok: true })
    await env.idle()
    expect(env.named(BUDGET_EVENTS.status).map(e => e.data)).toEqual([{ budgetId: null }])
    expect(await warning()).toBe('near')
    // budget.service warns as the view does, unless the caller asks for another share
    expect((await env.budgets.status(b.id, march)).rows.find(r => r.label === 'Groceries')?.warning).toBe('near')
    expect((await env.budgets.status(b.id, march, { warnAtPercent: 90 })).rows.find(r => r.label === 'Groceries')?.warning).toBeUndefined()
  })

  it('sends the view its bars and empty lines, which its More menu changes as the page would', async () => {
    const env = await setup()
    await env.open()
    await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    expect((await env.ask(BUDGET_CHANNELS.budgets) as BudgetsView).options).toEqual({ showBars: true, showEmptyLines: false })
    await change(env, { showBars: false })
    await env.idle()
    expect((env.named(BUDGET_EVENTS.budgets).at(-1)!.data as BudgetsView).options).toEqual({ showBars: false, showEmptyLines: false })
    await env.ask(BUDGET_CHANNELS.viewOptions, { showEmptyLines: true })
    await env.idle()
    expect(env.runtime.settings.snapshot(BUDGET_SETTINGS_ID)?.value).toMatchObject({ showBars: false, showEmptyLines: true })
    expect((env.named(BUDGET_EVENTS.budgets).at(-1)!.data as BudgetsView).options).toEqual({ showBars: false, showEmptyLines: true })
    await expect(env.ask(BUDGET_CHANNELS.viewOptions, { showBars: 'no' })).rejects.toThrow('showBars is true or false')
  })

  it('opens Fill from History on the months and the step the page says', async () => {
    const env = await setup()
    await env.open()
    await env.budgets.create({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 })
    await env.idle()
    await change(env, { historyMonths: 6, roundTo: 50 })
    env.prompts.show.mockResolvedValueOnce(undefined)
    await env.run(C.fillFromHistory)
    const [id, input] = env.prompts.show.mock.calls.at(-1)!
    expect(id).toBe(BUDGET_DIALOGS.history)
    expect(input as HistoryDialogInput).toMatchObject({ months: 6, roundTo: 50 })
  })
})
