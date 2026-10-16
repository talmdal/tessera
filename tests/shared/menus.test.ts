import { describe, it, expect } from 'vitest'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { normalizeMenuNodes } from '../../shared/menus/normalize'
import {
  FILE_MENU,
  HELP_MENU,
  MenuContribution,
  MenuNode,
  TOOLS_MENU
} from '../../shared/menus/types'

const core: MenuContribution[] = [
  { kind: 'menu', id: FILE_MENU, label: 'File' },
  { kind: 'menu', id: TOOLS_MENU, label: 'Tools' },
  { kind: 'menu', id: HELP_MENU, label: 'Help' }
]

const item = (id: string, parent: string, extra: Partial<MenuContribution> = {}) =>
  ({ kind: 'item', id, label: id, parent, command: `cmd.${id}`, ...extra }) as MenuContribution

/** Compact view of a node list: item ids, '-' for separators, nested arrays for submenus. */
const shape = (nodes: MenuNode[]): unknown[] =>
  nodes.map(n => n.type === 'separator' ? '-' : n.type === 'item' ? n.id : { [n.id]: shape(n.children) })

const resolveMenu = (contributions: unknown[], id: string) =>
  resolveMenus(contributions).menus.find(m => m.id === id)!

describe('resolveMenus: menu bar positions', () => {
  it('places File first and Tools, Help last regardless of contribution order', () => {
    const { menus } = resolveMenus([
      { kind: 'menu', id: 'a', label: 'A', order: -1_000_000 },
      ...core.slice().reverse(),
      { kind: 'menu', id: 'b', label: 'B', order: 1_000_000 }
    ])

    expect(menus.map(m => m.id)).toEqual([FILE_MENU, 'a', 'b', TOOLS_MENU, HELP_MENU])
  })

  it('sorts contributed top-level menus by order, then registration order', () => {
    const { menus } = resolveMenus([
      ...core,
      { kind: 'menu', id: 'late', label: 'Late', order: 5 },
      { kind: 'menu', id: 'first', label: 'First' },
      { kind: 'menu', id: 'second', label: 'Second' }
    ])

    expect(menus.map(m => m.id)).toEqual([FILE_MENU, 'first', 'second', 'late', TOOLS_MENU, HELP_MENU])
  })

  it('rejects reserved menus that are not on the menu bar', () => {
    const { menus, diagnostics } = resolveMenus([
      { kind: 'menu', id: 'host', label: 'Host' },
      { kind: 'menu', id: HELP_MENU, label: 'Fake Help', parent: 'host' }
    ])

    expect(menus.map(m => m.id)).toEqual(['host'])
    expect(diagnostics).toContain(`Reserved menu "${HELP_MENU}" must be on the menu bar`)
  })

  it('keeps the first definition of a duplicated id', () => {
    const { menus, diagnostics } = resolveMenus([...core, { kind: 'menu', id: FILE_MENU, label: 'Hijacked' }])

    expect(menus[0].label).toBe('File')
    expect(diagnostics).toContain(`Duplicate menu id "${FILE_MENU}" ignored`)
  })
})

