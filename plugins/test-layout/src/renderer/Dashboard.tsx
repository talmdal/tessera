// plugins/layout.sample/src/renderer/Dashboard.tsx
//
// The first main-area page: totals for every bar, and a reset that goes
// through the privileged side like everything else.
import { BORDERS } from '@tessera/types'
import { Box, Button } from '@tessera/ui'
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
      <Box component="table" sx={{ borderCollapse: 'collapse', mt: 1.5 }}>
        <thead>
          <tr>
            <Box component="th" sx={cell}>Bar</Box>
            <Box component="th" sx={cell}>Pings</Box>
          </tr>
        </thead>
        <tbody>
          {BORDERS.map(border => (
            <tr key={border}>
              <Box component="td" sx={cell}>{border}</Box>
              <Box component="td" sx={cell} data-sample-total={border}>{state?.counts[border] ?? 0}</Box>
            </tr>
          ))}
          <tr>
            <Box component="td" sx={cell}><strong>Total</strong></Box>
            <Box component="td" sx={cell}><strong data-sample-total="all">{state?.total ?? 0}</strong></Box>
          </tr>
        </tbody>
      </Box>
      <p style={{ marginTop: 16 }}>
        <Button variant="outlined" onClick={reset} disabled={!state || state.total === 0}>Reset counters</Button>
      </p>
    </div>
  )
}

const cell = { border: 1, borderColor: 'divider', px: 1.5, py: 0.5, textAlign: 'left' } as const
