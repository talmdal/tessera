// shell/renderer/state/ShellState.tsx
import { ReactNode, createContext, useContext, useState, useSyncExternalStore } from 'react'
import type {
  AppPhase,
  BarSide,
  BarState,
  ContextKeyValue,
  LayoutState,
  TesseraBridge,
  ThemeState
} from '@tessera/types'
import { LAYOUT_CHANGED, LAYOUT_GET, emptyLayout } from '../../../shared/layout/types'
import { builtinThemeState } from '../../../shared/theme/builtin'
import { THEME_CHANGED, THEME_GET } from '../../../shared/theme/types'
import {
  CONTEXT_KEYS_CHANGED,
  CONTEXT_KEYS_SNAPSHOT,
  ContextKeySnapshot,
  ContextKeysChanged,
  LIFECYCLE_CHANGED,
  LIFECYCLE_GET,
  LifecycleChanged
} from '../../../shared/shellEvents'
import { RemoteState, createRemoteState } from './remoteState'

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>

interface ShellState {
  bridge: Bridge
  phase: RemoteState<AppPhase>
  contextKeys: RemoteState<ContextKeySnapshot>
  layout: RemoteState<LayoutState>
  theme: RemoteState<ThemeState>
}

const ShellStateContext = createContext<ShellState | null>(null)

/** Mirrors the shell's application phase, context keys, layout and theme for the components below. */
export function ShellStateProvider({ bridge, children }: { bridge: Bridge, children: ReactNode }) {
  const [state] = useState<ShellState>(() => ({
    bridge,
    phase: createRemoteState<AppPhase, LifecycleChanged>(bridge, {
      initial: 'starting',
      load: LIFECYCLE_GET,
      event: LIFECYCLE_CHANGED,
      apply: (_, change) => change.phase
    }),
    contextKeys: createRemoteState<ContextKeySnapshot, ContextKeysChanged>(bridge, {
      initial: {},
      load: CONTEXT_KEYS_SNAPSHOT,
      event: CONTEXT_KEYS_CHANGED,
      apply: (keys, changes) => {
        const next = { ...keys }
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) delete next[key]
          else next[key] = value
        }
        return next
      }
    }),
    // The snapshot request tells this window its own id; layout.changed events
    // are broadcast to every window, so events for other windows are dropped.
    layout: createRemoteState<LayoutState, LayoutState>(bridge, {
      initial: emptyLayout(),
      load: LAYOUT_GET,
      event: LAYOUT_CHANGED,
      apply: (current, next) =>
        current.windowId === -1 || next.windowId === current.windowId ? next : current
    }),
    // Until the snapshot arrives, the shell's own theme for the kind the
    // operating system asks for: the same colours the main process starts
    // from, so the first frame only differs when the user chose another theme.
    theme: createRemoteState<ThemeState, ThemeState>(bridge, {
      initial: builtinThemeState(prefersDark() ? 'dark' : 'light'),
      load: THEME_GET,
      event: THEME_CHANGED,
      apply: (_, next) => next
    })
  }))

  return <ShellStateContext.Provider value={state}>{children}</ShellStateContext.Provider>
}

function useShellState() {
  const state = useContext(ShellStateContext)
  if (!state) throw new Error('This hook must be used inside <ShellStateProvider>')
  return state
}

/** The bridge the provider was created with, for components that send requests. */
export function useShellBridge(): Bridge {
  return useShellState().bridge
}

/** The application phase; re-renders when it changes. */
export function useAppPhase(): AppPhase {
  const { phase } = useShellState()
  return useSyncExternalStore(phase.subscribe, phase.getSnapshot)
}

/** The value of a context key (undefined when unset); re-renders when it changes. */
export function useContextKey(key: string): ContextKeyValue | undefined {
  const { contextKeys } = useShellState()
  return useSyncExternalStore(contextKeys.subscribe, () => contextKeys.getSnapshot()[key])
}

/** Every context key; re-renders on any change. For `{key}` text in bar items. */
export function useContextKeys(): ContextKeySnapshot {
  const { contextKeys } = useShellState()
  return useSyncExternalStore(contextKeys.subscribe, contextKeys.getSnapshot)
}

/** This window's layout; re-renders when it changes. */
export function useLayout(): LayoutState {
  const { layout } = useShellState()
  return useSyncExternalStore(layout.subscribe, layout.getSnapshot)
}

/** One bar's state. */
export function useBar(side: BarSide): BarState {
  return useLayout().bars[side]
}

/** The active theme and its resolved colours; re-renders when it changes. */
export function useTheme(): ThemeState {
  const { theme } = useShellState()
  return useSyncExternalStore(theme.subscribe, theme.getSnapshot)
}

/** A token's resolved hex colour (undefined while unresolved); re-renders when it changes. */
export function useThemeColor(token: string): string | undefined {
  const { theme } = useShellState()
  return useSyncExternalStore(theme.subscribe, () => theme.getSnapshot().colors[token])
}

function prefersDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}
