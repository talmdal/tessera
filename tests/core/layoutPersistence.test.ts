import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutPersistence } from '@tessera/types'
import { sanitizePrefs } from '../../core/layout/LayoutService'
import { DEFAULT_BAR_SIZE, MIN_BAR_SIZE } from '../../shared/layout/types'
import { createLogger } from '../helpers/runtime'
import { memoryPersistence, setupLayout } from '../helpers/layout'

const DELAY = 500
const entries = { p: 'tessera-plugin://p/remoteEntry.js' }

function setup(initial = {}) {
  const { store, persistence } = memoryPersistence(initial)
  const log = createLogger()
  const utils = setupLayout(entries, { persistence, log, saveDelayMs: DELAY })
  return { ...utils, store, persistence, log }
}

describe('LayoutService: persistence', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  describe('loading', () => {
    it('starts a window from what was saved under its key', async () => {
      const { layout, contribute } = setup({ main: { main: { activeView: 'register' }, bars: { left: { collapsed: true, size: 333, activeView: 'b' } } } })
      contribute('a', 'shell.left')
      contribute('b', 'shell.left')
      contribute('home', 'shell.main')
      contribute('register', 'shell.main')

      const state = await layout.attachPersisted(1, 'main', 'main')

      expect(state.bars.left).toMatchObject({ collapsed: true, size: 333, activeView: 'b' })
      expect(state.main.activeView).toBe('register')
    })

    it('starts from the defaults when nothing was saved', async () => {
      const { layout } = setup()

      const state = await layout.attachPersisted(1, 'main', 'main')

      expect(state.bars.left).toMatchObject({ collapsed: false, size: DEFAULT_BAR_SIZE.left })
    })

    it('starts a new window from the primary window\'s current preferences, not from what it saved', async () => {
      const { layout, persistence } = setup({ main: { bars: { left: { size: 111 } } } })
      await layout.attachPersisted(1, 'main', 'main')
      layout.setSlot(1, { slot: 'shell.left', size: 222, collapsed: true })   // not saved yet

      const second = await layout.attachPersisted(2, 'window-2', 'main')

      expect(second.bars.left).toMatchObject({ size: 222, collapsed: true })
      expect(persistence.load).toHaveBeenCalledWith('window-2')
    })

    it('starts a new window from the primary window\'s saved layout when it is not open', async () => {
      const { layout } = setup({ main: { bars: { right: { size: 444 } } } })

      const state = await layout.attachPersisted(2, 'window-2', 'main')

      expect(state.bars.right.size).toBe(444)
    })

    it('prefers a window\'s own saved layout over the primary window\'s', async () => {
      const { layout } = setup({ main: { bars: { right: { size: 444 } } }, 'window-2': { bars: { right: { size: 150 } } } })
      await layout.attachPersisted(1, 'main', 'main')

      const state = await layout.attachPersisted(2, 'window-2', 'main')

      expect(state.bars.right.size).toBe(150)
    })

    it('falls back to the defaults, and says so, when loading fails', async () => {
      const { layout, persistence, log } = setup()
      vi.mocked(persistence.load).mockRejectedValueOnce(new Error('disk'))

      const state = await layout.attachPersisted(1, 'main', 'main')

      expect(state.bars.left.size).toBe(DEFAULT_BAR_SIZE.left)
      expect(log.warn).toHaveBeenCalledWith('[layout] Could not load the layout saved as "main"; using the defaults: disk')
    })

    it('uses what is valid in damaged data and the defaults for the rest', async () => {
      const { layout } = setup({ main: { main: { activeView: 7 }, bars: { left: { collapsed: 'yes', size: 'big', activeView: 9 }, right: { collapsed: true, size: 20 }, top: 'x' } } as any })

      const state = await layout.attachPersisted(1, 'main', 'main')

      expect(state.bars.left).toMatchObject({ collapsed: false, size: DEFAULT_BAR_SIZE.left })
      expect(state.bars.right).toMatchObject({ collapsed: true, size: MIN_BAR_SIZE })
      expect(state.bars.top.size).toBe(DEFAULT_BAR_SIZE.top)
      expect(state.main.activeView).toBeUndefined()
    })

    it('rejects a key that another window already uses', async () => {
      const { layout } = setup()
      await layout.attachPersisted(1, 'main', 'main')

      await expect(layout.attachPersisted(2, 'main', 'main')).rejects.toThrow('Layout key "main" is already in use')
    })

    it('finds a window by its key', async () => {
      const { layout } = setup()
      await layout.attachPersisted(5, 'main', 'main')
      layout.attach(6)

      expect(layout.windowIdOf('main')).toBe(5)
      expect(layout.windowIdOf('other')).toBeUndefined()
      expect(layout.windowIds()).toEqual([5, 6])
    })
  })

  describe('saving', () => {
    it('writes a change after the delay, as one write however many changes came', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')

      layout.setSlot(1, { slot: 'shell.left', size: 300 })
      layout.setSlot(1, { slot: 'shell.left', size: 310 })
      layout.setSlot(1, { slot: 'shell.left', size: 320 })
      expect(persistence.save).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(DELAY)

      expect(persistence.save).toHaveBeenCalledTimes(1)
      expect(persistence.saves[0][0]).toBe('main')
      expect(persistence.saves[0][1].bars?.left).toMatchObject({ size: 320, collapsed: false })
    })

    it('saves preferences only, never which views are present', async () => {
      const { layout, contribute, persistence } = setup()
      contribute('a', 'shell.left')
      await layout.attachPersisted(1, 'main', 'main')

      layout.setSlot(1, { slot: 'shell.left', collapsed: true })
      await layout.flush()

      expect(JSON.stringify(persistence.saves[0][1])).not.toContain('views')
      expect(persistence.saves[0][1].bars?.left).toEqual({ collapsed: true, size: DEFAULT_BAR_SIZE.left })   // the first view is derived, not a choice
    })

    it('does not write when a gesture changes nothing, or after presence alone changed', async () => {
      const { layout, contribute, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')

      layout.setSlot(1, { slot: 'shell.left', collapsed: false })
      contribute('a', 'shell.left')
      await vi.advanceTimersByTimeAsync(DELAY * 2)
      await layout.flush()

      expect(persistence.save).not.toHaveBeenCalled()
    })

    it('does not write again for a change that was undone before it was written', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')

      layout.setSlot(1, { slot: 'shell.left', collapsed: true })
      layout.setSlot(1, { slot: 'shell.left', collapsed: false })
      await vi.advanceTimersByTimeAsync(DELAY)

      expect(persistence.save).not.toHaveBeenCalled()
    })

    it('does not save a window that has no key', async () => {
      const { layout, persistence } = setup()
      layout.attach(1)

      layout.setSlot(1, { slot: 'shell.left', collapsed: true })
      await vi.advanceTimersByTimeAsync(DELAY)
      await layout.flush()

      expect(persistence.save).not.toHaveBeenCalled()
    })

    it('saves each window under its own key', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      await layout.attachPersisted(2, 'window-2', 'main')

      layout.setSlot(1, { slot: 'shell.top', size: 150 })
      layout.setSlot(2, { slot: 'shell.top', size: 250 })
      await layout.flush()

      expect(Object.fromEntries(persistence.saves.map(([key, saved]) => [key, saved.bars?.top?.size]))).toEqual({ main: 150, 'window-2': 250 })
    })

    it('writes pending changes at once on flush, and not again afterwards', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      layout.setSlot(1, { slot: 'shell.left', size: 280 })

      await layout.flush()
      expect(persistence.save).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(DELAY * 2)
      expect(persistence.save).toHaveBeenCalledTimes(1)
    })

    it('writes pending changes when the window is detached, and forgets the window', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      layout.setSlot(1, { slot: 'shell.left', collapsed: true })

      await layout.detach(1)

      expect(persistence.saves.map(([key]) => key)).toEqual(['main'])
      expect(layout.isAttached(1)).toBe(false)
      await vi.advanceTimersByTimeAsync(DELAY * 2)
      expect(persistence.save).toHaveBeenCalledTimes(1)
    })

    it('restores what a closed window saved when the key is attached again', async () => {
      const { layout } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      layout.setSlot(1, { slot: 'shell.left', size: 345 })
      await layout.detach(1)

      const state = await layout.attachPersisted(2, 'main', 'main')

      expect(state.bars.left.size).toBe(345)
    })

    it('says so and keeps working when a write fails, then tries again on the next change', async () => {
      const { layout, persistence, log } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      vi.mocked(persistence.save).mockRejectedValueOnce(new Error('disk full'))

      layout.setSlot(1, { slot: 'shell.left', size: 300 })
      await layout.flush()
      expect(log.warn).toHaveBeenCalledWith('[layout] Could not save the layout of "main": disk full')
      expect(layout.get(1).bars.left.size).toBe(300)

      layout.setSlot(1, { slot: 'shell.left', size: 301 })
      await layout.flush()
      expect(persistence.saves).toHaveLength(1)
      expect(persistence.saves[0][1].bars?.left?.size).toBe(301)
    })

    it('never overlaps two writes', async () => {
      let running = 0
      let overlapped = false
      const persistence: LayoutPersistence = {
        load: async () => undefined,
        save: async () => {
          if (++running > 1) overlapped = true
          await Promise.resolve()
          running--
        }
      }
      const { layout } = setupLayout(entries, { persistence, saveDelayMs: DELAY })
      await layout.attachPersisted(1, 'main', 'main')
      await layout.attachPersisted(2, 'window-2', 'main')
      layout.setSlot(1, { slot: 'shell.left', size: 200 })
      layout.setSlot(2, { slot: 'shell.left', size: 210 })

      await layout.flush()

      expect(overlapped).toBe(false)
    })

    it('does not write after being disposed', async () => {
      const { layout, persistence } = setup()
      await layout.attachPersisted(1, 'main', 'main')
      layout.setSlot(1, { slot: 'shell.left', size: 300 })

      layout.dispose()
      await vi.advanceTimersByTimeAsync(DELAY * 2)

      expect(persistence.save).not.toHaveBeenCalled()
    })
  })

  it('works without a persistence port', async () => {
    const { layout } = setupLayout(entries)

    await layout.attachPersisted(1, 'main', 'main')
    layout.setSlot(1, { slot: 'shell.left', size: 300 })
    await layout.flush()
    await layout.detach(1)
  })
})

describe('sanitizePrefs', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 5, 'x', []]) {
      expect(sanitizePrefs(raw).bars.left).toEqual({ collapsed: false, size: DEFAULT_BAR_SIZE.left })
    }
  })

  it('rounds sizes and raises them to the minimum', () => {
    const prefs = sanitizePrefs({ bars: { left: { size: 250.4 }, right: { size: 1 } } })

    expect([prefs.bars.left.size, prefs.bars.right.size]).toEqual([250, MIN_BAR_SIZE])
  })
})
