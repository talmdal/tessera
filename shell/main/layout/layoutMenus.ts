// shell/main/layout/layoutMenus.ts
import { LAYOUT_COMMANDS } from '../../../shared/layout/types'
import { MenuContribution, VIEW_MENU } from '../../../shared/menus/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

const BARS_GROUP = 'shell.layout.bars'
const ALL_GROUP = 'shell.layout.all'

/**
 * The View menu: toggles for each bar, then expand, collapse and reset. The
 * shell's groups sort last, so entries plugins add (the pages they open) land above them.
 * Labels are static for now; they become checked items once menus support that.
 */
export const layoutMenus: MenuContribution[] = [
  { kind: 'menu', id: VIEW_MENU, label: '&View' },
  { kind: 'group', id: BARS_GROUP, parent: VIEW_MENU, order: SHELL_GROUP_ORDER },
  { kind: 'group', id: ALL_GROUP, parent: VIEW_MENU, order: SHELL_GROUP_ORDER + 1 },

  { kind: 'item', id: 'shell.view.toggleLeft', label: 'Toggle &Left Bar', parent: VIEW_MENU, group: BARS_GROUP, command: LAYOUT_COMMANDS.toggle.left, accelerator: 'CmdOrCtrl+B' },
  { kind: 'item', id: 'shell.view.toggleRight', label: 'Toggle &Right Bar', parent: VIEW_MENU, group: BARS_GROUP, command: LAYOUT_COMMANDS.toggle.right, accelerator: 'CmdOrCtrl+Alt+B' },
  { kind: 'item', id: 'shell.view.toggleTop', label: 'Toggle &Top Bar', parent: VIEW_MENU, group: BARS_GROUP, command: LAYOUT_COMMANDS.toggle.top },
  { kind: 'item', id: 'shell.view.toggleBottom', label: 'Toggle &Bottom Bar', parent: VIEW_MENU, group: BARS_GROUP, command: LAYOUT_COMMANDS.toggle.bottom, accelerator: 'CmdOrCtrl+J' },

  { kind: 'item', id: 'shell.view.expandAll', label: '&Expand All Bars', parent: VIEW_MENU, group: ALL_GROUP, command: LAYOUT_COMMANDS.expandAll },
  { kind: 'item', id: 'shell.view.collapseAll', label: '&Collapse All Bars', parent: VIEW_MENU, group: ALL_GROUP, command: LAYOUT_COMMANDS.collapseAll },
  { kind: 'item', id: 'shell.view.reset', label: 'Reset La&yout', parent: VIEW_MENU, group: ALL_GROUP, command: LAYOUT_COMMANDS.reset }
]
