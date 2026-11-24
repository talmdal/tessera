// @vitest-environment node
// The reports offered, mirrored into the Reports menu (phase R3): each definition becomes a command and an item under
// its group's submenu, whether its plugin contributed it before the report manager activated or after; its `when`
// disables the command (and greys it in the Reports tab); withdrawn, its command goes. The menu is checked as the shell
// builds it, from every `shell.menus` contribution.
import { describe, expect, it } from 'vitest'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import {
  REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_MENU, REPORTS_VIEWS, showCommandOf,
  type ReportDefinitionContribution, type ReportsCatalog
} from '@tessera/reports-api'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import type { MenuNode, SubmenuNode } from '../../../shared/menus/types'
import { DEFINITIONS } from '../../../plugins/reports/src/privileged/definitions'
import { setupApp, type App } from './app'

/** The Reports menu as the shell draws it (separators normalised): labels, submenus as `[label, children]`, separators as '—'. */
function reportsMenu(app: App): unknown[] {
  const { menus } = resolveMenus(app.runtime.extensions.getContributions('shell.menus').map(c => c.impl))
  const draw = (nodes: MenuNode[]): unknown[] => nodes.map(n => n.type === 'separator' ? '—' : n.type === 'submenu' ? [n.label, draw(n.children)] : n.label)
  const reports = menus.find(m => m.id === REPORTS_MENU) as SubmenuNode
  return draw(normalizeMenuNodes(reports.children))
}

/** A plugin's own report: Spending by Category's spec, under a group of its own. */
const mine = (over: Partial<ReportDefinitionContribution> = {}): ReportDefinitionContribution => ({
  ...structuredClone(DEFINITIONS.find(d => d.id === 'reports.spendingByCategory')!), id: 'budget.mine', label: 'Budget & Actual', group: 'budget.group', ...over
})
const group = { id: 'budget.group', label: 'Budgets', order: 30 }

describe('the Reports menu', () => {
  it('has Show Reports, a submenu per group with its reports in order, what acts on the report shown, saving it, and printing and exporting it', async () => {
    const app = await setupApp()
    expect(reportsMenu(app)).toEqual([
      '&Show Reports',
      '—',
      ['Income and Spending', ['Income vs Expenses', 'Spending by Category', 'Spending by Payee', 'Category Trends', 'Cash Flow']],
      ['Net Worth and Balances', ['Net Worth', 'Account Balances']],
      '—',
      '&Customise Report…', 'R&efresh Report',
      '—',
      'Sa&ve Report', 'Save Report &As…',
      '—',
      'E&xport Report…', '&Print Report…', 'Save Report as P&DF…'
    ])
  })

  it('makes each report a command, enabled while a ledger is open, that shows it', async () => {
    const app = await setupApp()
    for (const d of DEFINITIONS) expect(app.runtime.commands.has(showCommandOf(d.id)), d.id).toBe(true)
    expect(app.enabled(showCommandOf('reports.netWorth'))).toBe(false)
    await app.open()
    expect(app.enabled(showCommandOf('reports.netWorth'))).toBe(true)
    app.reveals.length = 0
    expect(await app.run(showCommandOf('reports.netWorth'))).toBe(true)
    expect(app.reveals).toEqual([REPORTS_VIEWS.view])
    const catalog: ReportsCatalog = await app.ask(REPORTS_CHANNELS.catalog)
    expect(catalog.shown?.ref).toEqual({ definitionId: 'reports.netWorth' })
  })

  it('mirrors a report another plugin contributed before the report manager activated, under its group, with & written as itself', async () => {
    const app = await setupApp({
      before: runtime => {
        runtime.extensions.contribute('budget', REPORT_GROUPS_POINT, group.id, group)
        runtime.extensions.contribute('budget', REPORT_DEFINITIONS_POINT, 'budget.mine', mine())
      }
    })
    expect(reportsMenu(app)).toContainEqual(['Budgets', ['Budget && Actual']])
    expect(app.runtime.commands.has(showCommandOf('budget.mine'))).toBe(true)
    expect(app.log.warn).not.toHaveBeenCalled()
  })

  it('mirrors a report contributed after it activated (another plugin activating later), as it is contributed', async () => {
    const app = await setupApp()
    app.runtime.extensions.contribute('budget', REPORT_GROUPS_POINT, group.id, group)
    app.runtime.extensions.contribute('budget', REPORT_DEFINITIONS_POINT, 'budget.mine', mine())
    expect(app.runtime.commands.has(showCommandOf('budget.mine'))).toBe(true)
    const menu = reportsMenu(app)
    // After the reports plugin's own groups, by the group's order
    expect(menu.slice(2, 5)).toEqual([
      ['Income and Spending', expect.any(Array)], ['Net Worth and Balances', expect.any(Array)], ['Budgets', ['Budget && Actual']]
    ])
  })

  it('disables a report’s command while its `when` is false, and greys it in the Reports tab to match', async () => {
    const app = await setupApp()
    app.runtime.extensions.contribute('budget', REPORT_GROUPS_POINT, group.id, group)
    app.runtime.extensions.contribute('budget', REPORT_DEFINITIONS_POINT, 'budget.mine', mine({ when: 'budget.hasBudgets' }))
    await app.open()
    const entry = async () => ((await app.ask(REPORTS_CHANNELS.catalog)) as ReportsCatalog).definitions.find(d => d.id === 'budget.mine')
    expect(app.enabled(showCommandOf('budget.mine'))).toBe(false)
    expect(await entry()).toMatchObject({ enabled: false })
    createdKey(app, 'budget.hasBudgets', true)
    await app.idle()
    expect(app.enabled(showCommandOf('budget.mine'))).toBe(true)
    expect(await entry()).toMatchObject({ enabled: true })
    expect(app.enabled(LEDGER_CONTEXT_KEYS.isOpen)).toBe(false)       // (a key is not a command)
  })

  it('unregisters a withdrawn report’s command, so its item is disabled until the menu is built again', async () => {
    const app = await setupApp()
    app.runtime.extensions.contribute('budget', REPORT_GROUPS_POINT, group.id, group)
    const contribution = app.runtime.extensions.contribute('budget', REPORT_DEFINITIONS_POINT, 'budget.mine', mine())
    await app.open()
    expect(app.enabled(showCommandOf('budget.mine'))).toBe(true)
    contribution.dispose()
    expect(app.runtime.commands.has(showCommandOf('budget.mine'))).toBe(false)
    expect(app.enabled(showCommandOf('budget.mine'))).toBe(false)
    expect(reportsMenu(app)).not.toContainEqual(['Budgets', expect.anything()])
    expect(await app.run(C.show, { definitionId: 'budget.mine' })).toBe(false)
  })
})

/** Sets a context key as the plugin that owns it would. */
function createdKey(app: App, key: string, value: boolean) {
  app.runtime.contextKeys.set(key, value)
}
