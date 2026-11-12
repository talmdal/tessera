// Amounts Reversed?: a statement's amounts look the wrong way round for its account (the sign cross-check found
// evidence, once the account was known). It says why, shows a line or two both ways in the account's own terms, and
// asks. Reverse is chosen to begin with, as the evidence points that way; the answer can be remembered for the source.
// See docs/import-formats-design.md, "Sign cross-check".
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { formatAmount } from '@tessera/accounts-api'
import type { SignsDialogInput, SignsDialogResult } from '@tessera/import-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, Radio, RadioGroup, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, Typography
} from '@tessera/ui'
import { showDate } from './display'

/** An amount in the register's terms: 'Charge 128.44', 'Payment 540.00'. */
export function inColumn(input: Pick<SignsDialogInput, 'columns' | 'currency'>, minor: number): string {
  const name = minor < 0 ? input.columns.decrease : input.columns.increase
  return `${name} ${formatAmount(minor, input.currency, { sign: 'never', currency: false })}`
}

export default function SignsDialog({ input, close }: DialogProps<SignsDialogInput, SignsDialogResult>) {
  const [choice, setChoice] = useState<'reverse' | 'keep'>('reverse')
  const [remember, setRemember] = useState(true)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    close({ reverse: choice === 'reverse', remember })
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2}>
          <Box>
            <Typography id="signs-why">
              The amounts in {input.fileName} may be the wrong way round for “{input.accountName}” ({input.accountTypeLabel.toLowerCase()}):
            </Typography>
            <Box component="ul" aria-labelledby="signs-why" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
              {input.reasons.map(reason => <li key={reason}><Typography>{reason}</Typography></li>)}
            </Box>
          </Box>
          {input.correctedSince && <Alert severity="info">{input.correctedSince}</Alert>}

          {input.examples.length > 0 && (
            <Table size="small" aria-label="Lines both ways">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Payee</TableCell>
                  <TableCell>As they are</TableCell>
                  <TableCell>Reversed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {input.examples.map(example => (
                  <TableRow key={`${example.date} ${example.payee} ${example.amount}`}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{showDate(example.date)}</TableCell>
                    <TableCell>{example.payee ?? ''}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{inColumn(input, example.amount)}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{inColumn(input, -example.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <RadioGroup aria-label="The amounts" value={choice} onChange={event => setChoice(event.target.value as 'reverse' | 'keep')}>
            <FormControlLabel value="reverse" control={<Radio size="small" />} label="Reverse the amounts" />
            <FormControlLabel value="keep" control={<Radio size="small" />} label="Import them as they are" />
          </RadioGroup>
          <FormControlLabel
            control={<Checkbox size="small" checked={remember} onChange={event => setRemember(event.target.checked)} />}
            label={input.rememberLabel} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel Import</Button>
        <Button type="submit" variant="contained">Continue</Button>
      </DialogActions>
    </form>
  )
}
