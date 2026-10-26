// plugins/layout.sample/src/renderer/useSampleState.ts
import { useEffect, useState } from 'react'
import { CHANNELS, EVENTS, SampleState } from '../shared'

/**
 * The privileged side's state, as seen from a view: subscribe to the change
 * event first, then request the current snapshot, so nothing is missed in
 * between. Events carry the whole state, so applying one is always safe.
 */
export function useSampleState(): SampleState | undefined {
  const [state, setState] = useState<SampleState>()

  useEffect(() => {
    const stop = window.api.on<SampleState>(EVENTS.changed, setState)
    window.api.invoke<SampleState>(CHANNELS.state).then(
      current => setState(previous => previous ?? current),   // an event that arrived first wins
      err => console.error('[layout-sample] Could not load state', err)
    )
    return stop
  }, [])

  return state
}
