// shared/menus/types.ts

/** Extension point that menu contributions are registered under. */
export const MENUS_EXTENSION_POINT = 'shell.menus'

/** Top-level menus owned by the shell. Their positions on the menu bar are fixed. */
export const FILE_MENU = 'shell.file'
export const TOOLS_MENU = 'shell.tools'
export const HELP_MENU = 'shell.help'

export const RESERVED_TOP_LEVEL_MENUS: readonly string[] = [FILE_MENU, TOOLS_MENU, HELP_MENU]

export function isReservedTopLevelMenu(id: string) {
  return RESERVED_TOP_LEVEL_MENUS.includes(id)
}

/** Group used when a menu or item does not name one. */
export const DEFAULT_GROUP = 'additions'

interface BaseDefinition {
  id: string
  /** Lower sorts first. Ties keep registration order. Defaults to 0. */
  order?: number
}

/**
 * A menu. Without a parent it is placed on the menu bar, between File and Tools;
 * with a parent it is a submenu.
 */
export interface MenuDefinition extends BaseDefinition {
  kind: 'menu'
  label: string
  parent?: string
  /** Group within the parent menu. Ignored on the menu bar. */
  group?: string
}

export interface MenuItemDefinition extends BaseDefinition {
  kind: 'item'
  label: string
  parent: string
  group?: string
  /** Command id executed when the item is clicked. */
  command: string
  accelerator?: string
}

/**
 * A group of entries within a menu. Groups are separated from each other by
 * separators. Group ids are scoped to their parent menu. Items may reference a
 * group that is not declared; it is created implicitly with order 0.
 */
export interface MenuGroupDefinition extends BaseDefinition {
  kind: 'group'
  parent: string
}

export type MenuContribution = MenuDefinition | MenuItemDefinition | MenuGroupDefinition

// -----------------------------
// Resolved, renderer-agnostic model
// -----------------------------

export interface SubmenuNode {
  type: 'submenu'
  id: string
  label: string
  children: MenuNode[]
}

export interface MenuItemNode {
  type: 'item'
  id: string
  label: string
  command: string
  accelerator?: string
}

export interface SeparatorNode {
  type: 'separator'
}

export type MenuNode = SubmenuNode | MenuItemNode | SeparatorNode

export interface MenuModel {
  /** Menu bar entries, in display order. */
  menus: SubmenuNode[]
  /** Problems found in contributions. Offending contributions are skipped. */
  diagnostics: string[]
}
