// shell/main/theme/themeMenus.ts
import type { ThemeDescriptor, ThemeMode } from '@tessera/types'
import { MenuContribution, VIEW_MENU } from '../../../shared/menus/types'
import { THEME_COMMANDS } from '../../../shared/themes/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

export const THEME_MENU = 'shell.view.theme'
export const THEME_GROUP = 'shell.theme'
const MODE_GROUP = 'shell.theme.modes'
const THEMES_GROUP = 'shell.theme.themes'

const MODE_LABELS: Record<ThemeMode, string> = { light: '&Light', dark: '&Dark', system: 'Follow &System' }

/**
 * The View › Theme submenu: the modes, then every theme, then the chooser.
 * It sits under the layout groups, so entries plugins add to View land above it.
 */
export const themeMenus: MenuContribution[] = [
  { kind: 'group', id: THEME_GROUP, parent: VIEW_MENU, order: SHELL_GROUP_ORDER + 2 },
  { kind: 'menu', id: THEME_MENU, label: '&Theme', parent: VIEW_MENU, group: THEME_GROUP },
  { kind: 'item', id: 'shell.view.theme.toggleMode', label: 'Toggle &Dark Mode', parent: VIEW_MENU, group: THEME_GROUP, command: THEME_COMMANDS.toggleMode, accelerator: 'CmdOrCtrl+Shift+D' },

  { kind: 'group', id: MODE_GROUP, parent: THEME_MENU, order: 0 },
  ...(['light', 'dark', 'system'] as ThemeMode[]).map((mode, order): MenuContribution => ({
    kind: 'item', id: `shell.view.theme.mode.${mode}`, label: MODE_LABELS[mode], parent: THEME_MENU, group: MODE_GROUP, command: THEME_COMMANDS.mode(mode), order
  })),

  { kind: 'group', id: THEMES_GROUP, parent: THEME_MENU, order: 1 },
  { kind: 'group', id: 'shell.theme.choose', parent: THEME_MENU, order: 2 },
  { kind: 'item', id: 'shell.view.theme.choose', label: '&Choose Theme…', parent: THEME_MENU, group: 'shell.theme.choose', command: THEME_COMMANDS.choose }
]

/** The menu item that applies one theme. Its label is the theme's, and it runs that theme's `use` command. */
export function themeMenuItem(theme: ThemeDescriptor, order: number): MenuContribution {
  return {
    kind: 'item', id: `shell.view.theme.use.${theme.id}`, label: theme.label.replace(/&/g, '&&'),
    parent: THEME_MENU, group: THEMES_GROUP, command: THEME_COMMANDS.use(theme.id), order
  }
}
