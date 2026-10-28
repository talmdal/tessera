import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@tessera/types'
import {
  MIN_WINDOW_SIZE,
  Rect,
  WindowState,
  createWindowStateGroup,
  createWindowStateStore,
  restoreWindowState,
  trackWindowState,
  windowStateKey
} from '../../shell/main/window/windowState'
import { createLogger } from '../helpers/runtime'

const defaults = { width: 1200, height: 800 }
const screen: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

describe('restoreWindowState', () => {
  it('uses the defaults, and no position, when nothing was saved', () => {
    for (const saved of [undefined, null, 5, 'x', {}]) {
      expect(restoreWindowState(saved, defaults, [screen])).toEqual({ ...defaults, maximized: false })
    }
  })

  it('restores a saved position, size and maximized flag', () => {
    expect(restoreWindowState({ x: 100, y: 50, width: 900, height: 700, maximized: true }, defaults, [screen]))
      .toEqual({ x: 100, y: 50, width: 900, height: 700, maximized: true })
  })

  it('rounds what it restores', () => {
    expect(restoreWindowState({ x: 10.4, y: 20.6, width: 900.5, height: 700.4, maximized: false }, defaults, [screen]))
      .toMatchObject({ x: 10, y: 21, width: 901, height: 700 })
  })

  it('falls back field by field for damaged values', () => {
    const state = restoreWindowState({ x: 'left', y: 10, width: NaN, height: 650, maximized: 'yes' }, defaults, [screen])

    expect(state).toEqual({ width: 1200, height: 650, maximized: false })       // no x, so no position at all
  })

  it('raises a size below the minimum to it', () => {
    expect(restoreWindowState({ width: 10, height: 10 }, defaults, [screen])).toMatchObject(MIN_WINDOW_SIZE)
  })

  it('drops a position that is on no screen, such as an unplugged monitor, and keeps the size', () => {
    const state = restoreWindowState({ x: 2500, y: 100, width: 900, height: 700 }, defaults, [screen])

    expect(state).toEqual({ width: 900, height: 700, maximized: false })
  })

  it('drops a position with only a sliver on a screen', () => {
    expect(restoreWindowState({ x: 1900, y: 100, width: 900, height: 700 }, defaults, [screen])).not.toHaveProperty('x')
    expect(restoreWindowState({ x: 100, y: 1070, width: 900, height: 700 }, defaults, [screen])).not.toHaveProperty('y')
  })

  it('keeps a position that is on any of several screens, including negative coordinates', () => {
    const left: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }

    expect(restoreWindowState({ x: -1500, y: 100, width: 900, height: 700 }, defaults, [screen, left])).toMatchObject({ x: -1500, y: 100 })
  })

  it('keeps a window that is partly off a screen but mostly visible', () => {
    expect(restoreWindowState({ x: 1200, y: 100, width: 900, height: 700 }, defaults, [screen])).toMatchObject({ x: 1200, y: 100 })
  })

  it('drops the position when no screens are known', () => {
    expect(restoreWindowState({ x: 0, y: 0, width: 900, height: 700 }, defaults, [])).not.toHaveProperty('x')
  })
})

/** A window whose bounds and events the test controls. */
function fakeWindow(initial: Rect = { x: 10, y: 20, width: 1000, height: 700 }) {
  const listeners = new Map<string, (() => void)[]>()
  const win = {
    bounds: initial,
    maximized: false,
    destroyed: false,
    getNormalBounds: vi.fn(() => {
      if (win.destroyed) throw new Error('Object has been destroyed')
      return win.bounds
    }),
    isMaximized: () => win.maximized,
    on: vi.fn((event: string, listener: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) }),
    emit: (event: string) => (listeners.get(event) ?? []).forEach(listener => listener())
  }
  return win
}

