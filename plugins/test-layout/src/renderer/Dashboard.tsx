// plugins/layout.sample/src/renderer/Dashboard.tsx
//
// The first main-area page: totals for every bar, and a reset that goes
// through the privileged side like everything else.
import { BORDERS } from '@tessera/types'
import { CHANNELS } from '../shared'
import { useTestLayoutState } from './useTestLayoutState'

export default function Dashboard() {
  const state = useTestLayoutState()

  const reset = () => {
    window.api.invoke(CHANNELS.reset).catch(err => console.error('[layout-sample] reset failed', err))
  }

  return (
    <div data-sample-page="dashboard">
      <h1>Layout sample</h1>
      <p>
        Every bar around this page holds a view from the <code>layout-sample</code> plugin.
        Press a bar's button: the request is handled in the plugin's privileged code, which
        pushes the new state to every view and switches this area to the detail page.
      </p>
      <table style={{ borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr>
            <th style={cell}>Bar</th>
            <th style={cell}>Pings</th>
          </tr>
        </thead>
        <tbody>
          {BORDERS.map(border => (
            <tr key={border}>
              <td style={cell}>{border}</td>
              <td style={cell} data-sample-total={border}>{state?.counts[border] ?? 0}</td>
            </tr>
          ))}
          <tr>
            <td style={cell}><strong>Total</strong></td>
            <td style={cell}><strong data-sample-total="all">{state?.total ?? 0}</strong></td>
          </tr>
        </tbody>
      </table>
      <p style={{ marginTop: 16 }}>
        <button type="button" onClick={reset} disabled={!state || state.total === 0}>Reset counters</button>
      </p>
    </div>
  )
}

const cell = { border: '1px solid #ccc', padding: '4px 12px', textAlign: 'left' as const }
