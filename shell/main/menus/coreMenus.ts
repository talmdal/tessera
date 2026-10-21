// shell/main/menus/coreMenus.ts
import { app, BrowserWindow, dialog } from 'electron'
import { PluginContext } from '@tessera/types'
import {
  FILE_MENU,
  HELP_MENU,
  MENUS_EXTENSION_POINT,
  MenuContribution,
  TOOLS_MENU
} from '../../../shared/menus/types'

export const CORE_COMMANDS = {
  quit: 'shell.quit',
  toggleDevTools: 'shell.toggleDevTools',
  about: 'shell.about'
} as const

// Shell-owned groups sort last in their menus so plugin groups land above them.
const SHELL_GROUP_ORDER = 10_000

const coreMenus: MenuContribution[] = [
  { kind: 'menu', id: FILE_MENU, label: '&File' },
  { kind: 'group', id: 'shell.exit', parent: FILE_MENU, order: SHELL_GROUP_ORDER },
  { kind: 'item', id: 'shell.file.exit', label: 'E&xit', parent: FILE_MENU, group: 'shell.exit', command: CORE_COMMANDS.quit },

  { kind: 'menu', id: TOOLS_MENU, label: '&Tools' },
  { kind: 'group', id: 'shell.developer', parent: TOOLS_MENU, order: SHELL_GROUP_ORDER },
  {
    kind: 'item',
    id: 'shell.tools.devTools',
    label: 'Toggle &Developer Tools',
    parent: TOOLS_MENU,
    group: 'shell.developer',
    command: CORE_COMMANDS.toggleDevTools,
    accelerator: 'CmdOrCtrl+Shift+I'
  },

  { kind: 'menu', id: HELP_MENU, label: '&Help' },
  { kind: 'group', id: 'shell.about', parent: HELP_MENU, order: SHELL_GROUP_ORDER },
  { kind: 'item', id: 'shell.help.about', label: '&About Tessera', parent: HELP_MENU, group: 'shell.about', command: CORE_COMMANDS.about }
]

/**
 * Contributes the shell's File, Tools and Help menus through the shell's own
 * plugin context. Must run before plugins activate.
 */
export function registerCoreMenus(context: PluginContext) {
  context.commands.register(CORE_COMMANDS.quit, () => app.quit())
  context.commands.register(CORE_COMMANDS.toggleDevTools, () =>
    BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools())
  context.commands.register(CORE_COMMANDS.about, () =>
    dialog.showMessageBox({ type: 'info', title: 'About Tessera', message: `Tessera ${app.getVersion()}` }))

  for (const contribution of coreMenus) {
    context.extensions.contribute(context.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }
}
