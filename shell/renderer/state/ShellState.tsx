// shell/renderer/state/ShellState.tsx
import { ReactNode, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { 
  AppPhase,
  Border, 
  BorderState,
  ContextKeyValue,
  LayoutRevealed, 
  LayoutSlotSet, 
  LayoutState,
  TesseraBridge 
} from '@tessera/types'
import { EMPTY_LAYOUT, LAYOUT_CHANGED, LAYOUT_GET, LAYOUT_REVEALED, LAYOUT_SLOT_SET } from '../../../shared/layout/types'
import {
  CONTEXT_KEYS_CHANGED,
  CONTEXT_KEYS_SNAPSHOT,
  ContextKeySnapshot,
  ContextKeysChanged,
  COMMANDS_EXECUTE,
  ExecuteCommandRequest,
  LIFECYCLE_CHANGED,
  LIFECYCLE_GET,
  LifecycleChanged
} from '../../../shared/shellEvents'
import { RemoteState, createRemoteState } from './remoteState'

interface ShellState {
  phase: RemoteState<AppPhase>
  contextKeys: RemoteState<ContextKeySnapshot>
  layout: RemoteState<LayoutState>
  /**
   * Reports a gesture to the layout controller; the new state comes back as an event. Resolves once the
   * controller has answered, or has refused (which is logged), never rejects.
   */
  setSlot(request: LayoutSlotSet): Promise<void>
  /** Runs a command in the main process, as a bar button does. */
  execute(id: string, args?: unknown[]): void
  /** Calls the listener when a view was revealed in this window. */
  onRevealed(listener: (revealed: LayoutRevealed) => void): () => void
}

const ShellStateContext = createContext<ShellState | null>(null)

/** Mirrors the shell's application phase, context keys and this window's layout for the components below. */
export function ShellStateProvider({ bridge, children }: { bridge: Pick<TesseraBridge, 'invoke' | 'on'>, children: ReactNode }) {
  const [state] = useState<ShellState>(() => {
    const layout = createRemoteState<LayoutState, LayoutState>(bridge, {
      initial: EMPTY_LAYOUT,
      load: LAYOUT_GET,
      event: LAYOUT_CHANGED,
      // Events for other windows are dropped; until the snapshot names this window (-1), any are accepted.
      apply: (current, next) => current.windowId === -1 || next.windowId === current.windowId ? next : current
    })

    const revealListeners = new Set<(revealed: LayoutRevealed) => void>()
    bridge.on<LayoutRevealed>(LAYOUT_REVEALED, (revealed) => {
      if (revealed.windowId === layout.getSnapshot().windowId) revealListeners.forEach(listener => listener(revealed))
    })

    return {
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
    layout,
    setSlot: request =>
      bridge.invoke(LAYOUT_SLOT_SET, request).then(
        () => {},
        (err: unknown) => { console.error('[layout] Could not apply', request, err) }),
    execute: (id, args) => {
      const request: ExecuteCommandRequest = { id, args }
      bridge.invoke(COMMANDS_EXECUTE, request).catch((err: unknown) => console.error('[layout] Could not run command', id, err))
    },
    onRevealed: listener => {
      revealListeners.add(listener)
      return () => { revealListeners.delete(listener) }
    }
    }
  })

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

/** This window's layout; re-renders when it changes. */
export function useLayout(): LayoutState {
  const { layout } = useShellState()
  return useSyncExternalStore(layout.subscribe, layout.getSnapshot)
}

export function useBar(side: Border): BorderState {
  return useLayout().bars[side]
}

/** Every context key and its value; re-renders when any changes. */
export function useContextKeySnapshot(): ContextKeySnapshot {
  const { contextKeys } = useShellState()
  return useSyncExternalStore(contextKeys.subscribe, contextKeys.getSnapshot)
}

/** Sends the user's gestures (choose a tab, collapse, resize, click a button) to the main process. */
export function useLayoutActions(): Pick<ShellState, 'setSlot' | 'execute'> {
  const { setSlot, execute } = useShellState()
  return { setSlot, execute }
}

/** Calls `listener` when a view is revealed in this window, once the layout showing it has been applied. */
export function useRevealed(listener: (revealed: LayoutRevealed) => void) {
  const { onRevealed } = useShellState()
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => onRevealed(revealed => latest.current(revealed)), [onRevealed])
}
