// shared/menus/resolveMenus.ts
import {
  DEFAULT_GROUP,
  FILE_MENU,
  HELP_MENU,
  MenuContribution,
  MenuDefinition,
  MenuGroupDefinition,
  MenuItemDefinition,
  MenuModel,
  MenuNode,
  SubmenuNode,
  TOOLS_MENU,
  VIEW_MENU,
  isReservedTopLevelMenu
} from './types'

interface Entry {
  def: MenuDefinition | MenuItemDefinition
  seq: number
}

interface Group {
  order: number
  seq: number
  declared: boolean
  entries: Entry[]
}

const byOrder = (a: { order?: number, seq: number }, b: { order?: number, seq: number }) =>
  (a.order ?? 0) - (b.order ?? 0) || a.seq - b.seq

const byEntryOrder = (a: Entry, b: Entry) =>
  (a.def.order ?? 0) - (b.def.order ?? 0) || a.seq - b.seq

/**
 * Turns flat `shell.menus` contributions into a menu tree.
 *
 * The menu bar is always File, View, then contributed top-level menus (sorted by
 * order), then Tools, then Help. Within a menu, entries are bucketed by group
 * and each group is surrounded by separators; renderers are expected to run
 * `normalizeMenuNodes` to consolidate them.
 */
export function resolveMenus(contributions: readonly unknown[]): MenuModel {
  const diagnostics: string[] = []
  const entries = new Map<string, Entry>()
  const groupDefs: { def: MenuGroupDefinition, seq: number }[] = []

  contributions.forEach((raw, seq) => {
    const problem = validate(raw)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const def = raw as MenuContribution
    if (def.kind === 'group') {
      groupDefs.push({ def, seq })
    } else if (entries.has(def.id)) {
      diagnostics.push(`Duplicate menu id "${def.id}" ignored`)
    } else if (def.kind === 'menu' && isReservedTopLevelMenu(def.id) && def.parent !== undefined) {
      diagnostics.push(`Reserved menu "${def.id}" must be on the menu bar`)
    } else {
      entries.set(def.id, { def, seq })
    }
  })

  // parent menu id -> group id -> group
  const groups = new Map<string, Map<string, Group>>()
  const groupFor = (parent: string, id: string, seq: number) => {
    let byId = groups.get(parent)
    if (!byId) groups.set(parent, byId = new Map())
    let group = byId.get(id)
    if (!group) byId.set(id, group = { order: 0, seq, declared: false, entries: [] })
    return group
  }

  const parentProblem = (id: string, parent: string) => {
    const target = entries.get(parent)
    if (!target) return `Menu contribution "${id}" references unknown parent "${parent}"`
    if (target.def.kind !== 'menu') return `Menu contribution "${id}" has parent "${parent}", which is not a menu`
  }

  for (const { def, seq } of groupDefs) {
    const problem = parentProblem(def.id, def.parent)
    if (problem) {
      diagnostics.push(problem)
      continue
    }
    const group = groupFor(def.parent, def.id, seq)
    if (group.declared) {
      diagnostics.push(`Duplicate group "${def.id}" in menu "${def.parent}" ignored`)
      continue
    }
    group.declared = true
    group.order = def.order ?? 0
  }

  const topLevel: Entry[] = []
  const reported = new Set<string>()

  for (const entry of [...entries.values()].sort((a, b) => a.seq - b.seq)) {
    const { def } = entry
    if (def.parent === undefined) {
      topLevel.push(entry)
      continue
    }
    const problem = parentProblem(def.id, def.parent)
    if (problem) {
      diagnostics.push(problem)
      reported.add(def.id)
      continue
    }
    groupFor(def.parent, def.group ?? DEFAULT_GROUP, entry.seq).entries.push(entry)
  }

  const visited = new Set<string>()

  const build = (menu: MenuDefinition): SubmenuNode => {
    visited.add(menu.id)
    const children: MenuNode[] = []
    const menuGroups = [...(groups.get(menu.id)?.values() ?? [])].sort(byOrder)

    for (const group of menuGroups) {
      children.push({ type: 'separator' })
      for (const { def } of [...group.entries].sort(byEntryOrder)) {
        if (def.kind === 'menu') {
          children.push(build(def))
        } else {
          visited.add(def.id)
          children.push({ type: 'item', id: def.id, label: def.label, command: def.command, accelerator: def.accelerator })
        }
      }
      children.push({ type: 'separator' })
    }

    return { type: 'submenu', id: menu.id, label: menu.label, children }
  }

  const reservedEntry = (id: string) => topLevel.find(e => e.def.id === id)
  const contributed = topLevel
    .filter(e => !isReservedTopLevelMenu(e.def.id))
    .sort(byEntryOrder)

  const menus = [reservedEntry(FILE_MENU), reservedEntry(VIEW_MENU), ...contributed, reservedEntry(TOOLS_MENU), reservedEntry(HELP_MENU)]
    .filter((e): e is Entry => e !== undefined)
    .map(e => build(e.def as MenuDefinition))

  // Anything not reached from the menu bar sits under an orphaned ancestor or in a parent cycle.
  for (const id of entries.keys()) {
    if (!visited.has(id) && !reported.has(id)) {
      diagnostics.push(`Menu contribution "${id}" is not reachable from the menu bar`)
    }
  }

  return { menus, diagnostics }
}

function validate(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Menu contribution is not an object'

  const c = raw as Record<string, unknown>
  const isString = (v: unknown) => typeof v === 'string' && v.length > 0
  const isOptional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)

  if (!isString(c.id)) return 'Menu contribution is missing an id'
  const id = c.id as string
  if (!isOptional(c.order, v => typeof v === 'number' && Number.isFinite(v))) return `Menu contribution "${id}" has an invalid order`

  switch (c.kind) {
    case 'menu':
      if (!isString(c.label)) return `Menu "${id}" is missing a label`
      if (!isOptional(c.parent, isString) || !isOptional(c.group, isString)) return `Menu "${id}" has an invalid parent or group`
      return
    case 'item':
      if (!isString(c.label)) return `Menu item "${id}" is missing a label`
      if (!isString(c.parent)) return `Menu item "${id}" must have a parent menu`
      if (!isString(c.command)) return `Menu item "${id}" is missing a command`
      if (!isOptional(c.group, isString) || !isOptional(c.accelerator, isString)) return `Menu item "${id}" has an invalid group or accelerator`
      return
    case 'group':
      if (!isString(c.parent)) return `Menu group "${id}" must have a parent menu`
      return
    default:
      return `Menu contribution "${id}" has unknown kind "${String(c.kind)}"`
  }
}
