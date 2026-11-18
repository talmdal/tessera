// Statements to read: one line per account with downloaded transactions waiting in its register, and the
// accounts a statement source is linked to. Clicking a line with items opens that account's register, which is
// where the statement is actually read — the register shows the waiting rows in place, with Accept and Change….
import { useEffect, useState } from 'react'
import { ACCOUNTS_EVENTS, formatAmount } from '@tessera/accounts-api'
import { EXCHANGE_CHANNELS, EXCHANGE_COMMANDS, EXCHANGE_EVENTS, type PendingSummary } from '@tessera/exchange-api'
import {
  Box, Button, Icon, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography
} from '@tessera/ui'
import { openRegister, runCommand } from './bridge'
import { showTimestamp } from './display'

function usePendingSummary(): PendingSummary[] | undefined {
  const [lines, setLines] = useState<PendingSummary[]>()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    const stops = [
      window.api.on(EXCHANGE_EVENTS.pending, bump),
      // Accepting rows and ordinary bookkeeping both move the local balance
      window.api.on(ACCOUNTS_EVENTS.transactions, bump),
      window.api.on(ACCOUNTS_EVENTS.chart, bump)
    ]
    return () => { for (const stop of stops) stop() }
  }, [])

  useEffect(() => {
    let live = true
    window.api.invoke<PendingSummary[]>(EXCHANGE_CHANNELS.pendingSummary).then(
      found => { if (live) setLines(found ?? []) },
      err => { console.error('[exchange] Could not load the statements to read', err); if (live) setLines([]) })
    return () => { live = false }
  }, [version])

  return lines
}

export default function StatementsView() {
  const lines = usePendingSummary()
  const toRead = (lines ?? []).filter(line => line.items > 0)

  return (
    <Stack sx={{ height: '100%', minHeight: 0, p: 3, gap: 1.5 }} data-exchange-page="statements">
      <Typography variant="h5" component="h1" color="primary">
        {toRead.length === 0
          ? 'No statements to read'
          : `You have ${toRead.length} statement${toRead.length === 1 ? '' : 's'} to read`}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Click an underlined account to review its downloaded transactions in the register: each one can be
        accepted as Tessera matched it, or matched by hand with Change…
      </Typography>

      {lines !== undefined && lines.length === 0 && (
        <Stack sx={{ alignItems: 'flex-start', gap: 1, mt: 2 }}>
          <Typography color="text.secondary">
            Import a statement from your bank to see it here.
          </Typography>
          <Button variant="outlined" startIcon={<Icon name="Download" />}
            onClick={() => void runCommand(EXCHANGE_COMMANDS.import).catch(() => undefined)}>
            Import Transactions…
          </Button>
        </Stack>
      )}

      {lines !== undefined && lines.length > 0 && (
        <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Account Name / (Number of items)</TableCell>
                <TableCell>Last Downloaded</TableCell>
                <TableCell align="right">Bank Balance</TableCell>
                <TableCell align="right">Local Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map(line => (
                <TableRow key={line.accountId} hover data-statement-line={line.accountId}>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      {line.items > 0 && <Icon name="PlayArrow" fontSize="small" color="warning" />}
                      {line.items > 0
                        ? (
                          <Box component="button" onClick={() => void openRegister(line.accountId)}
                            sx={{
                              background: 'none', border: 0, p: 0, font: 'inherit', cursor: 'pointer',
                              color: 'primary.main', textDecoration: 'underline'
                            }}>
                            {line.accountName}
                          </Box>
                        )
                        : <Typography variant="body2" component="span">{line.accountName}</Typography>}
                      <Typography variant="body2" component="span" color="text.secondary">({line.items})</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{line.lastReadAt === undefined ? '' : showTimestamp(line.lastReadAt)}</TableCell>
                  <TableCell align="right">
                    {line.bankBalance === undefined ? '' : <BalanceText minor={line.bankBalance} currency={line.currency} />}
                  </TableCell>
                  <TableCell align="right"><BalanceText minor={line.localBalance} currency={line.currency} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  )
}

function BalanceText({ minor, currency }: { minor: number, currency: string }) {
  return (
    <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', color: minor < 0 ? 'error.main' : 'text.primary' }}>
      {formatAmount(minor, currency)}
    </Box>
  )
}
