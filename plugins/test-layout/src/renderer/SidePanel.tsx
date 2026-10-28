// plugins/layout.sample/src/renderer/SidePanel.tsx
//
// The view shown in each bar. Its only state comes from the privileged side;
// the button sends a request there and the answer comes back as an event.
import { Border } from '@tessera/types'
import { CHANNELS, PingRequest } from '../shared'
import { useTestLayoutState } from './useTestLayoutState'

export function SidePanel({ side }: { side: Border }) {
  const state = useTestLayoutState()
  const count = state?.counts[side] ?? 0
  const isLast = state?.last?.side === side

  const ping = () => {
    const request: PingRequest = { side }
    window.api.invoke(CHANNELS.ping, request).catch(err =>
      console.error(`[layout-sample] ping from ${side} failed`, err))
  }

  return (
    <div style={{ padding: 10, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }} data-sample-panel={side}>
      <div>
        This is the <strong>{side}</strong> bar.
      </div>
      <div style={{ padding: '6px 8px', borderRadius: 4, background: isLast ? '#fff3c4' : '#e8e8e8' }}>
        Pressed <strong data-sample-count={side}>{count}</strong> {count === 1 ? 'time' : 'times'}
        {isLast && ' · most recent'}
      </div>
      <button type="button" onClick={ping} disabled={state === undefined}>
        Ping from {side}
      </button>
    </div>
  )
}