// shell/main/menus/electronMenu.ts
import { Menu, MenuItemConstructorOptions } from 'electron'
import { CommandRegistry } from '../../../core/commands/CommandRegistry'
import { ExtensionRegistry } from '../../../core/extensions/ExtensionRegistry'
import { Disposable } from '../../../core/ports'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import {
  MENUS_EXTENSION_POINT,
  MenuNode,
  SubmenuNode,
  isReservedTopLevelMenu
} from '../../../shared/menus/types'

/** Renders resolved menu bar entries as an Electron menu template. */
export function toElectronTemplate(
  menus: readonly SubmenuNode[],
  commands: CommandRegistry
): MenuItemConstructorOptions[] {
  return menus
    .map(menu => ({ ...menu, children: normalizeMenuNodes(menu.children) }))
    .filter(menu => menu.children.length > 0 || isReservedTopLevelMenu(menu.id))
    .map(menu => toElectronItem(menu, commands))
}

function toElectronItem(node: MenuNode, commands: CommandRegistry): MenuItemConstructorOptions {
  switch (node.type) {
    case 'separator':
      return { type: 'separator' }
    case 'submenu':
      return { id: node.id, label: node.label, submenu: node.children.map(child => toElectronItem(child, commands)) }
    case 'item':
      return {
        id: node.id,
        label: node.label,
        accelerator: node.accelerator,
        enabled: commands.isEnabled(node.command),
        click: () => {
          // State can change while the menu is open; a now-disabled command is skipped, not an error.
          if (!commands.isEnabled(node.command)) return
          commands.execute(node.command).catch(err =>
            console.error(`[menus] Command "${node.command}" failed`, err))
        }
      }
  }
}

/**
 * Builds the application menu from `shell.menus` contributions and installs
 * it. Items then follow their command's enablement: whenever commands or
 * context keys change, each item's `enabled` flag is updated in place.
 * Dispose to stop tracking.
 */
export function applyApplicationMenu(extensions: ExtensionRegistry, commands: CommandRegistry): Disposable {
  const contributions = extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)
  const { menus, diagnostics } = resolveMenus(contributions)

  for (const message of diagnostics) console.warn(`[menus] ${message}`)

  const menu = Menu.buildFromTemplate(toElectronTemplate(menus, commands))
  Menu.setApplicationMenu(menu)

  const items = menus.flatMap(collectItems)
  return commands.onDidChange(() => {
    for (const { id, command } of items) {
      const item = menu.getMenuItemById(id)
      const enabled = commands.isEnabled(command)
      if (item && item.enabled !== enabled) item.enabled = enabled
    }
  })
}

function collectItems(node: MenuNode): { id: string, command: string }[] {
  if (node.type === 'item') return [{ id: node.id, command: node.command }]
  if (node.type === 'submenu') return node.children.flatMap(collectItems)
  return []
}
