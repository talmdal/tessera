// plugins/test-layout/src/renderer/SidePanel.tsx
//
// The view shown in each bar. Its only state comes from the privileged side;
// the button sends a request there and the answer comes back as an event.
// Styled entirely from the shell's theme: no colour or size of its own.
import { Button, Chip, Paper, Stack, Typography } from '@mui/material'
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
      console.error(`[test-layout] ping from ${side} failed`, err))
  }

  return (
    <Stack spacing={2} sx={{ p: 2 }} data-sample-panel={side}>
      <Typography variant="body2">
        This is the <strong>{side}</strong> bar.
      </Typography>
      <Paper variant="outlined" sx={{ px: 2, py: 1.5, bgcolor: isLast ? 'action.selected' : 'background.default' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2">
            Pressed <strong data-sample-count={side}>{count}</strong> {count === 1 ? 'time' : 'times'}
          </Typography>
          {isLast && <Chip label="most recent" color="primary" variant="outlined" />}
        </Stack>
      </Paper>
      <Button variant="outlined" onClick={ping} disabled={state === undefined}>
        Ping from {side}
      </Button>
    </Stack>
  )
}
