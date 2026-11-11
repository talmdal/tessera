// plugins/layout.sample/src/renderer/SidePanel.tsx
//
// The view shown in each bar. Its only state comes from the privileged side;
// the button sends a request there and the answer comes back as an event.
import { Border } from '@tessera/types'
import { Box, Button } from '@tessera/ui'
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
    // Text in the Interface text role's body size (body2), never a literal size: it follows the user's fonts.
    <Box sx={{ p: '10px', typography: 'body2', display: 'flex', flexDirection: 'column', gap: 1 }} data-sample-panel={side}>
      <div>
        This is the <strong>{side}</strong> bar.
      </div>
      {/* Theme tokens, never literal colours: the panel follows light and dark. */}
      <Box sx={{
        px: 1, py: 0.75, borderRadius: 1,
        bgcolor: isLast ? 'primary.main' : 'action.selected',
        color: isLast ? 'primary.contrastText' : 'text.primary'
      }}>
        Pressed <strong data-sample-count={side}>{count}</strong> {count === 1 ? 'time' : 'times'}
        {isLast && ' · most recent'}
      </Box>
      <Button variant="outlined" onClick={ping} disabled={state === undefined}>
        Ping from {side}
      </Button>
    </Box>
  )
}