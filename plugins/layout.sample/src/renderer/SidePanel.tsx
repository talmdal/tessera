// plugins/layout.sample/src/renderer/SidePanel.tsx
//
// The view shown in each bar. Its only state comes from the privileged side;
// the button sends a request there and the answer comes back as an event.
import { CHANNELS, PingRequest, Side } from '../shared'
import { useSampleState } from './useSampleState'

export function SidePanel({ side }: { side: Side }) {
  const state = useSampleState()
  const count = state?.counts[side] ?? 0
  const isLast = state?.last?.side === side

  const ping = () => {
    const request: PingRequest = { side }
    window.api.invoke(CHANNELS.ping, request).catch(err =>
      console.error(`[layout-sample] ping from ${side} failed`, err))
  }

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }} data-sample-panel={side}>
      <div>
        This is the <strong>{side}</strong> bar.
      </div>
      <div style={{ padding: '6px 8px', borderRadius: 4, background: isLast ? 'var(--shell-selectionBackground)' : 'var(--shell-bar-hoverBackground)' }}>
        Pressed <strong data-sample-count={side}>{count}</strong> {count === 1 ? 'time' : 'times'}
        {isLast && ' · most recent'}
      </div>
      <button type="button" onClick={ping} disabled={state === undefined}>
        Ping from {side}
      </button>
    </div>
  )
}
