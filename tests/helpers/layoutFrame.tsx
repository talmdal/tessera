import { vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { BorderItemDescriptor, Border, LayoutState } from '@tessera/types'
import { BAR_ITEMS_LIST_CHANNEL, EMPTY_LAYOUT, LAYOUT_CHANGED, LAYOUT_GET, LAYOUT_SLOT_SET } from '../../shared/layout/types'
import { COMMANDS_EXECUTE, CONTEXT_KEYS_SNAPSHOT } from '../../shared/shellEvents'
import { BarItemsProvider, createIpcBarItemSource } from '../../shell/renderer/layout/BarItemsProvider'
import type { ViewDescriptor } from '../../shared/views/types'
import App from '../../shell/renderer/App'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

export const view = (id: string, slot: string, extra: Partial<ViewDescriptor> = {}): ViewDescriptor =>
  ({ id, title: `Title ${id}`, slot, module: './V', pluginId: 'p', remoteEntry: 'x', ...extra })

/** A layout for window 1; `bars` replaces whole bars, so a test names only the ones it cares about. */
export function layoutOf(changes: { windowId?: number, main?: Partial<LayoutState['main']>, bars?: Partial<Record<Border, Partial<LayoutState['bars'][Border]>>> } = {}): LayoutState {
  const bars = { ...EMPTY_LAYOUT.bars }
  for (const side of Object.keys(changes.bars ?? {}) as Border[]) bars[side] = { ...bars[side], ...changes.bars![side] }
  return { windowId: changes.windowId ?? 1, main: { ...EMPTY_LAYOUT.main, ...changes.main }, bars }
}

/** A bridge that answers the layout snapshot at once, records gestures, and lets the test push events. */
export function fakeBridge(snapshot: LayoutState, items: BorderItemDescriptor[] = [], keys: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const sent: unknown[] = []
  const ran: unknown[] = []
  const bridge = {
    sent,
    ran,
    items,
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      if (channel === LAYOUT_GET) return snapshot
      if (channel === LAYOUT_SLOT_SET) { sent.push(data); return snapshot }
      if (channel === BAR_ITEMS_LIST_CHANNEL) return bridge.items
      if (channel === CONTEXT_KEYS_SNAPSHOT) return keys
      if (channel === COMMANDS_EXECUTE) { ran.push(data); return undefined }
      return undefined
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }),
    emit: (name: string, data?: unknown) => act(() => { listeners.get(name)?.forEach(l => l(data)) })
  }
  return bridge
}

/** Everything the frame needs around it, fed by the fake bridge. */
export function Frame({ bridge, views, load }: { bridge: ReturnType<typeof fakeBridge>, views: ViewDescriptor[], load: (v: ViewDescriptor) => Promise<ComponentType> }) {
  return (
    <ShellStateProvider bridge={bridge as any}>
      <ViewsProvider source={{ listViews: async () => views }} loader={{ load }}>
        <BarItemsProvider source={createIpcBarItemSource(bridge as any)}>
          <App />
        </BarItemsProvider>
      </ViewsProvider>
    </ShellStateProvider>
  )
}

export async function renderFrame(
  snapshot: LayoutState,
  views: ViewDescriptor[],
  components: Record<string, ComponentType> = {},
  extras: { items?: BorderItemDescriptor[], keys?: Record<string, unknown> } = {}
) {
  const bridge = fakeBridge(snapshot, extras.items, extras.keys)
  const load = vi.fn(async (v: ViewDescriptor) => components[v.id] ?? (() => <p>Content of {v.id}</p>))
  const utils = render(<Frame bridge={bridge} views={views} load={load} />)
  await act(async () => {})
  return { ...utils, bridge, load, loaded: () => load.mock.calls.map(([v]) => v.id) }
}

