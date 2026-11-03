// shell/renderer/theme/ThemeSample.tsx — a miniature of the application, for the chooser's preview pane.
import {
  Alert, Box, Button, Chip, IconButton, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField,
  ThemeProvider, Typography, useTheme
} from '@mui/material'
import type { Theme } from '@mui/material'
import { Icon } from '@tessera/ui'

/** Static figures: what a register looks like, so credit and debit colours and tabular numerals can be judged. */
const ROWS = [
  { date: '03 Nov', payee: 'Grocer', amount: -42.17 },
  { date: '04 Nov', payee: 'Salary', amount: 2100 },
  { date: '06 Nov', payee: 'Transfer to savings', amount: -500 }
]

const money = (amount: number) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount))

/**
 * Renders a fixed set of components under `theme`: a bar with icons, a tab
 * strip, a small register, a text field, the button variants, a chip and an
 * alert. Nothing in it is wired to the application; it exists to be looked
 * at, inside a nested ThemeProvider so the window around it is untouched.
 */
export function ThemeSample({ theme }: { theme: Theme }) {
  return (
    <ThemeProvider theme={theme}>
      <Sample />
    </ThemeProvider>
  )
}

function Sample() {
  const theme = useTheme()
  return (
    <Paper variant="outlined" data-theme-sample
      sx={{ overflow: 'hidden', bgcolor: 'background.default', color: 'text.primary', fontFamily: theme.typography.fontFamily }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 2, py: 1, bgcolor: theme.tessera.bar.background, borderBottom: 1, borderColor: theme.tessera.bar.tabStripBorder }}>
        <Icon name="AccountBalance" fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>Accounts</Typography>
        <IconButton aria-label="Sample save"><Icon name="Save" fontSize="small" /></IconButton>
        <IconButton aria-label="Sample add"><Icon name="Add" fontSize="small" /></IconButton>
        <IconButton aria-label="Sample search"><Icon name="Search" fontSize="small" /></IconButton>
      </Stack>

      <Tabs value={0} aria-label="Sample views" sx={{ bgcolor: theme.tessera.bar.background, borderBottom: 1, borderColor: theme.tessera.bar.tabStripBorder }}>
        <Tab label="Register" icon={<Icon name="List" fontSize="small" />} iconPosition="start" />
        <Tab label="Budget" icon={<Icon name="CalendarToday" fontSize="small" />} iconPosition="start" />
        <Tab label="Reports" icon={<Icon name="Home" fontSize="small" />} iconPosition="start" />
      </Tabs>

      <Box sx={{ p: 2 }}>
        <Table aria-label="Sample register">
          <TableHead>
            <TableRow>
              <TableCell>Date</TableCell>
              <TableCell>Payee</TableCell>
              <TableCell align="right">Amount</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {ROWS.map(row => (
              <TableRow key={row.payee}>
                <TableCell>{row.date}</TableCell>
                <TableCell>{row.payee}</TableCell>
                <TableCell align="right">
                  <Typography variant="amount" sx={{ color: row.amount < 0 ? theme.tessera.finance.debit : theme.tessera.finance.credit }}>
                    {row.amount < 0 ? '−' : ''}{money(row.amount)}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Stack direction="row" sx={{ alignItems: 'center', gap: 2, mt: 3, flexWrap: 'wrap' }}>
          <TextField label="Payee" defaultValue="Grocer" sx={{ m: 0, minWidth: 160 }} />
          <Button variant="contained">Primary</Button>
          <Button variant="outlined" color="secondary">Secondary</Button>
          <Button variant="text">Text</Button>
          <Chip label="Reconciled" sx={{ color: theme.tessera.finance.reconciled }} variant="outlined" />
          <Chip label="Uncleared" sx={{ color: theme.tessera.finance.uncleared, borderColor: theme.tessera.finance.uncleared }} variant="outlined" />
        </Stack>

        <Alert severity="info" sx={{ mt: 3 }}>An information message, in this theme's colours.</Alert>
      </Box>
    </Paper>
  )
}
