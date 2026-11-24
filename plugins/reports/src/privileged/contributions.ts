// What the reports plugin adds to the shell, as plain data: the Reports menu, the report view and the Reports tab, and
// the Transactions dialog. The reports offered are mirrored into the menu as they are contributed (menu.ts).
import { DIALOGS_EXTENSION_POINT, type DialogContribution } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import { REPORTS_COMMANDS as C, REPORTS_DIALOGS, REPORTS_ICON, REPORTS_MENU, REPORTS_VIEWS } from '@tessera/reports-api'

/** The Reports menu's groups: Show Reports; the reports, a submenu per group; the report shown; saving it; printing it. */
export const MENU_GROUPS = {
  show: 'reports.menu.show',
  reports: 'reports.menu.reports',
  report: 'reports.menu.report',
  save: 'reports.menu.save',
  output: 'reports.menu.output'
} as const

const item = (id: string, label: string, command: string, group: string, extra: { accelerator?: string } = {}) =>
  ({ kind: 'item', id, label, parent: REPORTS_MENU, group, command, ...extra })

/** Reports, after Budget (order 10): among the plugin menus, which go by `order`. */
export const MENUS = [
  { kind: 'menu', id: REPORTS_MENU, label: '&Reports', order: 20 },
  { kind: 'group', id: MENU_GROUPS.show, parent: REPORTS_MENU, order: 0 },
  { kind: 'group', id: MENU_GROUPS.reports, parent: REPORTS_MENU, order: 10 },
  { kind: 'group', id: MENU_GROUPS.report, parent: REPORTS_MENU, order: 20 },
  { kind: 'group', id: MENU_GROUPS.save, parent: REPORTS_MENU, order: 30 },
  { kind: 'group', id: MENU_GROUPS.output, parent: REPORTS_MENU, order: 40 },
  item('reports.menu.showList', '&Show Reports', C.showList, MENU_GROUPS.show),
  item('reports.menu.customise', '&Customise Report…', C.customise, MENU_GROUPS.report),
  item('reports.menu.refresh', 'R&efresh Report', C.refresh, MENU_GROUPS.report),
  item('reports.menu.save', 'Sa&ve Report', C.save, MENU_GROUPS.save),
  item('reports.menu.saveAs', 'Save Report &As…', C.saveAs, MENU_GROUPS.save),
  item('reports.menu.exportCsv', 'E&xport Report…', C.exportCsv, MENU_GROUPS.output),
  // Enabled only while the report view is in front (output.ts), so Ctrl+P elsewhere doesn't print a report behind it
  item('reports.menu.print', '&Print Report…', C.print, MENU_GROUPS.output, { accelerator: 'CmdOrCtrl+P' }),
  item('reports.menu.savePdf', 'Save Report as P&DF…', C.savePdf, MENU_GROUPS.output)
] as const

export const VIEWS = [
  // After the register (-50) and the budget (-40), so a ledger opens on the register as before; a report reveals this
  {
    id: REPORTS_VIEWS.view, title: 'Report', slot: 'shell.main', module: './ReportView', icon: REPORTS_ICON,
    order: -30, when: LEDGER_CONTEXT_KEYS.isOpen
  },
  // Beside Accounts (-100) and Budgets (-95)
  {
    id: REPORTS_VIEWS.list, title: 'Reports', slot: 'shell.left', module: './ReportList', icon: REPORTS_ICON,
    order: -90, when: LEDGER_CONTEXT_KEYS.isOpen
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: REPORTS_DIALOGS.transactions, title: 'Transactions', module: './TransactionsDialog', size: 'md' },
  { id: REPORTS_DIALOGS.customise, title: 'Customise Report', module: './CustomiseDialog', size: 'sm' },
  { id: REPORTS_DIALOGS.save, title: 'Save Report As', module: './SaveDialog', size: 'xs' }
]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...VIEWS.map(v => ['shell.views', v.id, v] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown])
  ]
}
