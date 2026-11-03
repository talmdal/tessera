import { vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { BorderItemDescriptor, Border, LayoutState, ThemeDescriptor, ThemeSelection, ThemeSet } from '@tessera/types'
import { BAR_ITEMS_LIST_CHANNEL, EMPTY_LAYOUT, LAYOUT_CHANGED, LAYOUT_GET, LAYOUT_SLOT_SET } from '../../shared/layout/types'
import { COMMANDS_EXECUTE, CONTEXT_KEYS_SNAPSHOT } from '../../shared/shellEvents'
import { SHELL_THEME, THEME_GET, THEME_SET, THEMES_LIST } from '../../shared/themes/types'
import { BarItemsProvider, createIpcBarItemSource } from '../../shell/renderer/layout/BarItemsProvider'
import type { ViewDescriptor } from '../../shared/views/types'
import App from '../../shell/renderer/App'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

export const view = (id: string, slot: string, extra: Partial<ViewDescriptor> = {}): ViewDescriptor =>
  ({ id, title: `Title ${id}`, slot, module: './V', pluginId: 'p', remoteEntry: 'x', ...extra })

/** A layout for window 1; `bars` replaces whole bars, so a test names only the ones it cares about. */
export function layoutOf(changes: { windowId?: number, main?: Partial<LayoutState['main']>, bars?: Partial<Record<Border, Partial<LayoutState['bars'][Border]>>> } = {}): LayoutState {
  const bars = { ...EMPTY_LAYOUT.bars }
  for (const side of Object.keys(changes.bars ?? {}) as Border[]) bars[side] = { ...bars[side], ...changes.bars![side] }
  return { windowId: changes.windowId ?? 1, main: { ...EMPTY_LAYOUT.main, ...changes.main }, bars }
}

export const SHELL_THEME_DESCRIPTOR: ThemeDescriptor = { ...SHELL_THEME, pluginId: 'shell', schemes: ['light', 'dark'] }
export const DEFAULT_SELECTION: ThemeSelection = { themeId: 'shell.default', mode: 'light', resolvedMode: 'light', effectiveThemeId: 'shell.default' }

/**
 * A bridge that answers the layout and theme snapshots at once, records gestures, and lets the test push
 * events. A theme request is recorded in `themed` and answered with the selection it implies.
 */
export function fakeBridge(snapshot: LayoutState, items: BorderItemDescriptor[] = [], keys: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const sent: unknown[] = []
  const ran: unknown[] = []
  const themed: ThemeSet[] = []
  const bridge = {
    sent,
    ran,
    themed,
    items,
    themes: [SHELL_THEME_DESCRIPTOR] as ThemeDescriptor[],
    selection: DEFAULT_SELECTION,
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      if (channel === LAYOUT_GET) return snapshot
      if (channel === LAYOUT_SLOT_SET) { sent.push(data); return snapshot }
      if (channel === BAR_ITEMS_LIST_CHANNEL) return bridge.items
      if (channel === CONTEXT_KEYS_SNAPSHOT) return keys
      if (channel === COMMANDS_EXECUTE) { ran.push(data); return undefined }
      if (channel === THEMES_LIST) return bridge.themes
      if (channel === THEME_GET) return bridge.selection
      if (channel === THEME_SET) {
        const request = data as ThemeSet
        themed.push(request)
        const mode = request.mode ?? bridge.selection.mode
        const themeId = request.themeId ?? bridge.selection.themeId
        return { themeId, mode, resolvedMode: mode === 'system' ? 'light' : mode, effectiveThemeId: themeId } satisfies ThemeSelection
      }
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
    <ShellThemeProvider bridge={bridge as any}>
      <ShellStateProvider bridge={bridge as any}>
        <ViewsProvider source={{ listViews: async () => views }} loader={{ load }}>
          <BarItemsProvider source={createIpcBarItemSource(bridge as any)}>
            <App />
          </BarItemsProvider>
        </ViewsProvider>
      </ShellStateProvider>
    </ShellThemeProvider>
  )
}

export async function renderFrame(
  snapshot: LayoutState,
  views: ViewDescriptor[],
  components: Record<string, ComponentType> = {},
  extras: { items?: BorderItemDescriptor[], keys?: Record<string, unknown> } = {},
  bridge = fakeBridge(snapshot, extras.items, extras.keys)
) {
  const load = vi.fn(async (v: ViewDescriptor) => components[v.id] ?? (() => <p>Content of {v.id}</p>))
  const utils = render(<Frame bridge={bridge} views={views} load={load} />)
  await act(async () => {})
  return { ...utils, bridge, load, loaded: () => load.mock.calls.map(([v]) => v.id) }
}

