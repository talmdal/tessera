// The transactions behind a row's actual, in date order, each with Open Register. Archived months can't be listed; the
// dialog says how much of the actual they hold.
import type { DialogProps } from '@tessera/types'
import { ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import type { TransactionsDialogInput } from '@tessera/budget-api'
import { Button, DialogActions, DialogContent, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@tessera/ui'
import { runCommand } from './bridge'
import { amount, showDate } from './display'

const NUMBER = { typography: 'numeric', whiteSpace: 'nowrap' } as const

export default function TransactionsDialog({ input, close }: DialogProps<TransactionsDialogInput>) {
  const { rows, currency } = input
  const openRegister = (accountId: string) => {
    close()
    void runCommand(ACCOUNTS_COMMANDS.openRegister, { id: accountId }).catch(() => undefined)
  }
  return (
    <>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {input.period}: {rows.length === 0 ? 'no transactions' : `${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'}`}, {amount(input.total, currency)}
        </Typography>
        {input.archived && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-note="archived">
            {amount(input.archived.amount, currency)} of the actual, {amount(input.actual, currency)}, is in the archive
            {input.archived.before ? ` before ${showDate(input.archived.before)}` : ''}, so it isn’t listed.
          </Typography>
        )}
        {rows.length > 0 && (
          <TableContainer sx={{ maxHeight: '50vh' }}>
            <Table size="small" stickyHeader aria-label={`Transactions: ${input.row}`}>
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Account</TableCell>
                  <TableCell>Payee</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.transactionId} hover data-transaction={r.transactionId}>
                    <TableCell sx={NUMBER}>{showDate(r.date)}</TableCell>
                    <TableCell>{r.accountName}</TableCell>
                    <TableCell>{r.payee ?? ''}</TableCell>
                    <TableCell>{r.label ?? ''}</TableCell>
                    <TableCell align="right" sx={NUMBER}>{amount(r.amount, currency)}</TableCell>
                    <TableCell align="right"><Button size="small" onClick={() => openRegister(r.accountId)}>Open Register</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => close()}>Close</Button>
      </DialogActions>
    </>
  )
}
