import { describe, it, expect } from 'vitest'
import { ICON_NAMES, isIconName, isIconUrl, resolveIcon } from '../../shared/layout/icons'
import { resolveBarItems } from '../../shared/layout/resolveBarItems'
import { BAR_SIDES, DEFAULT_BAR_SIZE, MIN_BAR_SIZE, SLOT_FOR_SIDE, barHasContent, layoutKey, maxBarSize, sideOfSlot } from '../../shared/layout/types'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { FILE_MENU, HELP_MENU, TOOLS_MENU, VIEW_MENU } from '../../shared/menus/types'

const iconUrlFor = (plugin: string, file: string) => plugin === 'headless' ? undefined : `tessera-plugin://${plugin}/${file}`

describe('slots and sizes', () => {
  it('names a slot for each side and finds the side of a slot', () => {
    expect(BAR_SIDES.map(side => SLOT_FOR_SIDE[side])).toEqual(['shell.top', 'shell.left', 'shell.right', 'shell.bottom'])
    expect(BAR_SIDES.map(side => sideOfSlot(SLOT_FOR_SIDE[side]))).toEqual(BAR_SIDES)
    expect(sideOfSlot('shell.main')).toBeUndefined()
    expect(sideOfSlot('shell.nowhere')).toBeUndefined()
  })

  it('treats a bar as having content when it has a view or an item', () => {
    expect(barHasContent({ views: [], items: [] })).toBe(false)
    expect(barHasContent({ views: ['a'], items: [] })).toBe(true)
    expect(barHasContent({ views: [], items: ['b'] })).toBe(true)
  })

  it('limits a bar to half the window in its dimension, but never below the minimum', () => {
    const window = { width: 1000, height: 600 }

    expect([maxBarSize('left', window), maxBarSize('right', window)]).toEqual([500, 500])
    expect([maxBarSize('top', window), maxBarSize('bottom', window)]).toEqual([300, 300])
    expect(maxBarSize('top', { width: 100, height: 50 })).toBe(MIN_BAR_SIZE)
    expect(Object.values(DEFAULT_BAR_SIZE).every(size => size >= MIN_BAR_SIZE)).toBe(true)
  })

  it('names the context keys of a side', () => {
    expect(layoutKey.hasContent('left')).toBe('shell.layout.left.hasContent')
    expect(layoutKey.visible('bottom')).toBe('shell.layout.bottom.visible')
    expect(layoutKey.mainActiveView).toBe('shell.layout.main.activeView')
  })
})

describe('resolveIcon', () => {
  it('passes a shell icon name through', () => {
    expect(resolveIcon('Save', 'p')).toEqual({ icon: 'Save' })
    expect(ICON_NAMES.every(isIconName)).toBe(true)
  })

  it('turns a file in the plugin\'s renderer folder into its URL', () => {
    expect(resolveIcon('./icons/a.svg', 'p', iconUrlFor)).toEqual({ icon: 'tessera-plugin://p/icons/a.svg' })
  })

  it.each([
    ['an unknown name', 'Nope', 'unknown icon "Nope"'],
    ['a file with no renderer to serve it', './a.svg', 'icon "./a.svg" needs a plugin with a renderer entry'],
    ['a path that leaves the folder', './../secret.svg', 'icon "./../secret.svg" must be a file inside the plugin\'s renderer folder'],
    ['a nested path that leaves the folder', './a/../../b.svg', 'icon "./a/../../b.svg" must be a file inside the plugin\'s renderer folder'],
    ['a backslash path', './a\\b.svg', 'icon "./a\\b.svg" must be a file inside the plugin\'s renderer folder'],
    ['an empty path', './', 'icon "./" must be a file inside the plugin\'s renderer folder']
  ])('rejects %s', (_name, icon, problem) => {
    expect(resolveIcon(icon, 'p')).toEqual({ problem })
  })

  it('rejects a file icon for a plugin without a renderer', () => {
    expect(resolveIcon('./a.svg', 'headless', iconUrlFor)).toEqual({ problem: 'icon "./a.svg" needs a plugin with a renderer entry' })
  })

  it('tells a URL from a name', () => {
    expect(isIconUrl('tessera-plugin://p/a.svg')).toBe(true)
    expect(isIconUrl('Save')).toBe(false)
  })
})