describe('trackWindowState', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    const win = fakeWindow()
    const saved: WindowState[] = []
    const save = vi.fn(async (state: WindowState) => { saved.push(state) })
    const log = createLogger()
    const tracker = trackWindowState(win, save, { delayMs: 500, log })
    return { win, saved, save, log, tracker }
  }

  it('listens for the events that change a window\'s position and size', () => {
    const { win } = setup()

    expect(win.on.mock.calls.map(([event]) => event).sort()).toEqual(['close', 'closed', 'maximize', 'move', 'resize', 'unmaximize'])
  })

  it('saves nothing until the window changes', async () => {
    const { save } = setup()

    await vi.advanceTimersByTimeAsync(5000)

    expect(save).not.toHaveBeenCalled()
  })

  it.each(['resize', 'move', 'maximize', 'unmaximize'])('saves the current state once a %s has settled', async event => {
    const { win, saved } = setup()
    win.bounds = { x: 30, y: 40, width: 800, height: 600 }

    win.emit(event)
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(500)

    expect(saved).toEqual([{ x: 30, y: 40, width: 800, height: 600, maximized: false }])
  })

  it('saves once for a burst of moves, with where the window ended up', async () => {
    const { win, saved, save } = setup()

    for (let x = 0; x < 50; x++) {
      win.bounds = { ...win.bounds, x }
      win.emit('move')
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(500)

    expect(save).toHaveBeenCalledTimes(1)
    expect(saved[0].x).toBe(49)
  })

  it('records a maximized window with its restored bounds, not the screen-sized ones', async () => {
    const { win, saved } = setup()
    win.maximized = true            // getNormalBounds keeps answering with the bounds it will restore to

    win.emit('maximize')
    await vi.advanceTimersByTimeAsync(500)

    expect(saved).toEqual([{ x: 10, y: 20, width: 1000, height: 700, maximized: true }])
  })

  it('does not write again when nothing differs from the last save', async () => {
    const { win, save } = setup()

    win.emit('resize')
    await vi.advanceTimersByTimeAsync(500)
    win.emit('move')
    await vi.advanceTimersByTimeAsync(500)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('saves at once when the window closes, and not again afterwards', async () => {
    const { win, saved, save } = setup()
    win.bounds = { x: 5, y: 6, width: 700, height: 500 }
    win.emit('resize')

    win.emit('close')
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).toEqual([{ x: 5, y: 6, width: 700, height: 500, maximized: false }])

    win.destroyed = true
    win.emit('closed')
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not ask a destroyed window where it is', async () => {
    const { win, save } = setup()
    win.emit('resize')

    win.destroyed = true
    win.emit('closed')
    await vi.advanceTimersByTimeAsync(2000)

    expect(win.getNormalBounds).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('writes pending changes on flush', async () => {
    const { win, tracker, saved } = setup()
    win.bounds = { x: 1, y: 2, width: 600, height: 400 }
    win.emit('resize')

    await tracker.flush()

    expect(saved).toEqual([{ x: 1, y: 2, width: 600, height: 400, maximized: false }])
  })

  it('says so and tries again on the next change when a write fails', async () => {
    const { win, save, log, saved } = setup()
    save.mockRejectedValueOnce(new Error('disk full'))

    win.emit('resize')
    await vi.advanceTimersByTimeAsync(500)
    expect(log.warn).toHaveBeenCalledWith('[window] Could not save the window position and size: disk full')

    win.emit('resize')
    await vi.advanceTimersByTimeAsync(500)
    expect(saved).toHaveLength(1)
  })

  it('never overlaps two writes', async () => {
    const win = fakeWindow()
    let running = 0
    let overlapped = false
    trackWindowState(win, async () => {
      if (++running > 1) overlapped = true
      await Promise.resolve()
      running--
    }, { delayMs: 10 })

    win.emit('resize')
    await vi.advanceTimersByTimeAsync(10)
    win.bounds = { ...win.bounds, width: 900 }
    win.emit('resize')
    await vi.advanceTimersByTimeAsync(10)

    expect(overlapped).toBe(false)
  })
})

describe('createWindowStateStore', () => {
  const fakeAppState = () => {
    const data = new Map<string, unknown>()
    const appState = {
      get: vi.fn(async (key: string) => data.get(key)),
      set: vi.fn(async (key: string, value: unknown) => { data.set(key, value) })
    } as unknown as AppState
    return { data, appState }
  }

  it('keeps each window under its own app.state key', async () => {
    const { data, appState } = fakeAppState()
    const store = createWindowStateStore(() => appState)

    await store.save('main', { width: 1, height: 2, maximized: false })
    await store.save('window-2', { width: 3, height: 4, maximized: true })

    expect([...data.keys()]).toEqual(['shell.window.main', 'shell.window.window-2'])
    expect(windowStateKey('main')).toBe('shell.window.main')
    await expect(store.load('main')).resolves.toEqual({ width: 1, height: 2, maximized: false })
    await expect(store.load('window-3')).resolves.toBeUndefined()
  })

  it('remembers nothing, without failing, while the app-state service is not there', async () => {
    const { appState } = fakeAppState()
    let available: AppState | undefined
    const store = createWindowStateStore(() => available)

    await expect(store.load('main')).resolves.toBeUndefined()
    await expect(store.save('main', { width: 1, height: 2, maximized: false })).resolves.toBeUndefined()

    available = appState
    await store.save('main', { width: 5, height: 6, maximized: false })
    await expect(store.load('main')).resolves.toMatchObject({ width: 5 })
  })
})

describe('createWindowStateGroup', () => {
  it('saves every tracked window together, so shutdown can do it before the store closes', async () => {
    const group = createWindowStateGroup()
    const a = fakeWindow({ x: 1, y: 1, width: 500, height: 400 })
    const b = fakeWindow({ x: 2, y: 2, width: 600, height: 500 })
    const saved: [string, number][] = []
    group.track(a, async state => { saved.push(['a', state.width]) })
    group.track(b, async state => { saved.push(['b', state.width]) })

    await group.flush()

    expect(saved).toEqual([['a', 500], ['b', 600]])
  })

  it('saves a window that has not changed yet, so a first run records where it opened', async () => {
    const group = createWindowStateGroup()
    const save = vi.fn(async () => {})
    group.track(fakeWindow(), save)

    await group.flush()
    await group.flush()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('waits for writes that are already under way', async () => {
    const group = createWindowStateGroup()
    const win = fakeWindow()
    let finished = false
    group.track(win, async () => { await new Promise(resolve => setTimeout(resolve, 20)); finished = true })
    win.emit('close')                      // a write starts, as when the user closes the window

    await group.flush()

    expect(finished).toBe(true)
  })

  it('forgets a window once it has closed', async () => {
    const group = createWindowStateGroup()
    const win = fakeWindow()
    const save = vi.fn(async () => {})
    group.track(win, save)
    win.emit('closed')

    await group.flush()

    expect(save).not.toHaveBeenCalled()
  })
})
