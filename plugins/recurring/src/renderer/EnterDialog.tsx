// Enter in Register: everything about to be written, one editable row each. It is shown before *every* entry,
// one occurrence or twenty, because the amount of a real bill is rarely exactly the scheduled one — and because
// listing what is about to go into a register is the honest way to confirm it.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { AMOUNT_COLUMNS, amountToInput, isIsoDate, parseAmount, TRANSACTION_NUMBER_MAX_LENGTH, MEMO_MAX_LENGTH, type Account } from '@tessera/accounts-api'
import type { EnterDialogInput, EnterRequest } from '@tessera/recurring-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography
} from '@tessera/ui'
import { showDate } from './display'

/** One row as the form holds it: text as typed, so nothing is reformatted under the user. */
interface Line {
  seriesId: string
  name: string
  account: Account
  /** Unsigned, as the register shows it; the column it sits in carries the sign. */
  amount: string
  /** Which way the money goes, from the series: a payment lowers the balance. */
  decrease: boolean
  date: string
  number: string
  memo: string
  estimated: boolean
  updateEstimate: boolean
  payee?: string
  categoryLabel?: string
}

const lineFrom = (input: EnterDialogInput, index: number): Line => {
  const { row, request } = input.rows[index]
  const account = input.accounts.find(a => a.id === row.account.id)!
  const amount = request.amount ?? row.series.template.amount
  return {
    seriesId: row.series.id,
    name: row.series.name,
    account,
    amount: amount === 0 ? '' : amountToInput(Math.abs(amount), account.currency),
    decrease: amount < 0,
    date: request.date ?? row.occurrence?.date ?? '',
    number: request.number ?? '',
    memo: request.memo ?? '',
    estimated: row.series.template.estimated,
    updateEstimate: false,
    ...(row.payeeName !== undefined && { payee: row.payeeName }),
    ...(row.categoryLabel !== undefined && { categoryLabel: row.categoryLabel })
  }
}

/** What a line would write, or why it can't be written. */
export function toRequest(line: Line): { request?: EnterRequest, problem?: { field: 'amount' | 'date', message: string } } {
  if (!isIsoDate(line.date)) return { problem: { field: 'date', message: 'Enter a date.' } }
  const parsed = parseAmount(line.amount, line.account.currency)
  if (!parsed.ok) return { problem: { field: 'amount', message: parsed.message } }
  if (parsed.value < 0) return { problem: { field: 'amount', message: 'Enter the amount without a sign.' } }
  if (parsed.value === 0) return { problem: { field: 'amount', message: 'Enter an amount.' } }

  return {
    request: {
      seriesId: line.seriesId,
      amount: line.decrease ? -parsed.value : parsed.value,
      date: line.date,
      ...(line.number.trim() !== '' && { number: line.number.trim() }),
      ...(line.memo.trim() !== '' && { memo: line.memo.trim() }),
      ...(line.estimated && line.updateEstimate && { updateEstimate: true })
    }
  }
}

export default function EnterDialog({ input, close }: DialogProps<EnterDialogInput, EnterRequest[]>) {
  const [lines, setLines] = useState<Line[]>(() => input.rows.map((_, index) => lineFrom(input, index)))
  const [problems, setProblems] = useState<Record<string, { field: string, message: string }>>({})

  const set = (seriesId: string, patch: Partial<Line>) =>
    setLines(was => was.map(line => line.seriesId === seriesId ? { ...line, ...patch } : line))

  const single = lines.length === 1
  const estimates = useMemo(() => lines.filter(line => line.estimated).length, [lines])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found: Record<string, { field: string, message: string }> = {}
    const requests: EnterRequest[] = []
    for (const line of lines) {
      const { request, problem } = toRequest(line)
      if (problem) found[line.seriesId] = problem
      else if (request) requests.push(request)
    }
    setProblems(found)
    if (Object.keys(found).length > 0) return
    close(requests)
  }

  const problemFor = (line: Line, field: string) =>
    problems[line.seriesId]?.field === field ? problems[line.seriesId].message : undefined

  return (
    <Box component="form" onSubmit={submit} data-recurring-dialog="enter">
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {single
              ? 'Check the amount and the date before it goes into the register.'
              : `${lines.length} transactions will be written into their registers. Change any amount before they go in.`}
          </Typography>
          {estimates > 0 && (
            <Alert severity="info">
              {estimates === 1 ? 'One of these varies' : `${estimates} of these vary`} from month to month, so the
              amount shown is only an estimate.
            </Alert>
          )}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>What</TableCell>
                <TableCell sx={{ width: 150 }}>Date</TableCell>
                <TableCell sx={{ width: 110 }}>Number</TableCell>
                <TableCell sx={{ width: 150 }} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((line, index) => {
                const columns = AMOUNT_COLUMNS[line.account.type]
                return (
                  <TableRow key={line.seriesId} data-row={line.seriesId}>
                    <TableCell sx={{ verticalAlign: 'top', pt: 2 }}>
                      <Typography variant="body2">{line.name}</Typography>
                      <Typography variant="caption" color="text.secondary" component="div">
                        {[line.account.name, line.payee, line.categoryLabel].filter(Boolean).join(' · ')}
                      </Typography>
                      {line.estimated && (
                        <FormControlLabel
                          sx={{ mt: 0.5 }}
                          control={<Checkbox size="small" checked={line.updateEstimate}
                            onChange={e => set(line.seriesId, { updateEstimate: e.target.checked })} />}
                          label={<Typography variant="caption">Use as the new estimate</Typography>} />
                      )}
                    </TableCell>
                    <TableCell sx={{ verticalAlign: 'top' }}>
                      <TextField
                        type="date" size="small" fullWidth value={line.date}
                        // The occurrence's date, not today's: the transaction is dated for when it fell due
                        onChange={e => set(line.seriesId, { date: e.target.value })}
                        slotProps={{ htmlInput: { 'aria-label': `Date for ${line.name}` } }}
                        error={problemFor(line, 'date') !== undefined}
                        helperText={problemFor(line, 'date')}
                      />
                      <Typography variant="caption" color="text.secondary">{isIsoDate(line.date) ? showDate(line.date) : ''}</Typography>
                    </TableCell>
                    <TableCell sx={{ verticalAlign: 'top' }}>
                      <TextField
                        size="small" fullWidth value={line.number}
                        onChange={e => set(line.seriesId, { number: e.target.value })}
                        slotProps={{ htmlInput: { 'aria-label': `Number for ${line.name}`, maxLength: TRANSACTION_NUMBER_MAX_LENGTH } }}
                      />
                    </TableCell>
                    <TableCell sx={{ verticalAlign: 'top' }}>
                      <TextField
                        size="small" fullWidth value={line.amount} autoFocus={index === 0}
                        onChange={e => set(line.seriesId, { amount: e.target.value })}
                        label={line.decrease ? columns.decrease : columns.increase}
                        slotProps={{ htmlInput: { 'aria-label': `Amount for ${line.name}`, inputMode: 'decimal', style: { textAlign: 'right' } } }}
                        error={problemFor(line, 'amount') !== undefined}
                        helperText={problemFor(line, 'amount') ?? line.account.currency}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          {single && (
            <TextField
              label="Memo" size="small" fullWidth value={lines[0].memo}
              onChange={e => set(lines[0].seriesId, { memo: e.target.value })}
              slotProps={{ htmlInput: { maxLength: MEMO_MAX_LENGTH } }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close(undefined)}>Cancel</Button>
        <Button type="submit" variant="contained">
          {single ? 'Enter in Register' : `Enter ${lines.length} in Registers`}
        </Button>
      </DialogActions>
    </Box>
  )
}
