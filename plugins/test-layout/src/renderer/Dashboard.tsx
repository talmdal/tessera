// plugins/test-layout/src/renderer/Dashboard.tsx
//
// The first main-area page: totals for every bar, and a reset that goes
// through the privileged side like everything else.
import { Button, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { BORDERS } from '@tessera/types'
import { CHANNELS } from '../shared'
import { useTestLayoutState } from './useTestLayoutState'

export default function Dashboard() {
  const state = useTestLayoutState()

  const reset = () => {
    window.api.invoke(CHANNELS.reset).catch(err => console.error('[test-layout] reset failed', err))
  }

  return (
    <div data-sample-page="dashboard">
      <Typography variant="h4" component="h1" gutterBottom>Layout sample</Typography>
      <Typography sx={{ mb: 2 }}>
        Every bar around this page holds a view from the <code>test-layout</code> plugin.
        Press a bar's button: the request is handled in the plugin's privileged code, which
        pushes the new state to every view and switches this area to the detail page.
      </Typography>
      <Paper variant="outlined" sx={{ display: 'inline-block', mt: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Bar</TableCell>
              <TableCell align="right">Pings</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {BORDERS.map(border => (
              <TableRow key={border}>
                <TableCell>{border}</TableCell>
                <TableCell align="right" data-sample-total={border}>
                  <Typography variant="amount">{state?.counts[border] ?? 0}</Typography>
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell><strong>Total</strong></TableCell>
              <TableCell align="right">
                <Typography variant="amount" sx={{ fontWeight: 'bold' }} data-sample-total="all">{state?.total ?? 0}</Typography>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Paper>
      <Typography component="p" sx={{ mt: 4 }}>
        <Button variant="contained" onClick={reset} disabled={!state || state.total === 0}>Reset counters</Button>
      </Typography>
    </div>
  )
}
