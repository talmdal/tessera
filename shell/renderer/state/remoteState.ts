// shell/renderer/state/remoteState.ts
import type { TesseraBridge } from '../../../shared/ipc'

export interface RemoteState<S> {
  /** For React's useSyncExternalStore. */
  subscribe(listener: () => void): () => void
  getSnapshot(): S
}

interface RemoteStateOptions<S, E> {
  initial: S
  /** Request that returns the current state. */
  load: string
  /** Push event announcing a change. */
  event: string
  /** Applies an event to the state. Events must carry absolute values, so replaying one is harmless. */
  apply(state: S, event: E): S
}

/**
 * Mirrors a piece of main-process state in the renderer: one request for the
 * current value, then the push events that follow. Events that arrive while
 * the request is in flight are held and applied on top of its result, so the
 * state is never left older than an event that was already received.
 */
export function createRemoteState<S, E>(
  bridge: Pick<TesseraBridge, 'invoke' | 'on'>,
  { initial, load, event, apply }: RemoteStateOptions<S, E>
): RemoteState<S> {
  let state = initial
  let loaded = false
  const held: E[] = []
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())

  const settle = (base: S) => {
    state = held.reduce((current, pending) => apply(current, pending), base)
    held.length = 0
    loaded = true
    notify()
  }

  bridge.on<E>(event, change => {
    if (!loaded) {
      held.push(change)
      return
    }
    state = apply(state, change)
    notify()
  })

  bridge.invoke<S>(load).then(settle, err => {
    console.error(`[state] Could not load ${load}`, err)
    settle(initial)
  })

  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state
  }
}
