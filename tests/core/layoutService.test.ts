import { describe, it, expect, vi } from 'vitest'
import { ContextKeyServiceImpl } from '../../core/context/ContextKeyService'
import type { LayoutPreferences } from '@tessera/types'
import { LayoutContentRef, LayoutService } from '../../core/layout/LayoutService'
import { DEFAULT_BAR_SIZE, MIN_BAR_SIZE } from '../../shared/layout/types'
import { createLogger } from '../helpers/runtime'

/** A content source the test mutates, with a manual change event. */
function fakeContent(views: LayoutContentRef[] = [], items: LayoutContentRef[] = []) {
  const listeners = new Set<() => void>()
  return {
    views: () => views,
    items: () => items,
    onDidChange: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    set(nextViews: LayoutContentRef[], nextItems: LayoutContentRef[] = items) {
      views = nextViews
      items = nextItems
      listeners.forEach(l => l())
    }
  }
}

const leftView = (id: string, when?: string): LayoutContentRef => ({ id, slot: 'shell.left', when })

function setup(views: LayoutContentRef[] = [], items: LayoutContentRef[] = []) {
  const content = fakeContent(views, items)
  const keys = new ContextKeyServiceImpl()
  const service = new LayoutService(content, keys, { log: createLogger() })
  return { content, keys, service }
}

