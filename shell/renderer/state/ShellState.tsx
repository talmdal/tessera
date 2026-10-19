// shell/renderer/state/ShellState.tsx
import { ReactNode, createContext, useContext, useState, useSyncExternalStore } from 'react'
import type { ContextKeyValue } from '../../../shared/context/when'
import type { TesseraBridge } from '../../../shared/ipc'
import {
  AppPhase,
  CONTEXT_KEYS_CHANGED,
  CONTEXT_KEYS_SNAPSHOT,
  ContextKeySnapshot,
  ContextKeysChanged,
  LIFECYCLE_CHANGED,
  LIFECYCLE_GET,
  LifecycleChanged
} from '../../../shared/shellEvents'
import { RemoteState, createRemoteState } from './remoteState'

interface ShellState {
  phase: RemoteState<AppPhase>
  contextKeys: RemoteState<ContextKeySnapshot>
}

const ShellStateContext = createContext<ShellState | null>(null)

/** Mirrors the shell's application phase and context keys for the components below. */
export function ShellStateProvider({ bridge, children }: { bridge: Pick<TesseraBridge, 'invoke' | 'on'>, children: ReactNode }) {
  const [state] = useState<ShellState>(() => ({
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
    })
  }))

  return <ShellStateContext.Provider value={state}>{children}</ShellStateContext.Provider>
}

function useShellState() {
  const state = useContext(ShellStateContext)
  if (!state) throw new Error('This hook must be used inside <ShellStateProvider>')
  return state
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
