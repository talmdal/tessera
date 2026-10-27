import type { BarItemDescriptor, BarSide, LayoutState, ViewDescriptor } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { ComponentType, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  COMMANDS_EXECUTE,
  LAYOUT_CHANGED,
  LAYOUT_GET,
  LAYOUT_SLOT_SET,
  emptyLayout
} from '../../shared/layout/types'
import { builtinThemeState } from '../../shared/theme/builtin'
import { WindowManager } from '../../shell/renderer/layout/WindowManager'
import { BarItemsProvider } from '../../shell/renderer/layout/BarItemsProvider'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

const view = (id: string, slot: string, icon = 'save'): ViewDescriptor =>
  ({ id, title: `Title ${id}`, slot, module: './V', pluginId: 'p', remoteEntry: 'x', icon })

function layoutWith(changes: {
  windowId?: number
  main?: Partial<LayoutState['main']>
  bars?: Partial<Record<BarSide, Partial<LayoutState['bars'][BarSide]>>>
}): LayoutState {
  const layout = emptyLayout(changes.windowId ?? 1)
  Object.assign(layout.main, changes.main)
  for (const [side, bar] of Object.entries(changes.bars ?? {})) {
    Object.assign(layout.bars[side as BarSide], bar)
  }
  return layout
}

function setup({ layout, views = [], items = [], keys = {}, components = {} }: {
  layout: LayoutState
  views?: ViewDescriptor[]
  items?: BarItemDescriptor[]
  keys?: Record<string, unknown>
  components?: Record<string, ComponentType>
}) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const requests: { channel: string, data: unknown }[] = []

  const bridge = {
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      requests.push({ channel, data })
      if (channel === 'shell:lifecycle.get') return 'started'
      if (channel === 'shell:contextKeys.snapshot') return keys
      if (channel === LAYOUT_GET) return layout
      if (channel === 'shell:theme.get') return builtinThemeState('light')
      if (channel === LAYOUT_SLOT_SET) return layout
      if (channel === COMMANDS_EXECUTE) return undefined
      throw new Error(`Unexpected request ${channel}`)
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }),
    emit: (name: string, data?: unknown) => listeners.get(name)?.forEach(l => l(data))
  }

  const loader = {
    load: async (v: ViewDescriptor) => components[v.id] ?? (() => <p>Body of {v.id}</p>)
  }

  render(
    <ShellStateProvider bridge={bridge as any}>
      <ViewsProvider source={{ listViews: async () => views }} loader={loader}>
        <BarItemsProvider source={{ listItems: async () => items }}>
          <WindowManager fallback={<p>Welcome home</p>} />
        </BarItemsProvider>
      </ViewsProvider>
    </ShellStateProvider>
  )

  return { bridge, requests, sent: (channel: string) => requests.filter(r => r.channel === channel).map(r => r.data) }
}

