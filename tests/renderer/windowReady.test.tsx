import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LAYOUT, LAYOUT_CHANGED, LAYOUT_GET } from '../../shared/layout/types'
import { CONTEXT_KEYS_SNAPSHOT, LIFECYCLE_GET, WINDOW_READY } from '../../shared/shellEvents'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { WindowReady } from '../../shell/renderer/WindowReady'
import { createFakeRemote } from '../helpers/fakeBridge'

const layout = (windowId: number) => ({ ...EMPTY_LAYOUT, windowId })

function setup() {
  const remote = createFakeRemote({
    [LAYOUT_GET]: 'deferred',
    [LIFECYCLE_GET]: () => 'started',
    [CONTEXT_KEYS_SNAPSHOT]: () => ({}),
    [WINDOW_READY]: () => undefined
  })
  const ready = () => remote.bridge.invoke.mock.calls.filter((call: unknown[]) => call[0] === WINDOW_READY).length
  const view = render(
    <ShellStateProvider bridge={remote.bridge}>
      <WindowReady bridge={remote.bridge} />
    </ShellStateProvider>
  )
  return { ...remote, ready, view }
}

/** Lets the two animation frames the component waits for pass. */
const paint = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })

describe('WindowReady', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('says nothing while the layout has not arrived', async () => {
    const { ready } = setup()

    await paint()

    expect(ready()).toBe(0)
  })

  it('says the window is ready once the layout has arrived and a frame has been painted', async () => {
    const { resolve, ready } = setup()

    await act(async () => { resolve(LAYOUT_GET, layout(7)) })
    // Not in the same tick: the DOM is updated but not yet painted
    expect(ready()).toBe(0)

    await waitFor(() => expect(ready()).toBe(1))
  })

  it('says it only once, however the layout changes afterwards', async () => {
    const { resolve, emit, ready } = setup()
    await act(async () => { resolve(LAYOUT_GET, layout(7)) })
    await waitFor(() => expect(ready()).toBe(1))

    act(() => emit(LAYOUT_CHANGED, layout(7)))
    act(() => emit(LAYOUT_CHANGED, { ...layout(7), main: { views: ['a'], items: [], activeView: 'a' } }))
    await paint()

    expect(ready()).toBe(1)
  })

  it('does not say it if the window goes away before the frame is painted', async () => {
    const { resolve, ready, view } = setup()

    await act(async () => { resolve(LAYOUT_GET, layout(7)) })
    view.unmount()
    await paint()

    expect(ready()).toBe(0)
  })

  it('logs, and does not throw, when the request fails', async () => {
    const remote = createFakeRemote({
      [LAYOUT_GET]: () => layout(7),
      [LIFECYCLE_GET]: () => 'started',
      [CONTEXT_KEYS_SNAPSHOT]: () => ({})
      // no answer for WINDOW_READY: the fake rejects
    })

    render(<ShellStateProvider bridge={remote.bridge}><WindowReady bridge={remote.bridge} /></ShellStateProvider>)

    await waitFor(() => expect(console.error).toHaveBeenCalledWith('[window] Could not report ready', expect.any(Error)))
  })
})