describe('LayoutService', () => {
  it('computes presence per slot, in order, with the first view active', () => {
    const { service } = setup(
      [leftView('a'), { id: 'm', slot: 'shell.main' }, leftView('b')],
      [{ id: 'i', slot: 'shell.left' }]
    )

    const state = service.attachWindow(1, 'main')

    expect(state.windowId).toBe(1)
    expect(state.bars.left).toMatchObject({ views: ['a', 'b'], items: ['i'], activeView: 'a', collapsed: false, size: DEFAULT_BAR_SIZE.left })
    expect(state.main).toEqual({ views: ['m'], items: [], activeView: 'm' })
    expect(state.bars.right).toMatchObject({ views: [], items: [] })
  })

  it('hides and shows contributions as their when expressions follow the context keys', () => {
    const { keys, service } = setup([leftView('a', 'vault.isOpen')])
    const changed = vi.fn()
    service.onDidChange(changed)
    service.attachWindow(1, 'main')

    expect(service.get(1).bars.left.views).toEqual([])

    keys.set('vault.isOpen', true)
    expect(service.get(1).bars.left.views).toEqual(['a'])
    expect(service.get(1).bars.left.activeView).toBe('a')
    expect(changed).toHaveBeenCalledTimes(1)

    // A key change that affects nothing is silent
    keys.set('unrelated', 1)
    expect(changed).toHaveBeenCalledTimes(1)

    keys.set('vault.isOpen', undefined)
    expect(service.get(1).bars.left.views).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('treats an invalid when expression as never present', () => {
    const log = createLogger()
    const content = fakeContent([leftView('a', '&&')])
    const service = new LayoutService(content, new ContextKeyServiceImpl(), { log })
    service.attachWindow(1, 'main')

    expect(service.get(1).bars.left.views).toEqual([])
    expect(log.warn).toHaveBeenCalled()
  })

  it('reacts to content changes and announces only windows whose state changed', () => {
    const { content, service } = setup()
    const changed = vi.fn()
    service.attachWindow(1, 'main')
    service.onDidChange(changed)

    content.set([leftView('a')])
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ windowId: 1 }))
    expect(service.get(1).bars.left.views).toEqual(['a'])

    content.set([leftView('a')])   // same content again
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps each window independent', () => {
    const { service } = setup([leftView('a')])
    service.attachWindow(1, 'main')
    service.attachWindow(2, 'second')

    service.setSlot(1, { slot: 'shell.left', collapsed: true })

    expect(service.get(1).bars.left.collapsed).toBe(true)
    expect(service.get(2).bars.left.collapsed).toBe(false)
  })

  describe('setSlot', () => {
    it('applies collapse, clamped size and the active tab', () => {
      const { service } = setup([leftView('a'), leftView('b')])
      service.attachWindow(1, 'main')

      service.setSlot(1, { slot: 'shell.left', activeView: 'b', collapsed: true })
      expect(service.get(1).bars.left).toMatchObject({ activeView: 'b', collapsed: true })

      service.setSlot(1, { slot: 'shell.left', size: 12 })
      expect(service.get(1).bars.left.size).toBe(MIN_BAR_SIZE)

      service.setSlot(1, { slot: 'shell.main', activeView: undefined })  // a no-op is fine
    })

    it('rejects unknown slots, absent views, and collapsing the main slot', () => {
      const { service } = setup([leftView('a', 'nope')])
      service.attachWindow(1, 'main')

      expect(() => service.setSlot(1, { slot: 'shell.middle' })).toThrow('Unknown slot "shell.middle"')
      expect(() => service.setSlot(1, { slot: 'shell.left', activeView: 'a' })).toThrow('not present')
      expect(() => service.setSlot(1, { slot: 'shell.main', collapsed: true })).toThrow('cannot be collapsed')
      expect(() => service.setSlot(2, { slot: 'shell.left' })).toThrow('Unknown window 2')
    })

    it('remembers a collapse on a bar without content', () => {
      const { content, service } = setup()
      service.attachWindow(1, 'main')

      service.setSlot(1, { slot: 'shell.left', collapsed: true })
      content.set([leftView('a')])

      expect(service.get(1).bars.left).toMatchObject({ views: ['a'], collapsed: true })
    })
  })

  it('falls back to the first present view when the active one disappears, and returns to it', () => {
    const { keys, service } = setup([leftView('a', 'vault.isOpen'), leftView('b')])
    keys.set('vault.isOpen', true)
    service.attachWindow(1, 'main')
    service.setSlot(1, { slot: 'shell.left', activeView: 'a' })

    keys.set('vault.isOpen', false)
    expect(service.get(1).bars.left.activeView).toBe('b')

    keys.set('vault.isOpen', true)
    expect(service.get(1).bars.left.activeView).toBe('a')
  })

  describe('reveal', () => {
    it('activates the view, expands its bar and fires onDidReveal', () => {
      const { service } = setup([leftView('a'), leftView('b')])
      const revealed = vi.fn()
      service.onDidReveal(revealed)
      service.attachWindow(1, 'main')
      service.setSlot(1, { slot: 'shell.left', collapsed: true })

      service.reveal(1, 'b')

      expect(service.get(1).bars.left).toMatchObject({ activeView: 'b', collapsed: false })
      expect(revealed).toHaveBeenCalledWith({ windowId: 1, viewId: 'b', slot: 'shell.left' })
    })

    it('reveals a main view by making it active', () => {
      const { service } = setup([{ id: 'm1', slot: 'shell.main' }, { id: 'm2', slot: 'shell.main' }])
      service.attachWindow(1, 'main')

      service.reveal(1, 'm2')

      expect(service.get(1).main.activeView).toBe('m2')
    })

    it('rejects unknown and absent views', () => {
      const { service } = setup([leftView('a', 'nope')])
      service.attachWindow(1, 'main')

      expect(() => service.reveal(1, 'ghost')).toThrow('Unknown view "ghost"')
      expect(() => service.reveal(1, 'a')).toThrow('not present')
    })
  })

  it('resets a window to the defaults', () => {
    const { service } = setup([leftView('a'), leftView('b')])
    service.attachWindow(1, 'main')
    service.setSlot(1, { slot: 'shell.left', collapsed: true, size: 500, activeView: 'b' })

    service.reset(1)

    expect(service.get(1).bars.left).toMatchObject({
      collapsed: false, size: DEFAULT_BAR_SIZE.left, activeView: 'a'
    })
  })

  it('loads preferences by window key, saves them on change and on detach', () => {
    const stored = new Map<string, LayoutPreferences>([
      ['main', { bars: { left: { collapsed: true, size: 42, activeView: 'b' } } }]
    ])
    const persistence = {
      load: vi.fn((key: string) => stored.get(key)),
      save: vi.fn((key: string, prefs: LayoutPreferences) => { stored.set(key, JSON.parse(JSON.stringify(prefs))) })
    }
    const content = fakeContent([leftView('a'), leftView('b')])
    const service = new LayoutService(content, new ContextKeyServiceImpl(), { persistence })

    const state = service.attachWindow(1, 'main')
    expect(state.bars.left).toMatchObject({ collapsed: true, size: MIN_BAR_SIZE, activeView: 'b' })

    service.setSlot(1, { slot: 'shell.left', collapsed: false })
    expect(persistence.save).toHaveBeenCalledWith('main', expect.objectContaining({
      bars: expect.objectContaining({ left: expect.objectContaining({ collapsed: false }) })
    }))

    service.detachWindow(1)
    expect(service.has(1)).toBe(false)

    // A fresh window under the same key starts from the saved preferences
    expect(service.attachWindow(2, 'main').bars.left.collapsed).toBe(false)
  })

  it('survives a persistence layer that throws', () => {
    const log = createLogger()
    const persistence = {
      load: () => { throw new Error('disk') },
      save: () => { throw new Error('disk') }
    }
    const service = new LayoutService(fakeContent([leftView('a')]), new ContextKeyServiceImpl(), { persistence, log })

    const state = service.attachWindow(1, 'main')
    expect(state.bars.left.size).toBe(DEFAULT_BAR_SIZE.left)
    service.setSlot(1, { slot: 'shell.left', collapsed: true })
    expect(log.warn).toHaveBeenCalled()
  })

  it('stops reacting once disposed', () => {
    const { keys, service } = setup([leftView('a', 'k')])
    const changed = vi.fn()
    service.onDidChange(changed)
    service.attachWindow(1, 'main')
    service.dispose()

    keys.set('k', true)
    expect(changed).not.toHaveBeenCalled()
  })
})
