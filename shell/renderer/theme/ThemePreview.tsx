// shell/renderer/theme/ThemePreview.tsx
import { ThemeProvider } from '@mui/material'
import { useMemo } from 'react'
import type { ResolvedFonts, ThemeDescriptor, ThemeMode } from '@tessera/types'
import { Box, Button, Icon, Stack, Tab, Table, TableBody, TableCell, TableRow, Tabs, Typography } from '@tessera/ui'
import { createShellTheme } from './createShellTheme'

/** The status colours a theme sets, shown as the small swatches a form or a table would use. */
const STATUS = ['error', 'warning', 'info', 'success'] as const

/**
 * A miniature of the application in `theme` and `mode`: a toolbar, a tab strip,
 * text, buttons, a highlighted and a plain panel, and the status colours. It is
 * drawn with the same components and the same MUI theme the application uses for
 * that theme, in a provider of its own, so it shows what choosing the theme would
 * give, not an approximation. It is for looking at: it cannot be clicked, focused
 * or read out as controls, only described.
 */
export function ThemePreview({ theme, mode, fonts, fontSamples = false }: {
  theme: ThemeDescriptor
  mode: ThemeMode
  /** The fonts to draw it in: the user's, as the window shows them. Default: the shell's own. */
  fonts?: ResolvedFonts
  /** Adds a sample of every font role: a caption, two register rows with amounts, and a line of fixed-width text. */
  fontSamples?: boolean
}) {
  const muiTheme = useMemo(() => createShellTheme(theme, mode, { fonts }), [theme, mode, fonts])

  return (
    <ThemeProvider theme={muiTheme}>
      <Box role="img" aria-label={`Preview of the ${theme.label} theme in ${mode} mode`} {...{ inert: '' }}
        sx={{
          border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.default', color: 'text.primary',
          pointerEvents: 'none', userSelect: 'none', display: 'flex', flexDirection: 'column', minWidth: 0
        }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 600, flexGrow: 1 }}>Tessera</Typography>
          <Button size="small" startIcon={<Icon name="Save" fontSize="small" />} tabIndex={-1}>Save</Button>
        </Box>

        <Box sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={0} aria-hidden>
            <Tab icon={<Icon name="Home" fontSize="small" />} iconPosition="start" label="Accounts" tabIndex={-1} />
            <Tab icon={<Icon name="List" fontSize="small" />} iconPosition="start" label="Reports" tabIndex={-1} />
          </Tabs>
        </Box>

        <Stack spacing={1.25} sx={{ p: 1.5 }}>
          <Typography variant="h6" component="p">Account summary</Typography>
          <Typography variant="body2">Balance after the latest transactions.</Typography>
          <Typography variant="body2" color="text.secondary">Updated a moment ago</Typography>

          <Stack direction="row" spacing={1}>
            <Box sx={{ flex: 1, px: 1, py: 0.75, borderRadius: 1, bgcolor: 'action.selected' }}>Pressed <strong>3</strong> times</Box>
            <Box sx={{ flex: 1, px: 1, py: 0.75, borderRadius: 1, bgcolor: 'primary.main', color: 'primary.contrastText' }}>Most recent</Box>
          </Stack>

          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" tabIndex={-1}>Primary</Button>
            <Button variant="outlined" size="small" tabIndex={-1}>Outlined</Button>
            <Button variant="outlined" size="small" disabled tabIndex={-1}>Disabled</Button>
          </Stack>

          {fontSamples && <FontSamples />}

          <Stack direction="row" spacing={1}>
            {STATUS.map(status => (
              <Box key={status} sx={{ flex: 1, py: 0.25, borderRadius: 1, textAlign: 'center', typography: 'caption', bgcolor: `${status}.main`, color: `${status}.contrastText` }}>
                {status}
              </Box>
            ))}
          </Stack>
        </Stack>
      </Box>
    </ThemeProvider>
  )
}

/** Every font role once, as the application draws it: small text, a register with figures, fixed-width text. */
function FontSamples() {
  const row = (date: string, payee: string, amount: string, balance: string) => (
    <TableRow>
      <TableCell>{date}</TableCell>
      <TableCell>{payee}</TableCell>
      <TableCell align="right" sx={{ typography: 'numeric' }}>{amount}</TableCell>
      <TableCell align="right" sx={{ typography: 'numeric' }}>{balance}</TableCell>
    </TableRow>
  )
  return (
    <>
      <Typography variant="caption" color="text.secondary">Last reconciled Oct 31, 2026</Typography>
      <Table size="small" aria-hidden>
        <TableBody>
          {row('Oct 2, 2026', 'Metro', '50.25', '949.75')}
          {row('Oct 5, 2026', 'Hydro One', '1,111.11', '3,838.64')}
        </TableBody>
      </Table>
      <Box sx={{ typography: 'monospace' }}>C:\Users\me\Documents\Home Finances.tessera</Box>
    </>
  )
}