describe('WindowManager', () => {
  it('renders only the main fallback when nothing is contributed', async () => {
    setup({ layout: layoutWith({}) })

    expect(await screen.findByText('Welcome home')).toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()  // no <aside>
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()         // no <header>
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()    // no <footer>
  })

  it('shows the active main view instead of the fallback', async () => {
    setup({
      layout: layoutWith({ main: { views: ['m1', 'm2'], activeView: 'm2' } }),
      views: [view('m1', 'shell.main', undefined as any), view('m2', 'shell.main', undefined as any)]
    })

    expect(await screen.findByText('Body of m2')).toBeInTheDocument()
    expect(screen.queryByText('Body of m1')).not.toBeInTheDocument()  // never shown, never loaded
    expect(screen.queryByText('Welcome home')).not.toBeInTheDocument()
  })

  it('renders a bar as tabs: only the active view is visible, switching sends slot.set', async () => {
    const { sent } = setup({
      layout: layoutWith({ bars: { left: { views: ['a', 'b'], activeView: 'a' } } }),
      views: [view('a', 'shell.left'), view('b', 'shell.left')]
    })

    expect(await screen.findByText('Body of a')).toBeVisible()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Title a', 'Title b'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(tabs[1])
    expect(sent(LAYOUT_SLOT_SET)).toEqual([{ slot: 'shell.left', activeView: 'b' }])
  })

  it('keeps a previously shown tab mounted but hidden when the active tab changes', async () => {
    const { bridge } = setup({
      layout: layoutWith({ bars: { right: { views: ['a', 'b'], activeView: 'a' } } }),
      views: [view('a', 'shell.right'), view('b', 'shell.right')]
    })
    await screen.findByText('Body of a')

    bridge.emit(LAYOUT_CHANGED, layoutWith({ bars: { right: { views: ['a', 'b'], activeView: 'b' } } }))

    expect(await screen.findByText('Body of b')).toBeVisible()
    expect(screen.getByText('Body of a')).not.toBeVisible()
  })

  it('keeps a shown view mounted, with its state, across a collapse and expand', async () => {
    const Counter = () => {
      const [n, setN] = useState(0)
      return <button onClick={() => setN(n + 1)}>count {n}</button>
    }
    const expanded = layoutWith({ bars: { left: { views: ['a'], activeView: 'a' } } })
    const { bridge } = setup({
      layout: expanded,
      views: [view('a', 'shell.left')],
      components: { a: Counter }
    })

    await userEvent.click(await screen.findByRole('button', { name: 'count 0' }))
    expect(screen.getByText('count 1')).toBeVisible()

    act(() => bridge.emit(LAYOUT_CHANGED, layoutWith({ bars: { left: { views: ['a'], activeView: 'a', collapsed: true } } })))
    expect(screen.getByText('count 1')).not.toBeVisible()

    act(() => bridge.emit(LAYOUT_CHANGED, expanded))
    expect(await screen.findByText('count 1')).toBeVisible()
  })

  it('does not render a view while its bar starts out collapsed', async () => {
    setup({
      layout: layoutWith({ bars: { left: { views: ['a'], activeView: 'a', collapsed: true } } }),
      views: [view('a', 'shell.left')]
    })

    await screen.findByRole('button', { name: 'Title a' })
    expect(screen.queryByText('Body of a')).not.toBeInTheDocument()
  })

  it('ignores layout events for other windows', async () => {
    setup({
      layout: layoutWith({ windowId: 1, bars: { left: { views: ['a'], activeView: 'a' } } }),
      views: [view('a', 'shell.left')]
    }).bridge.emit(LAYOUT_CHANGED, layoutWith({ windowId: 2 }))

    expect(await screen.findByText('Body of a')).toBeVisible()
  })

  it('renders a collapsed bar as a rail of view icons that expand it', async () => {
    const { sent } = setup({
      layout: layoutWith({ bars: { left: { views: ['a', 'b'], activeView: 'a', collapsed: true } } }),
      views: [view('a', 'shell.left'), view('b', 'shell.left')]
    })

    const railButton = await screen.findByRole('button', { name: 'Title b' })
    expect(screen.queryByText('Body of a')).not.toBeInTheDocument()

    await userEvent.click(railButton)
    expect(sent(LAYOUT_SLOT_SET)).toEqual([{ slot: 'shell.left', collapsed: false, activeView: 'b' }])
  })

  it('collapses a bar from its tab strip', async () => {
    const { sent } = setup({
      layout: layoutWith({ bars: { bottom: { views: ['a'], activeView: 'a' } } }),
      views: [view('a', 'shell.bottom')]
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Hide bottom bar' }))
    expect(sent(LAYOUT_SLOT_SET)).toEqual([{ slot: 'shell.bottom', collapsed: true }])
  })

  it('renders bar items: buttons follow their enabled flag and run their command', async () => {
    const { sent } = setup({
      layout: layoutWith({ bars: { top: { items: ['i.save', 'i.locked'] } } }),
      items: [
        { kind: 'button', id: 'i.save', slot: 'shell.top', label: 'Save', command: 'vault.save', pluginId: 'v', enabled: true },
        { kind: 'button', id: 'i.locked', slot: 'shell.top', label: 'Locked', command: 'vault.locked', pluginId: 'v', enabled: false }
      ]
    })

    const save = await screen.findByRole('button', { name: 'Save' })
    expect(screen.getByRole('button', { name: 'Locked' })).toBeDisabled()

    await userEvent.click(save)
    expect(sent(COMMANDS_EXECUTE)).toEqual([{ id: 'vault.save' }])
  })

  it('interpolates context keys into text items', async () => {
    setup({
      layout: layoutWith({ bars: { bottom: { items: ['i.name'] } } }),
      items: [{ kind: 'text', id: 'i.name', slot: 'shell.bottom', text: 'Vault: {vault.name}', pluginId: 'v', enabled: true }],
      keys: { 'vault.name': 'Home' }
    })

    expect(await screen.findByText('Vault: Home')).toBeInTheDocument()
  })

  it('keeps a bar with only items content-sized, without tabs or splitter', async () => {
    setup({
      layout: layoutWith({ bars: { bottom: { items: ['i.name'] } } }),
      items: [{ kind: 'text', id: 'i.name', slot: 'shell.bottom', text: 'hi', pluginId: 'v', enabled: true }]
    })

    expect(await screen.findByText('hi')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('has a splitter that resizes with the keyboard', async () => {
    const { sent } = setup({
      layout: layoutWith({ bars: { left: { views: ['a'], activeView: 'a', size: 260 } } }),
      views: [view('a', 'shell.left')]
    })

    const splitter = await screen.findByRole('separator', { name: 'Resize left bar' })
    splitter.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(sent(LAYOUT_SLOT_SET)).toEqual([{ slot: 'shell.left', size: 270 }])
  })
})