describe('resolveBarItems', () => {
  const button = (id: string, extra: Record<string, unknown> = {}) =>
    ({ contributor: 'p', impl: { kind: 'button', id, slot: 'shell.top', label: id, command: 'p.run', ...extra } })
  const text = (id: string, extra: Record<string, unknown> = {}) =>
    ({ contributor: 'p', impl: { kind: 'text', id, slot: 'shell.bottom', text: id, ...extra } })

  it('attaches the plugin id and sorts by order, then registration', () => {
    const { items, diagnostics } = resolveBarItems([button('late', { order: 5 }), button('a'), text('b')])

    expect(diagnostics).toEqual([])
    expect(items.map(i => i.id)).toEqual(['a', 'b', 'late'])
    expect(items[0]).toMatchObject({ kind: 'button', pluginId: 'p', label: 'a', command: 'p.run' })
  })

  it('resolves icons, and keeps unnamed ones unset', () => {
    const { items } = resolveBarItems([button('file', { icon: './i.svg' }), button('named', { icon: 'Save' }), button('none')], iconUrlFor)

    expect(items.map(i => i.icon)).toEqual(['tessera-plugin://p/i.svg', 'Save', undefined])
    expect(items[2]).not.toHaveProperty('icon')
  })

  it('accepts text with and without a command, align, tooltip and when', () => {
    const { items, diagnostics } = resolveBarItems([
      text('t1'),
      text('t2', { command: 'p.open', align: 'end', tooltip: 'Open', when: 'vault.isOpen' })
    ])

    expect(diagnostics).toEqual([])
    expect(items).toHaveLength(2)
  })

  it.each([
    ['a non-object', null, 'Bar item contribution is not an object'],
    ['a missing id', { kind: 'text', slot: 'shell.top', text: 'x' }, 'Bar item contribution is missing an id'],
    ['the main slot', { kind: 'text', id: 'x', slot: 'shell.main', text: 'x' }, 'Bar item "x" must target a bar slot, not "shell.main"'],
    ['a missing slot', { kind: 'text', id: 'x', text: 'x' }, 'Bar item "x" must target a bar slot, not "undefined"'],
    ['an unknown kind', { kind: 'link', id: 'x', slot: 'shell.top' }, 'Bar item "x" has unknown kind "link"'],
    ['a button without a label', { kind: 'button', id: 'x', slot: 'shell.top', command: 'c' }, 'Bar item "x" is missing a label'],
    ['a button without a command', { kind: 'button', id: 'x', slot: 'shell.top', label: 'X' }, 'Bar item "x" is missing a command'],
    ['text without text', { kind: 'text', id: 'x', slot: 'shell.top' }, 'Bar item "x" is missing its text'],
    ['text with a bad command', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', command: 4 }, 'Bar item "x" has an invalid command'],
    ['a bad icon type', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', icon: 4 }, 'Bar item "x" has an invalid icon'],
    ['a bad tooltip', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', tooltip: 4 }, 'Bar item "x" has an invalid tooltip'],
    ['a bad align', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', align: 'middle' }, 'Bar item "x" has an invalid align'],
    ['a bad order', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', order: NaN }, 'Bar item "x" has an invalid order'],
    ['a bad when type', { kind: 'text', id: 'x', slot: 'shell.top', text: 'x', when: 4 }, 'Bar item "x" has an invalid when expression']
  ])('skips %s', (_name, impl, problem) => {
    const { items, diagnostics } = resolveBarItems([{ contributor: 'p', impl }])

    expect(items).toEqual([])
    expect(diagnostics).toEqual([problem])
  })

  it('skips an invalid when expression and describes it', () => {
    const { items, diagnostics } = resolveBarItems([text('x', { when: 'a ||' })])

    expect(items).toEqual([])
    expect(diagnostics[0]).toContain('Bar item "x" has an invalid when expression: Invalid expression "a ||"')
  })

  it('skips a duplicate id and an unresolvable icon', () => {
    const { items, diagnostics } = resolveBarItems([
      button('a'),
      button('a'),
      button('b', { icon: 'Nope' }),
      button('c', { icon: './c.svg' })
    ])

    expect(items.map(i => i.id)).toEqual(['a'])
    expect(diagnostics).toEqual([
      'Duplicate bar item id "a" ignored',
      'Bar item "b" ignored: unknown icon "Nope"',
      'Bar item "c" ignored: icon "./c.svg" needs a plugin with a renderer entry'
    ])
  })
})

describe('the View menu', () => {
  const core = [
    { kind: 'menu', id: FILE_MENU, label: 'File' },
    { kind: 'menu', id: VIEW_MENU, label: 'View' },
    { kind: 'menu', id: TOOLS_MENU, label: 'Tools' },
    { kind: 'menu', id: HELP_MENU, label: 'Help' }
  ]

  it('sits after File and before plugin menus, whatever the contribution order', () => {
    const { menus } = resolveMenus([
      { kind: 'menu', id: 'accounts', label: 'Accounts', order: -1_000_000 },
      ...core.slice().reverse()
    ])

    expect(menus.map(m => m.id)).toEqual([FILE_MENU, VIEW_MENU, 'accounts', TOOLS_MENU, HELP_MENU])
  })

  it('must be on the menu bar', () => {
    const { menus, diagnostics } = resolveMenus([...core, { kind: 'menu', id: VIEW_MENU + '-x', label: 'X' }, { kind: 'menu', id: VIEW_MENU, label: 'Again', parent: FILE_MENU }])

    expect(menus.map(m => m.id)).toContain(VIEW_MENU)
    expect(diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate menu id "shell.view"')]))
  })

  it('is optional: the bar is still valid without it', () => {
    const { menus } = resolveMenus([core[0], core[2], core[3]])

    expect(menus.map(m => m.id)).toEqual([FILE_MENU, TOOLS_MENU, HELP_MENU])
  })
})
