// shell/main/theme/themeMenus.ts
import type { ThemeDescriptor } from '@tessera/types'
import { MenuContribution, MenuItemDefinition, VIEW_MENU } from '../../../shared/menus/types'
import { THEME_COMMANDS, themeWindowUseCommand } from '../../../shared/theme/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

export const THEME_MENU = 'shell.view.theme'
const THEME_GROUP = 'shell.theme'
/** Where the registered themes are listed, one item each, added as themes come and go. */
const WINDOW_PICKER_GROUP = 'shell.theme.window.themes'

/**
 * View ▸ Theme: this window's own theme — give it one of the registered themes, or return it to the
 * application's. The application-wide theme is an option, chosen on the options dialog's Appearance page
 * (Tools ▸ Options…), so it is deliberately not here: one place to choose it, one moment it takes effect.
 * Labels are static until menus support checked items, so the current choice is not ticked. The theme items are
 * added by `themePickerItems` as themes are registered.
 */
export const themeMenus: MenuContribution[] = [
  { kind: 'group', id: THEME_GROUP, parent: VIEW_MENU, order: SHELL_GROUP_ORDER + 2 },
  { kind: 'menu', id: THEME_MENU, label: 'Theme for This &Window', parent: VIEW_MENU, group: THEME_GROUP },

  { kind: 'group', id: WINDOW_PICKER_GROUP, parent: THEME_MENU, order: 0 },
  { kind: 'group', id: `${WINDOW_PICKER_GROUP}.clear`, parent: THEME_MENU, order: 1 },
  { kind: 'item', id: 'shell.view.theme.clearWindow', label: 'Use the &Application Theme', parent: THEME_MENU, group: `${WINDOW_PICKER_GROUP}.clear`, command: THEME_COMMANDS.clearWindowOverride }
]

/** A theme's name as a menu label: a plugin's `&` is a literal ampersand, not a mnemonic. */
const labelOf = (theme: ThemeDescriptor) => theme.label.replace(/&/g, '&&')

/** The menu item for a registered theme: give it to this window. */
export function themePickerItems(theme: ThemeDescriptor): MenuItemDefinition[] {
  return [
    { kind: 'item', id: `shell.view.theme.window.use.${theme.id}`, label: labelOf(theme), parent: THEME_MENU, group: WINDOW_PICKER_GROUP, command: themeWindowUseCommand(theme.id) }
  ]
}
