import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_BAR_SIZE } from '../../shared/layout/types'
import { setupLayout as setup } from '../helpers/layout'

describe('LayoutService: acting on a window', () => {
  describe('toggle', () => {
    it('collapses an expanded bar and expands a collapsed one', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.left')
      layout.attach(1)

      expect(layout.toggle(1, 'left').bars.left.collapsed).toBe(true)
      expect(layout.toggle(1, 'left').bars.left.collapsed).toBe(false)
    })

    it('leaves other bars and other windows alone', () => {
      const { layout } = setup()
      layout.attach(1)
      layout.attach(2)

      layout.toggle(1, 'bottom')

      expect(layout.get(1).bars.top.collapsed).toBe(false)
      expect(layout.get(2).bars.bottom.collapsed).toBe(false)
    })

    it('rejects a window that is not attached', () => {
      const { layout } = setup()

      expect(() => layout.toggle(3, 'left')).toThrow('Unknown window: 3')
    })
  })

  describe('setAllCollapsed', () => {
    it('collapses and expands only the bars that have content', () => {
      const { layout, contribute, contributeItem } = setup()
      contribute('a', 'shell.left')
      contributeItem('status', 'shell.bottom')
      layout.attach(1)

      const collapsed = layout.setAllCollapsed(1, true).bars
      expect([collapsed.left.collapsed, collapsed.bottom.collapsed, collapsed.top.collapsed, collapsed.right.collapsed])
        .toEqual([true, true, false, false])

      const expanded = layout.setAllCollapsed(1, false).bars
      expect(Object.values(expanded).map(bar => bar.collapsed)).toEqual([false, false, false, false])
    })
  })

  describe('reset', () => {
    it('restores default sizes, expands every bar and makes the first view active everywhere', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.left')
      contribute('b', 'shell.left')
      contribute('home', 'shell.main')
      contribute('register', 'shell.main')
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.left', activeView: 'b', collapsed: true, size: 400 })
      layout.setSlot(1, { slot: 'shell.main', activeView: 'register' })

      const state = layout.reset(1)

      expect(state.bars.left).toMatchObject({ activeView: 'a', collapsed: false, size: DEFAULT_BAR_SIZE.left })
      expect(state.main.activeView).toBe('home')
    })

    it('only resets the window asked', () => {
      const { layout } = setup()
      layout.attach(1)
      layout.attach(2)
      layout.setSlot(1, { slot: 'shell.top', size: 300 })
      layout.setSlot(2, { slot: 'shell.top', size: 300 })

      layout.reset(1)

      expect(layout.get(1).bars.top.size).toBe(DEFAULT_BAR_SIZE.top)
      expect(layout.get(2).bars.top.size).toBe(300)
    })
  })

  describe('reveal', () => {
    it('makes a main view the active one', () => {
      const { layout, contribute } = setup()
      contribute('home', 'shell.main')
      contribute('register', 'shell.main')
      layout.attach(1)

      expect(layout.reveal(1, 'register').main.activeView).toBe('register')
    })

    it('activates a bar view and expands its bar', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.right')
      contribute('b', 'shell.right')
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.right', collapsed: true })

      const state = layout.reveal(1, 'b')

      expect(state.bars.right).toMatchObject({ activeView: 'b', collapsed: false })
    })

    it('announces the new state first, then the reveal, so listeners can rely on the state', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.right')
      contribute('b', 'shell.right')
      layout.attach(1)
      const order: string[] = []
      layout.onDidChange(state => order.push(`changed:${state.bars.right.activeView}`))
      layout.onDidReveal(revealed => order.push(`revealed:${JSON.stringify(revealed)}`))

      layout.reveal(1, 'b')

      expect(order).toEqual(['changed:b', 'revealed:{"windowId":1,"viewId":"b","slot":"shell.right"}'])
    })

    it('still announces a reveal of the view that was already active', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.left')
      layout.attach(1)
      const revealed = vi.fn()
      layout.onDidReveal(revealed)

      layout.reveal(1, 'a')

      expect(revealed).toHaveBeenCalledWith({ windowId: 1, viewId: 'a', slot: 'shell.left' })
    })

    it('rejects a view that is unknown or absent, and announces nothing', () => {
      const { layout, contribute, contextKeys, changes } = setup()
      contribute('hidden', 'shell.left', { when: 'show' })
      layout.attach(1)
      changes.length = 0
      const revealed = vi.fn()
      layout.onDidReveal(revealed)

      expect(() => layout.reveal(1, 'ghost')).toThrow('View "ghost" is not present')
      expect(() => layout.reveal(1, 'hidden')).toThrow('View "hidden" is not present')
      expect(revealed).not.toHaveBeenCalled()
      expect(changes).toEqual([])

      contextKeys.set('show', true)
      expect(() => layout.reveal(1, 'hidden')).not.toThrow()
    })
  })

  describe('hasContent', () => {
    it('is true when a view or an item is present in the bar, whatever the window', () => {
      const { layout, contribute, contributeItem } = setup()
      expect(layout.hasContent('left')).toBe(false)

      contribute('a', 'shell.left')
      contributeItem('b', 'shell.top')

      expect(layout.hasContent('left')).toBe(true)
      expect(layout.hasContent('top')).toBe(true)
      expect(layout.hasContent('right')).toBe(false)
    })
  })
})
