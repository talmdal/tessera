import type { ReactNode } from 'react'
import { Box, Button, Toolbar, Tooltip, Typography } from '@mui/material'
import type { BorderItemDescriptor, Border } from '@tessera/types'
import { ContributionIcon } from '@tessera/ui'
import { useContextKeySnapshot, useLayoutActions } from '../state/ShellState'
import { STRIP_HEIGHT } from '../theme/createShellTheme'

/** `{key}` becomes the value of that context key, and '' when it is unset. */
function interpolate(text: string, keys: Record<string, unknown>) {
  return text.replace(/\{([^{}]+)\}/g, (_match, key: string) => String(keys[key.trim()] ?? ''))
}

/**
 * A bar's row of buttons and text. A button is enabled while its command is
 * (the main process says so in the descriptor), and text follows the context
 * keys it names, so a status line updates without any request of its own.
 */
export function ItemStrip({ side, items }: { side: Border, items: BorderItemDescriptor[] }) {
  const keys = useContextKeySnapshot()
  const { execute } = useLayoutActions()

  const draw = (item: BorderItemDescriptor) => {
    const title = item.kind === 'button' ? item.label : item.text
    const icon = item.icon ? <ContributionIcon icon={item.icon} title={title} fontSize="small" /> : undefined
    const text = item.kind === 'button' ? item.label : interpolate(item.text, keys)

    let drawn: ReactNode
    if (item.command === undefined) {
      drawn = (
        <Typography key={item.id} component="span" variant="body2" data-item={item.id}
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, px: 1, whiteSpace: 'nowrap' }}>
          {icon}{text}
        </Typography>
      )
    } else {
      const command = item.command
      drawn = (
        <Button key={item.id} data-item={item.id} disabled={!item.enabled} startIcon={icon} color="inherit"
          aria-label={item.kind === 'button' ? item.label : undefined} onClick={() => execute(command)}
          sx={{ whiteSpace: 'nowrap', minWidth: 0 }}>
          {text}
        </Button>
      )
    }

    if (!item.tooltip) return drawn
    // A disabled button fires no events, so the tooltip listens on a wrapper around it.
    return (
      <Tooltip key={item.id} title={item.tooltip}>
        {item.command !== undefined && !item.enabled ? <span>{drawn}</span> : drawn}
      </Tooltip>
    )
  }

  const start = items.filter(item => item.align !== 'end')
  const end = items.filter(item => item.align === 'end')

  return (
    <Toolbar variant="dense" disableGutters role="group" aria-label={`${side} bar items`}
      sx={{ flex: 'none', minHeight: STRIP_HEIGHT, gap: 1, px: 2, overflow: 'hidden' }}>
      {start.map(draw)}
      <Box sx={{ flex: 1 }} />
      {end.map(draw)}
    </Toolbar>
  )
}
