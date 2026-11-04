import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { WINDOW_READY } from '../../shared/shellEvents'
import { RevealableWindow, createWindowReveal, registerWindowReady } from '../../shell/main/window/windowReveal'
import { createLogger } from '../helpers/runtime'

/** A window that fires its events when the test says so. */
function fakeWindow(id = 1) {
  const handlers = new Map<string, () => void>()
  let destroyed = false
  const window: RevealableWindow & { fire(event: string): void, destroy(): void, show: Mock<() => void> } = {
    id,
    isDestroyed: () => destroyed,
    show: vi.fn(),
    once: (event, listener) => { handlers.set(event, listener) },
    fire: event => handlers.get(event)?.(),
    destroy() { destroyed = true }
  }
  return window
}

describe('createWindowReveal', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('keeps a window hidden until its page and its renderer are both ready', () => {
    const reveal = createWindowReveal(createLogger())
    const win = fakeWindow()
    reveal.track(win)

    expect(win.show).not.toHaveBeenCalled()
    win.fire('ready-to-show')
    expect(win.show).not.toHaveBeenCalled()
    reveal.rendererReady(1)

    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('does not mind which of the two comes first', () => {
    const reveal = createWindowReveal(createLogger())
    const win = fakeWindow()
    reveal.track(win)

    reveal.rendererReady(1)
    expect(win.show).not.toHaveBeenCalled()
    win.fire('ready-to-show')

    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('shows a window only once, however often it is told', () => {
    const reveal = createWindowReveal(createLogger())
    const win = fakeWindow()
    reveal.track(win)

    win.fire('ready-to-show')
    reveal.rendererReady(1)
    reveal.rendererReady(1)
    win.fire('ready-to-show')
    vi.advanceTimersByTime(60_000)

    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('shows it with the given function instead of window.show, so a maximized window can be maximized', () => {
    const reveal = createWindowReveal(createLogger())
    const win = fakeWindow()
    const show = vi.fn()
    reveal.track(win, { show })

    win.fire('ready-to-show')
    reveal.rendererReady(1)

    expect(show).toHaveBeenCalledTimes(1)
    expect(win.show).not.toHaveBeenCalled()
  })

  it('shows a window whose renderer never reports, after the timeout, and says so', () => {
    const log = createLogger()
    const reveal = createWindowReveal(log, 3_000)
    const win = fakeWindow(4)
    reveal.track(win)
    win.fire('ready-to-show')

    vi.advanceTimersByTime(2_999)
    expect(win.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(win.show).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('[window] Window 4 was not ready after 3000 ms; showing it anyway')
  })

  it('does not warn when the window was ready in time', () => {
    const log = createLogger()
    const reveal = createWindowReveal(log, 3_000)
    const win = fakeWindow()
    reveal.track(win)

    win.fire('ready-to-show')
    reveal.rendererReady(1)
    vi.advanceTimersByTime(10_000)

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('keeps windows apart', () => {
    const reveal = createWindowReveal(createLogger())
    const first = fakeWindow(1)
    const second = fakeWindow(2)
    reveal.track(first)
    reveal.track(second)
    first.fire('ready-to-show')
    second.fire('ready-to-show')

    reveal.rendererReady(2)

    expect(second.show).toHaveBeenCalledTimes(1)
    expect(first.show).not.toHaveBeenCalled()
  })

  it('ignores a window it is not tracking', () => {
    const reveal = createWindowReveal(createLogger())

    expect(() => reveal.rendererReady(99)).not.toThrow()
  })

  it('forgets a window that closes, and never shows it', () => {
    const log = createLogger()
    const reveal = createWindowReveal(log, 3_000)
    const win = fakeWindow()
    reveal.track(win)

    win.fire('closed')
    win.fire('ready-to-show')
    reveal.rendererReady(1)
    vi.advanceTimersByTime(10_000)

    expect(win.show).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('does not show a window that was destroyed in the meantime', () => {
    const reveal = createWindowReveal(createLogger())
    const win = fakeWindow()
    reveal.track(win)
    win.destroy()

    win.fire('ready-to-show')
    reveal.rendererReady(1)

    expect(win.show).not.toHaveBeenCalled()
  })
})

describe('registerWindowReady', () => {
  it('lets a window report ready over IPC, attributed to the sender', async () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    const rendererReady = vi.fn()
    registerWindowReady(shell, { track: vi.fn(), rendererReady })

    const response = await runtime.ipc.dispatch({ channel: WINDOW_READY }, { windowId: 3 })

    expect(response).toMatchObject({ ok: true })
    expect(rendererReady).toHaveBeenCalledWith(3)
  })

  it('refuses a request that is not from a window', async () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    const rendererReady = vi.fn()
    registerWindowReady(shell, { track: vi.fn(), rendererReady })

    const response = await runtime.ipc.dispatch({ channel: WINDOW_READY })

    expect(response).toMatchObject({ ok: false, error: { message: 'Unknown window: undefined' } })
    expect(rendererReady).not.toHaveBeenCalled()
  })
})
