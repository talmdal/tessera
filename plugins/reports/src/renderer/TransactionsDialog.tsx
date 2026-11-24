// The transactions behind a figure, in date order, each with Open Register, as the budget's Transactions dialog lists
// them. Archived months can't be listed: the dialog says how much of the figure they are. Past the limit, it says how
// many there are and suggests a narrower period.
import type { DialogProps } from '@tessera/types'
import { ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import type { TransactionsDialogInput } from '@tessera/reports-api'
import { Button, DialogActions, DialogContent, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@tessera/ui'
import { runCommand } from './bridge'
import { amount, showDate } from './display'

const NUMBER = { typography: 'numeric', whiteSpace: 'nowrap' } as const

export default function TransactionsDialog({ input, close }: DialogProps<TransactionsDialogInput>) {
  const { result, currency } = input
  const rows = result.transactions
  const listed = rows.reduce((sum, t) => sum + t.amount, 0)
  const openRegister = (accountId: string) => {
    close()
    void runCommand(ACCOUNTS_COMMANDS.openRegister, { id: accountId }).catch(() => undefined)
  }
  const count = result.total === 0 ? 'no transactions' : `${result.total.toLocaleString()} ${result.total === 1 ? 'transaction' : 'transactions'}`
  return (
    <>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-note="summary">
          {currency && rows.length > 0 && result.total === rows.length ? `${count}, ${amount(listed, currency)}` : count}
          {input.figure !== null && currency ? ` (the figure is ${amount(input.figure, currency)})` : ''}
        </Typography>
        {result.archived && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-note="archived">
            {currency ? `${amount(result.archived.amount, currency)} of it was` : 'Some of it was'} archived before {showDate(result.archived.before)}, so it isn’t listed.
          </Typography>
        )}
        {result.total > rows.length && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-note="limit">
            Showing the first {rows.length.toLocaleString()} of {result.total.toLocaleString()}. Choose a shorter period to see them all.
          </Typography>
        )}
        {rows.length > 0 && (
          <TableContainer sx={{ maxHeight: '50vh' }}>
            <Table size="small" stickyHeader aria-label={`Transactions: ${input.title}`}>
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
                {rows.map(t => (
                  <TableRow key={t.id} hover data-transaction={t.id}>
                    <TableCell sx={NUMBER}>{showDate(t.date)}</TableCell>
                    <TableCell>{t.accountName}</TableCell>
                    <TableCell>{t.payee ?? ''}</TableCell>
                    <TableCell>{t.label ?? ''}</TableCell>
                    <TableCell align="right" sx={NUMBER}>{amount(t.amount, t.currency || currency)}</TableCell>
                    <TableCell align="right"><Button size="small" onClick={() => openRegister(t.accountId)}>Open Register</Button></TableCell>
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