describe('resolveMenus: groups and hierarchy', () => {
  it('surrounds each group with separators, ordered by group order', () => {
    const file = resolveMenu([
      ...core,
      { kind: 'group', id: 'exit', parent: FILE_MENU, order: 100 },
      { kind: 'group', id: 'open', parent: FILE_MENU, order: 1 },
      item('exit', FILE_MENU, { group: 'exit' }),
      item('open', FILE_MENU, { group: 'open' }),
      item('recent', FILE_MENU, { group: 'open' }),
      item('loose', FILE_MENU)
    ], FILE_MENU)

    // 'additions' is implicit with order 0, so it sorts before 'open' (1)
    expect(shape(file.children)).toEqual(['-', 'loose', '-', '-', 'open', 'recent', '-', '-', 'exit', '-'])
  })

  it('orders entries within a group by order, then registration order', () => {
    const file = resolveMenu([
      ...core,
      item('c', FILE_MENU, { order: 2 }),
      item('a', FILE_MENU),
      item('b', FILE_MENU)
    ], FILE_MENU)

    expect(shape(normalizeMenuNodes(file.children))).toEqual(['a', 'b', 'c'])
  })

  it('builds nested submenus, each with their own groups', () => {
    const tools = resolveMenu([
      ...core,
      { kind: 'menu', id: 'reports', label: 'Reports', parent: TOOLS_MENU },
      { kind: 'menu', id: 'tax', label: 'Tax', parent: 'reports' },
      { kind: 'group', id: 'export', parent: 'tax', order: 1 },
      item('summary', 'tax'),
      item('csv', 'tax', { group: 'export' }),
      item('monthly', 'reports')
    ], TOOLS_MENU)

    expect(shape(normalizeMenuNodes(tools.children))).toEqual([
      { reports: [{ tax: ['summary', '-', 'csv'] }, 'monthly'] }
    ])
  })

  it('reports and skips entries with a missing or non-menu parent', () => {
    const { menus, diagnostics } = resolveMenus([
      ...core,
      item('orphan', 'nope'),
      item('host', FILE_MENU),
      item('child', 'host'),
      { kind: 'group', id: 'g', parent: 'nope' }
    ])

    expect(shape(normalizeMenuNodes(menus[0].children))).toEqual(['host'])
    expect(diagnostics).toEqual([
      'Menu contribution "g" references unknown parent "nope"',
      'Menu contribution "orphan" references unknown parent "nope"',
      'Menu contribution "child" has parent "host", which is not a menu'
    ])
  })

  it('reports entries caught in a parent cycle or under an orphan', () => {
    const { diagnostics } = resolveMenus([
      ...core,
      { kind: 'menu', id: 'x', label: 'X', parent: 'y' },
      { kind: 'menu', id: 'y', label: 'Y', parent: 'x' },
      { kind: 'menu', id: 'lost', label: 'Lost', parent: 'missing' },
      item('under-lost', 'lost')
    ])

    expect(diagnostics).toEqual([
      'Menu contribution "lost" references unknown parent "missing"',
      'Menu contribution "x" is not reachable from the menu bar',
      'Menu contribution "y" is not reachable from the menu bar',
      'Menu contribution "under-lost" is not reachable from the menu bar'
    ])
  })

  it('reports duplicate group declarations', () => {
    const { diagnostics } = resolveMenus([
      ...core,
      { kind: 'group', id: 'g', parent: FILE_MENU },
      { kind: 'group', id: 'g', parent: FILE_MENU }
    ])

    expect(diagnostics).toEqual([`Duplicate group "g" in menu "${FILE_MENU}" ignored`])
  })

  it('validates contribution shapes', () => {
    const { diagnostics } = resolveMenus([
      null,
      { kind: 'menu' },
      { kind: 'menu', id: 'm' },
      { kind: 'item', id: 'i', label: 'I', command: 'c' },
      { kind: 'item', id: 'j', label: 'J', parent: FILE_MENU },
      { kind: 'group', id: 'g' },
      { kind: 'widget', id: 'w' },
      { kind: 'menu', id: 'o', label: 'O', order: 'first' }
    ])

    expect(diagnostics).toEqual([
      'Menu contribution is not an object',
      'Menu contribution is missing an id',
      'Menu "m" is missing a label',
      'Menu item "i" must have a parent menu',
      'Menu item "j" is missing a command',
      'Menu group "g" must have a parent menu',
      'Menu contribution "w" has unknown kind "widget"',
      'Menu contribution "o" has an invalid order'
    ])
  })
})

describe('normalizeMenuNodes', () => {
  const sep: MenuNode = { type: 'separator' }
  const it_ = (id: string): MenuNode => ({ type: 'item', id, label: id, command: id })

  it('consolidates adjacent separators and trims the ends', () => {
    expect(shape(normalizeMenuNodes([sep, sep, it_('a'), sep, sep, sep, it_('b'), sep]))).toEqual(['a', '-', 'b'])
  })

  it('drops empty submenus and the separators they leave behind', () => {
    const nodes: MenuNode[] = [
      it_('a'),
      sep,
      { type: 'submenu', id: 'empty', label: 'Empty', children: [sep, sep] },
      sep,
      it_('b')
    ]

    expect(shape(normalizeMenuNodes(nodes))).toEqual(['a', '-', 'b'])
  })

  it('returns an empty list when only separators remain', () => {
    expect(normalizeMenuNodes([sep, sep])).toEqual([])
  })
})
