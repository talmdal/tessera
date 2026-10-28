import { describe, it, expect, vi } from 'vitest'
import type { LayoutState } from '@tessera/types'
import { DEFAULT_BAR_SIZE, MIN_BAR_SIZE } from '../../shared/layout/types'
import { setupLayout as setup } from '../helpers/layout'

describe('LayoutService', () => {
  describe('a new window', () => {
    it('starts with every slot empty, expanded, at its default size', () => {
      const { layout } = setup()

      expect(layout.attach(1)).toEqual({
        windowId: 1,
        main: { views: [], items: [] },
        bars: {
          top: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.top },
          bottom: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.bottom },
          left: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.left },
          right: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.right }
        }
      })
    })

    it('lists each slot\'s present views in order, with the first active', () => {
      const { layout, contribute } = setup()
      contribute('late', 'shell.left', { order: 5 })
      contribute('first', 'shell.left')
      contribute('page', 'shell.main')
      contribute('log', 'shell.bottom')

      const state = layout.attach(1)

      expect(state.bars.left).toMatchObject({ views: ['first', 'late'], activeView: 'first' })
      expect(state.bars.bottom).toMatchObject({ views: ['log'], activeView: 'log' })
      expect(state.main).toEqual({ views: ['page'], items: [], activeView: 'page' })
      expect(state.bars.top.views).toEqual([])
      expect(state.bars.top).not.toHaveProperty('activeView')
    })

    it('ignores views that the views list would not show', () => {
      const { layout, contribute } = setup({ p: 'tessera-plugin://p/remoteEntry.js', headless: undefined })
      contribute('no-renderer', 'shell.left', {}, 'headless')
      contribute('unknown-slot', 'shell.nowhere')
      contribute('not-a-module', 'shell.left', { module: 'View' })

      expect(layout.attach(1).bars.left.views).toEqual([])
    })

    it('rejects attaching the same window twice', () => {
      const { layout } = setup()
      layout.attach(1)

      expect(() => layout.attach(1)).toThrow('Window 1 is already attached')
    })
  })

  describe('presence follows the contributions', () => {
    it('shows a view that is contributed after the window attached, and drops it when it is disposed', () => {
      const { layout, contribute } = setup()
      layout.attach(1)

      const registration = contribute('accounts', 'shell.left')
      expect(layout.get(1).bars.left.views).toEqual(['accounts'])

      registration.dispose()
      expect(layout.get(1).bars.left.views).toEqual([])
    })

    it('makes the first view active when the active one goes away, and restores the choice when it returns', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.right')
      const b = contribute('b', 'shell.right')
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.right', activeView: 'b' })
      expect(layout.get(1).bars.right.activeView).toBe('b')

      b.dispose()
      expect(layout.get(1).bars.right).toMatchObject({ views: ['a'], activeView: 'a' })

      contribute('b', 'shell.right')
      expect(layout.get(1).bars.right.activeView).toBe('b')
    })

    it('falls back to the first main view when the chosen one is gone', () => {
      const { layout, contribute } = setup()
      contribute('home', 'shell.main')
      const register = contribute('register', 'shell.main')
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.main', activeView: 'register' })

      register.dispose()

      expect(layout.get(1).main).toMatchObject({ views: ['home'], activeView: 'home' })
    })

    it('keeps a bar\'s preferences while it has no content', () => {
      const { layout, contribute } = setup()
      const view = contribute('accounts', 'shell.left')
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.left', collapsed: true, size: 400 })

      view.dispose()
      expect(layout.get(1).bars.left).toMatchObject({ views: [], collapsed: true, size: 400 })

      contribute('accounts', 'shell.left')
      expect(layout.get(1).bars.left).toMatchObject({ views: ['accounts'], collapsed: true, size: 400 })
    })

    it('picks up a plugin whose renderer only became known later when refreshed', () => {
      const { layout, contribute, entries } = setup({ p: 'tessera-plugin://p/remoteEntry.js' })
      contribute('early', 'shell.left', {}, 'late-plugin')
      layout.attach(1)
      expect(layout.get(1).bars.left.views).toEqual([])

      entries['late-plugin'] = 'tessera-plugin://late-plugin/remoteEntry.js'
      layout.refresh()

      expect(layout.get(1).bars.left.views).toEqual(['early'])
    })
  })

  describe('setSlot', () => {
    it('chooses a tab, collapses and resizes a bar, and returns the new state', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.bottom')
      contribute('b', 'shell.bottom')
      layout.attach(1)

      const state = layout.setSlot(1, { slot: 'shell.bottom', activeView: 'b', collapsed: true, size: 250 })

      expect(state.bars.bottom).toMatchObject({ activeView: 'b', collapsed: true, size: 250 })
      expect(layout.get(1)).toEqual(state)
    })

    it('expands again', () => {
      const { layout } = setup()
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.top', collapsed: true })

      expect(layout.setSlot(1, { slot: 'shell.top', collapsed: false }).bars.top.collapsed).toBe(false)
    })

    it('sets the active main view', () => {
      const { layout, contribute } = setup()
      contribute('home', 'shell.main')
      contribute('register', 'shell.main')
      layout.attach(1)

      expect(layout.setSlot(1, { slot: 'shell.main', activeView: 'register' }).main.activeView).toBe('register')
    })

    it('raises a size below the minimum to the minimum and rounds fractions', () => {
      const { layout } = setup()
      layout.attach(1)

      expect(layout.setSlot(1, { slot: 'shell.left', size: 5 }).bars.left.size).toBe(MIN_BAR_SIZE)
      expect(layout.setSlot(1, { slot: 'shell.left', size: 300.6 }).bars.left.size).toBe(301)
    })

    it('stores a preference for a bar that has no content', () => {
      const { layout } = setup()
      layout.attach(1)

      expect(layout.setSlot(1, { slot: 'shell.right', collapsed: true }).bars.right.collapsed).toBe(true)
    })

    it.each([
      ['an unknown slot', { slot: 'shell.nowhere' }, 'Unknown slot: shell.nowhere'],
      ['a missing slot', {} as any, 'A slot is required'],
      ['a view that is not there', { slot: 'shell.left', activeView: 'ghost' }, 'View "ghost" is not present in shell.left'],
      ['a view of another slot', { slot: 'shell.left', activeView: 'on-right' }, 'View "on-right" is not present in shell.left'],
      ['collapsing the main area', { slot: 'shell.main', collapsed: true }, 'The main area cannot be collapsed'],
      ['resizing the main area', { slot: 'shell.main', size: 300 }, 'The main area cannot be resized'],
      ['a non-numeric size', { slot: 'shell.left', size: '300' as any }, 'size must be a number'],
      ['an infinite size', { slot: 'shell.left', size: Infinity }, 'size must be a number'],
      ['a non-boolean collapsed', { slot: 'shell.left', collapsed: 'yes' as any }, 'collapsed must be true or false'],
      ['a non-string activeView', { slot: 'shell.left', activeView: 3 as any }, 'activeView must be a view id']
    ])('rejects %s and changes nothing', (_name, request, message) => {
      const { layout, contribute, changes } = setup()
      contribute('on-right', 'shell.right')
      layout.attach(1)
      const before = layout.get(1)
      changes.length = 0

      expect(() => layout.setSlot(1, request)).toThrow(message)
      expect(layout.get(1)).toEqual(before)
      expect(changes).toEqual([])
    })

    it('does not apply any part of a request that is partly invalid', () => {
      const { layout } = setup()
      layout.attach(1)

      expect(() => layout.setSlot(1, { slot: 'shell.left', collapsed: true, activeView: 'ghost' })).toThrow()
      expect(layout.get(1).bars.left.collapsed).toBe(false)
    })
  })

  describe('windows', () => {
    it('keeps each window\'s preferences separate', () => {
      const { layout, contribute } = setup()
      contribute('a', 'shell.left')
      contribute('b', 'shell.left')
      layout.attach(1)
      layout.attach(2)

      layout.setSlot(1, { slot: 'shell.left', collapsed: true, activeView: 'b', size: 333 })

      expect(layout.get(1).bars.left).toMatchObject({ collapsed: true, activeView: 'b', size: 333 })
      expect(layout.get(2).bars.left).toMatchObject({ collapsed: false, activeView: 'a', size: DEFAULT_BAR_SIZE.left })
    })

    it('shares presence between windows', () => {
      const { layout, contribute } = setup()
      layout.attach(1)
      layout.attach(2)

      contribute('a', 'shell.top')

      expect(layout.get(1).bars.top.views).toEqual(['a'])
      expect(layout.get(2).bars.top.views).toEqual(['a'])
    })

    it('rejects a window that is not attached, or that has been detached', () => {
      const { layout } = setup()
      layout.attach(1)

      expect(() => layout.get(9)).toThrow('Unknown window: 9')
      expect(() => layout.setSlot(9, { slot: 'shell.left', collapsed: true })).toThrow('Unknown window: 9')

      layout.detach(1)
      expect(layout.isAttached(1)).toBe(false)
      expect(() => layout.get(1)).toThrow('Unknown window: 1')
    })

    it('starts a window that reuses a detached id from the defaults', () => {
      const { layout } = setup()
      layout.attach(1)
      layout.setSlot(1, { slot: 'shell.left', size: 400 })
      layout.detach(1)

      expect(layout.attach(1).bars.left.size).toBe(DEFAULT_BAR_SIZE.left)
    })
  })

  describe('change notification', () => {
    it('announces a window\'s first state, then each change with the window id', () => {
      const { layout, contribute, changes } = setup()

      layout.attach(1)
      expect(changes.map(c => c.windowId)).toEqual([1])

      contribute('a', 'shell.left')
      layout.setSlot(1, { slot: 'shell.left', collapsed: true })

      expect(changes).toHaveLength(3)
      expect(changes[1].bars.left.views).toEqual(['a'])
      expect(changes[2].bars.left.collapsed).toBe(true)
      expect(changes[2]).toEqual(layout.get(1))
    })

    it('only announces to the window whose state changed', () => {
      const { layout, changes } = setup()
      layout.attach(1)
      layout.attach(2)
      changes.length = 0

      layout.setSlot(2, { slot: 'shell.top', collapsed: true })

      expect(changes.map(c => c.windowId)).toEqual([2])
    })

    it('stays silent when nothing differs', () => {
      const { layout, contribute, extensions, changes } = setup()
      contribute('a', 'shell.left')
      layout.attach(1)
      changes.length = 0

      layout.setSlot(1, { slot: 'shell.left', collapsed: false })     // already expanded
      layout.setSlot(1, { slot: 'shell.left', activeView: 'a' })      // already active
      layout.refresh()
      extensions.contribute('p', 'shell.menus', 'm', {})               // another extension point
      contribute('elsewhere', 'shell.left', { module: 'bad' })         // invalid, so still not present

      expect(changes).toEqual([])
    })

    it('does not announce a change to a window that has been detached', () => {
      const { layout, contribute, changes } = setup()
      layout.attach(1)
      layout.detach(1)
      changes.length = 0

      contribute('a', 'shell.left')

      expect(changes).toEqual([])
    })

    it('stops listening to contributions once disposed', () => {
      const { layout, contribute, changes } = setup()
      layout.attach(1)
      changes.length = 0

      layout.dispose()
      contribute('a', 'shell.left')

      expect(changes).toEqual([])
    })

    it('lets a listener that reads the state see the new one', () => {
      const { layout, contribute } = setup()
      layout.attach(1)
      const seen = vi.fn((state: LayoutState) => layout.get(state.windowId).bars.left.views)
      layout.onDidChange(seen)

      contribute('a', 'shell.left')

      expect(seen).toHaveReturnedWith(['a'])
    })
  })
})
