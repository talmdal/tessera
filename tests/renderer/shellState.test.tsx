import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { createRemoteState } from '../../shell/renderer/state/remoteState'
import { ShellStateProvider, useAppPhase, useContextKey } from '../../shell/renderer/state/ShellState'
import { Slot, ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

/** A bridge whose requests resolve on demand and whose events are fired by the test. */
function fakeBridge(responses: Record<string, unknown>) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const pending = new Map<string, (value: unknown) => void>()
  return {
    invoke: vi.fn((channel: string) => new Promise(resolve => { pending.set(channel, resolve) })),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }),
    emit: (name: string, data?: unknown) => listeners.get(name)?.forEach(l => l(data)),
    reply: (channel: string) => pending.get(channel)!(responses[channel])
  } as any
}

const counter = { initial: 0, load: 'x:get', event: 'x:changed', apply: (state: number, change: number) => state + change }

describe('createRemoteState', () => {
  it('loads the current value, then applies events', async () => {
    const bridge = fakeBridge({ 'x:get': 10 })
    const state = createRemoteState<number, number>(bridge, counter)
    const listener = vi.fn()
    state.subscribe(listener)
    expect(state.getSnapshot()).toBe(0)

    await act(async () => { bridge.reply('x:get') })
    expect(state.getSnapshot()).toBe(10)

    bridge.emit('x:changed', 5)
    expect(state.getSnapshot()).toBe(15)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('applies events that arrived while the request was in flight on top of its result', async () => {
    const bridge = fakeBridge({ 'x:get': 10 })
    const state = createRemoteState<number, number>(bridge, counter)

    bridge.emit('x:changed', 1)
    bridge.emit('x:changed', 2)
    expect(state.getSnapshot()).toBe(0)

    await act(async () => { bridge.reply('x:get') })
    expect(state.getSnapshot()).toBe(13)
  })

  it('keeps following events when the request fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = fakeBridge({})
    bridge.invoke.mockRejectedValueOnce(new Error('ipc down'))
    const state = createRemoteState<number, number>(bridge, counter)

    await act(async () => {})
    bridge.emit('x:changed', 4)

    expect(state.getSnapshot()).toBe(4)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('stops notifying an unsubscribed listener', async () => {
    const bridge = fakeBridge({ 'x:get': 1 })
    const state = createRemoteState<number, number>(bridge, counter)
    const listener = vi.fn()
    state.subscribe(listener)()

    await act(async () => { bridge.reply('x:get') })

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('shell state hooks', () => {
  function Probe() {
    return <p>{useAppPhase()} / {String(useContextKey('vault.isOpen'))}</p>
  }

  it('show the phase and a context key, and follow their change events', async () => {
    const bridge = fakeBridge({ 'shell:lifecycle.get': 'started', 'shell:contextKeys.snapshot': { 'vault.isOpen': false } })
    render(<ShellStateProvider bridge={bridge}><Probe /></ShellStateProvider>)
    expect(screen.getByText('starting / undefined')).toBeInTheDocument()

    await act(async () => { bridge.reply('shell:lifecycle.get'); bridge.reply('shell:contextKeys.snapshot') })
    expect(screen.getByText('started / false')).toBeInTheDocument()

    act(() => {
      bridge.emit('shell:lifecycle.changed', { phase: 'shuttingDown' })
      bridge.emit('shell:contextKeys.changed', { 'vault.isOpen': true })
    })
    expect(screen.getByText('shuttingDown / true')).toBeInTheDocument()

    act(() => { bridge.emit('shell:contextKeys.changed', { 'vault.isOpen': null }) })
    expect(screen.getByText('shuttingDown / undefined')).toBeInTheDocument()
  })

  it('require the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('inside <ShellStateProvider>')
    vi.mocked(console.error).mockRestore()
  })
})

describe('views that change at runtime', () => {
  const view = (id: string): ViewDescriptor => ({ id, title: `Title ${id}`, slot: 'shell.main', module: './V', pluginId: 'p', remoteEntry: 'x' })

  it('reloads the view list when the source reports a change, and ignores a slow earlier reply', async () => {
    const replies: ((views: ViewDescriptor[]) => void)[] = []
    let notify!: () => void
    const source = {
      listViews: () => new Promise<ViewDescriptor[]>(resolve => { replies.push(resolve) }),
      onDidChange: (listener: () => void) => { notify = listener; return () => {} }
    }
    const loader = { load: async () => () => <p>loaded</p> }

    render(
      <ViewsProvider source={source} loader={loader}>
        <Slot id="shell.main" fallback={<p>empty</p>} />
      </ViewsProvider>
    )

    await act(async () => { replies[0]([]) })
    expect(screen.getByText('empty')).toBeInTheDocument()

    act(() => { notify(); notify() })                          // two quick changes: two requests
    await act(async () => { replies[2]([view('new')]) })        // the newer reply arrives first
    await act(async () => { replies[1]([view('stale')]) })      // the older one arrives late and is ignored

    expect(await screen.findByLabelText('Title new')).toBeInTheDocument()
    expect(screen.queryByLabelText('Title stale')).not.toBeInTheDocument()
  })
})
