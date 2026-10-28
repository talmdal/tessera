import { describe, it, expect } from 'vitest'
import { setupLayout as setup } from '../helpers/layout'

describe('LayoutService: when expressions', () => {
  it('shows a view only while its expression holds, and follows the context key', () => {
    const { layout, contribute, contextKeys } = setup()
    contribute('accounts', 'shell.left', { when: 'vault.isOpen' })
    layout.attach(1)
    expect(layout.get(1).bars.left.views).toEqual([])

    contextKeys.set('vault.isOpen', true)
    expect(layout.get(1).bars.left.views).toEqual(['accounts'])

    contextKeys.set('vault.isOpen', false)
    expect(layout.get(1).bars.left.views).toEqual([])
  })

  it('evaluates comparisons and boolean operators', () => {
    const { layout, contribute, contextKeys } = setup()
    contribute('page', 'shell.main', { when: "mode == 'edit' && !readonly" })
    layout.attach(1)

    contextKeys.set('mode', 'edit')
    expect(layout.get(1).main.views).toEqual(['page'])

    contextKeys.set('readonly', true)
    expect(layout.get(1).main.views).toEqual([])
  })

  it('announces a window when a key makes a view appear, with the window id, and not for unrelated keys', () => {
    const { layout, contribute, contextKeys, changes } = setup()
    contribute('accounts', 'shell.left', { when: 'vault.isOpen' })
    layout.attach(1)
    changes.length = 0

    contextKeys.set('unrelated', 1)
    expect(changes).toEqual([])

    contextKeys.set('vault.isOpen', true)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ windowId: 1, bars: { left: { views: ['accounts'] } } })
  })

  it('hides a bar when its last view goes absent, and keeps its collapsed preference for when it returns', () => {
    const { layout, contribute, contextKeys } = setup()
    contribute('accounts', 'shell.left', { when: 'vault.isOpen' })
    contextKeys.set('vault.isOpen', true)
    layout.attach(1)
    layout.setSlot(1, { slot: 'shell.left', collapsed: true })

    contextKeys.set('vault.isOpen', undefined)
    expect(layout.get(1).bars.left).toMatchObject({ views: [], items: [], collapsed: true })
    expect(layout.hasContent('left')).toBe(false)

    contextKeys.set('vault.isOpen', true)
    expect(layout.get(1).bars.left).toMatchObject({ views: ['accounts'], collapsed: true })
  })

  it('falls back to the first main view when the active one\'s expression turns false', () => {
    const { layout, contribute, contextKeys } = setup()
    contribute('home', 'shell.main')
    contribute('register', 'shell.main', { when: 'vault.isOpen' })
    contextKeys.set('vault.isOpen', true)
    layout.attach(1)
    layout.reveal(1, 'register')

    contextKeys.set('vault.isOpen', false)

    expect(layout.get(1).main).toMatchObject({ views: ['home'], activeView: 'home' })
  })

  it('skips a view whose expression is invalid', () => {
    const { layout, contribute } = setup()
    contribute('bad', 'shell.left', { when: 'a &&' })

    expect(layout.attach(1).bars.left.views).toEqual([])
  })

  it('skips bar views that name no icon, but not main views', () => {
    const { layout, contribute } = setup()
    contribute('no-icon', 'shell.left', { icon: undefined })
    contribute('page', 'shell.main')

    const state = layout.attach(1)

    expect(state.bars.left.views).toEqual([])
    expect(state.main.views).toEqual(['page'])
  })
})

describe('LayoutService: bar items', () => {
  it('lists present items per slot in order, alongside views, and none in the main area', () => {
    const { layout, contribute, contributeItem } = setup()
    contribute('log', 'shell.bottom')
    contributeItem('late', 'shell.bottom', { order: 9 })
    contributeItem('first', 'shell.bottom')
    contributeItem('save', 'shell.top')

    const state = layout.attach(1)

    expect(state.bars.bottom).toMatchObject({ views: ['log'], items: ['first', 'late'] })
    expect(state.bars.top).toMatchObject({ views: [], items: ['save'] })
    expect(state.bars.top).not.toHaveProperty('activeView')
    expect(state.main.items).toEqual([])
  })

  it('shows an item only while its expression holds', () => {
    const { layout, contributeItem, contextKeys } = setup()
    contributeItem('dirty', 'shell.bottom', { kind: 'text', text: 'Unsaved changes', command: undefined, when: 'vault.isDirty' })
    layout.attach(1)
    expect(layout.get(1).bars.bottom.items).toEqual([])

    contextKeys.set('vault.isDirty', true)
    expect(layout.get(1).bars.bottom.items).toEqual(['dirty'])
  })

  it('makes a bar that holds only items count as having content', () => {
    const { layout, contributeItem } = setup()
    const registration = contributeItem('status', 'shell.bottom', { kind: 'text', text: 'Ready', command: undefined })
    layout.attach(1)
    expect(layout.hasContent('bottom')).toBe(true)

    registration.dispose()

    expect(layout.hasContent('bottom')).toBe(false)
    expect(layout.get(1).bars.bottom.items).toEqual([])
  })

  it('announces a window when an item is contributed', () => {
    const { layout, contributeItem, changes } = setup()
    layout.attach(1)
    changes.length = 0

    contributeItem('save', 'shell.top')

    expect(changes).toHaveLength(1)
    expect(changes[0].bars.top.items).toEqual(['save'])
  })

  it('ignores invalid items and items for the main slot', () => {
    const { layout, contributeItem } = setup()
    contributeItem('main-item', 'shell.main')
    contributeItem('no-command', 'shell.top', { command: undefined })
    contributeItem('bad-icon', 'shell.top', { icon: 'NotAnIcon' })

    expect(layout.attach(1).bars.top.items).toEqual([])
  })

  it('resolves a plugin file icon only for a plugin with a renderer', () => {
    const { layout, contributeItem } = setup({ p: 'tessera-plugin://p/remoteEntry.js', headless: undefined })
    contributeItem('with', 'shell.top', { icon: './icons/a.svg' })
    contributeItem('without', 'shell.top', { icon: './icons/a.svg' }, 'headless')

    expect(layout.attach(1).bars.top.items).toEqual(['with'])
  })
})
