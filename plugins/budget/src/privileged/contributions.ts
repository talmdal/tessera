// What the budget plugin adds to the shell, as plain data: the Budget menu, the budget view and the Budgets tab, the
// dialogs, the tab's icon, and the status bar's warning. (The Budget page is in settings.ts.)
import { DIALOGS_EXTENSION_POINT, type DialogContribution } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import { BUDGET_COMMANDS as C, BUDGET_CONTEXT_KEYS as K, BUDGET_DIALOGS, BUDGET_ICON, BUDGET_VIEWS } from '@tessera/budget-api'

const MENU = 'budget.menu'
const ICONS_POINT = 'shell.icons'

const item = (id: string, label: string, command: string, group: string) =>
  ({ kind: 'item', id, label, parent: MENU, group, command })

/**
 * Budget, after Accounts (contributed menus go by `order`, then by when they were contributed; Accounts has none). When
 * reports arrive, budgets and reports may share a Planning menu: only these contributions change (docs/todo.md).
 */
export const MENUS = [
  { kind: 'menu', id: MENU, label: '&Budget', order: 10 },
  { kind: 'group', id: 'budget.menu.budget', parent: MENU, order: 0 },
  { kind: 'group', id: 'budget.menu.properties', parent: MENU, order: 10 },
  { kind: 'group', id: 'budget.menu.line', parent: MENU, order: 20 },
  { kind: 'group', id: 'budget.menu.history', parent: MENU, order: 30 },
  item('budget.menu.new', '&New Budget…', C.newBudget, 'budget.menu.budget'),
  item('budget.menu.show', '&Show Budget', C.show, 'budget.menu.budget'),
  item('budget.menu.properties', 'Budget &Properties…', C.properties, 'budget.menu.properties'),
  item('budget.menu.duplicate', 'D&uplicate Budget…', C.duplicate, 'budget.menu.properties'),
  item('budget.menu.delete', '&Delete Budget…', C.deleteBudget, 'budget.menu.properties'),
  item('budget.menu.newLine', 'New &Line…', C.newLine, 'budget.menu.line'),
  item('budget.menu.editLine', '&Edit Line…', C.editLine, 'budget.menu.line'),
  item('budget.menu.deleteLine', 'Delete L&ine', C.deleteLine, 'budget.menu.line'),
  item('budget.menu.fill', '&Fill from History…', C.fillFromHistory, 'budget.menu.history')
] as const

export const VIEWS = [
  // After the register (order -50), so a ledger opens on the register as before; Show Budget reveals this one
  {
    id: BUDGET_VIEWS.view, title: 'Budget', slot: 'shell.main', module: './BudgetView', icon: BUDGET_ICON,
    order: -40, when: LEDGER_CONTEXT_KEYS.isOpen
  },
  // Beside the Accounts navigator (order -100). Not a navigator: it doesn't show the ledger tree
  {
    id: BUDGET_VIEWS.list, title: 'Budgets', slot: 'shell.left', module: './BudgetList', icon: BUDGET_ICON,
    order: -95, when: LEDGER_CONTEXT_KEYS.isOpen
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: BUDGET_DIALOGS.budget, title: 'New Budget', module: './BudgetDialog', size: 'sm' },
  { id: BUDGET_DIALOGS.line, title: 'New Line', module: './LineDialog', size: 'sm' },
  { id: BUDGET_DIALOGS.transactions, title: 'Transactions', module: './TransactionsDialog', size: 'md' },
  { id: BUDGET_DIALOGS.history, title: 'Fill from History', module: './HistoryDialog', size: 'lg' },
  { id: BUDGET_DIALOGS.duplicate, title: 'Duplicate Budget', module: './DuplicateDialog', size: 'xs' }
]

/**
 * A gentle warning: "Budget: 2 lines over" while the budget shown has expense lines over this month (and the Budget page
 * says to show it). Which lines, in the tooltip; clicking shows the budget.
 */
export const BAR_ITEMS = [
  {
    kind: 'text', id: 'budget.status.over', slot: 'shell.bottom', align: 'end', icon: 'Warning',
    text: `{${K.statusText}}`, when: K.statusText, tooltip: `{${K.statusDetail}}`, command: C.show
  }
] as const

/** The pie chart on the Budgets tab: a monochrome SVG, painted in the text colour. */
export const ICONS = [{ id: BUDGET_ICON, file: './icons/pie.svg' }]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...ICONS.map(i => [ICONS_POINT, i.id, i] as [string, string, unknown]),
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...VIEWS.map(v => ['shell.views', v.id, v] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown]),
    ...BAR_ITEMS.map(b => ['shell.bar.items', b.id, b] as [string, string, unknown])
  ]
}
