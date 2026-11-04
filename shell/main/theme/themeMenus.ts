// shell/main/theme/themeMenus.ts
import type { ThemeDescriptor } from '@tessera/types'
import { MenuContribution, MenuItemDefinition, VIEW_MENU } from '../../../shared/menus/types'
import { THEME_COMMANDS, themeUseCommand, themeWindowUseCommand } from '../../../shared/theme/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

export const THEME_MENU = 'shell.view.theme'
export const WINDOW_THEME_MENU = 'shell.view.theme.window'
const THEME_GROUP = 'shell.theme'
const CHOOSE_GROUP = 'shell.theme.choose'
const GLOBAL_GROUP = 'shell.theme.global'
/** Where the registered themes are listed, one item each, added as themes come and go. */
const PICKER_GROUP = 'shell.theme.themes'
const WINDOW_PICKER_GROUP = 'shell.theme.window.themes'
const WINDOW_GROUP = 'shell.theme.window'

/**
 * View ▸ Theme: the chooser dialog, the application-wide mode, then the themes to choose from, then
 * a submenu for this window's own theme. Labels are static until menus support
 * checked items, so the current choice is not ticked. The theme items are added
 * by `themePickerItems` as themes are registered.
 */
export const themeMenus: MenuContribution[] = [
  { kind: 'group', id: THEME_GROUP, parent: VIEW_MENU, order: SHELL_GROUP_ORDER + 2 },
  { kind: 'menu', id: THEME_MENU, label: '&Theme', parent: VIEW_MENU, group: THEME_GROUP },

  { kind: 'group', id: CHOOSE_GROUP, parent: THEME_MENU, order: -1 },
  { kind: 'group', id: GLOBAL_GROUP, parent: THEME_MENU, order: 0 },
  { kind: 'group', id: PICKER_GROUP, parent: THEME_MENU, order: 1 },
  { kind: 'group', id: WINDOW_GROUP, parent: THEME_MENU, order: 2 },

  { kind: 'item', id: 'shell.view.theme.choose', label: '&Choose Theme…', parent: THEME_MENU, group: CHOOSE_GROUP, command: THEME_COMMANDS.choose },
  { kind: 'item', id: 'shell.view.theme.system', label: 'Follow &System', parent: THEME_MENU, group: GLOBAL_GROUP, command: THEME_COMMANDS.useSystem },
  { kind: 'item', id: 'shell.view.theme.light', label: '&Light', parent: THEME_MENU, group: GLOBAL_GROUP, command: THEME_COMMANDS.useLight },
  { kind: 'item', id: 'shell.view.theme.dark', label: '&Dark', parent: THEME_MENU, group: GLOBAL_GROUP, command: THEME_COMMANDS.useDark },
  { kind: 'item', id: 'shell.view.theme.toggle', label: '&Toggle Light/Dark', parent: THEME_MENU, group: GLOBAL_GROUP, command: THEME_COMMANDS.toggle },

  { kind: 'menu', id: WINDOW_THEME_MENU, label: 'This &Window', parent: THEME_MENU, group: WINDOW_GROUP },
  { kind: 'group', id: WINDOW_PICKER_GROUP, parent: WINDOW_THEME_MENU, order: 0 },
  { kind: 'group', id: `${WINDOW_PICKER_GROUP}.clear`, parent: WINDOW_THEME_MENU, order: 1 },
  { kind: 'item', id: 'shell.view.theme.clearWindow', label: 'Use the &Application Theme', parent: WINDOW_THEME_MENU, group: `${WINDOW_PICKER_GROUP}.clear`, command: THEME_COMMANDS.clearWindowOverride }
]

/** A theme's name as a menu label: a plugin's `&` is a literal ampersand, not a mnemonic. */
const labelOf = (theme: ThemeDescriptor) => theme.label.replace(/&/g, '&&')

/** The two menu items for a registered theme: choose it for the application, and give it to this window. */
export function themePickerItems(theme: ThemeDescriptor): MenuItemDefinition[] {
  return [
    { kind: 'item', id: `shell.view.theme.use.${theme.id}`, label: labelOf(theme), parent: THEME_MENU, group: PICKER_GROUP, command: themeUseCommand(theme.id) },
    { kind: 'item', id: `shell.view.theme.window.use.${theme.id}`, label: labelOf(theme), parent: WINDOW_THEME_MENU, group: WINDOW_PICKER_GROUP, command: themeWindowUseCommand(theme.id) }
  ]
}
