import type { BorderItemDescriptor, Border } from '@tessera/types'
import { Box, Button, Toolbar, Typography } from '@tessera/ui'
import { useContextKeySnapshot, useLayoutActions } from '../state/ShellState'
import { BarIcon } from './BarIcon'

/** `{key}` becomes the value of that context key, and '' when it is unset. */
function interpolate(text: string, keys: Record<string, unknown>) {
  return text.replace(/{([^{}]+)}/g, (_match, key: string) => String(keys[key.trim()] ?? ''))
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
    const text = item.kind === 'button' ? item.label : interpolate(item.text, keys)
    const icon = item.icon ? <BarIcon icon={item.icon} title={item.kind === 'button' ? item.label : item.text} /> : undefined

    if (item.command === undefined) {
      return (
        <Typography key={item.id} component="span" variant="body2" data-item={item.id} title={item.tooltip}
          sx={{ display: 'inline-flex', gap: 0.5, alignItems: 'center' }}>
          {icon}{text}
        </Typography>
      )
    }

    const command = item.command
    return (
      <Button key={item.id} data-item={item.id} title={item.tooltip} disabled={!item.enabled} startIcon={icon}
        aria-label={item.kind === 'button' ? item.label : undefined} onClick={() => execute(command)}>
        {text}
      </Button>
    )
  }

  const start = items.filter(item => item.align !== 'end')
  const end = items.filter(item => item.align === 'end')

  return (
    <Toolbar variant="dense" disableGutters role="group" aria-label={`${side} bar items`}
      sx={{ flex: 'none', gap: 1, px: 1, minHeight: 32, borderBottom: side === 'bottom' ? 0 : 1, borderTop: side === 'bottom' ? 1 : 0, borderColor: 'divider' }}>
      {start.map(draw)}
      <Box sx={{ flexGrow: 1 }} />
      {end.map(draw)}
    </Toolbar>
  )
}
