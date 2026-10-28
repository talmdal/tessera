// plugins/layout.sample/src/renderer/useSampleState.ts
import { useEffect, useState } from 'react'
import { CHANNELS, EVENTS, LayoutState } from '../shared'

/**
 * The privileged side's state, as seen from a view: subscribe to the change
 * event first, then request the current snapshot, so nothing is missed in
 * between. Events carry the whole state, so applying one is always safe.
 */
export function useTestLayoutState(): LayoutState | undefined {
  const [state, setState] = useState<LayoutState>()

  useEffect(() => {
    const stop = window.api.on<LayoutState>(EVENTS.changed, setState)
    window.api.invoke<LayoutState>(CHANNELS.state).then(
      current => setState(previous => previous ?? current),   // an event that arrived first wins
      err => console.error('[layout-sample] Could not load state', err)
    )
    return stop
  }, [])

  return state
}