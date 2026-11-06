// Which account is this statement for? The accounts, best first (the plugin ranks them), a new account made from the
// statement, or skipping it; and whether to remember the answer, which depends on how surely the file names its
// account. See docs/import-manager-design.md, "The Account dialog".
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { ACCOUNT_TYPE_LABELS, maskAccountNumber } from '@tessera/accounts-api'
import type { AccountChoice, AccountDialogInput, AccountDialogResult } from '@tessera/import-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, Divider, FormControlLabel, Radio, RadioGroup, Stack, Typography
} from '@tessera/ui'
import { Amount, count, showPeriod } from './display'

/** The value of the "Create a new account" choice (accounts use their ids). */
export const CREATE = '(create)'

/** What the file says about its account, in a line. */
function describeStatement({ statement }: AccountDialogInput): string {
  const parts = [
    statement.institution ?? (statement.label && !statement.accountNumber ? statement.label : undefined),
    statement.accountNumber && `account ending ${statement.accountNumber.replace(/\D/g, '')}`,
    statement.typeLabel?.toLowerCase(),
    statement.currency
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : "doesn't name its account"
}

function AccountLabel({ choice }: { choice: AccountChoice }) {
  const { account } = choice
  const details = [account.institution, account.accountNumber && maskAccountNumber(account.accountNumber), ACCOUNT_TYPE_LABELS[account.type]]
    .filter(Boolean).join(' · ')
  const note = choice.disabledReason ?? choice.hint
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 2, alignItems: 'baseline', width: '100%' }}>
      <Typography noWrap>{account.name}</Typography>
      <Typography noWrap sx={{ textAlign: 'right' }}>
        <Amount minor={choice.balance} currency={account.currency} /> {account.currency}
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap>{details}</Typography>
      <Typography variant="body2" noWrap sx={{ textAlign: 'right', color: choice.disabledReason ? 'text.disabled' : 'primary.main' }}>
        {note ?? ''}
      </Typography>
    </Box>
  )
}

export default function AccountDialog({ input, close }: DialogProps<AccountDialogInput, AccountDialogResult>) {
  const hasClosed = input.choices.some(c => c.account.closed)
  const [showClosed, setShowClosed] = useState(false)
  const [selected, setSelected] = useState(input.preselectedId ?? (input.choices.some(c => !c.disabledReason) ? '' : CREATE))
  const [remember, setRemember] = useState(input.remember.checked)
  const visible = input.choices.filter(c => showClosed || !c.account.closed)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected === CREATE) close({ kind: 'create', remember })
    else if (selected !== '') close({ kind: 'account', accountId: selected, remember })
  }

  const period = showPeriod(input.statement.period)
  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2}>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5, m: 0, '& dd': { m: 0 } }}>
            <Typography component="dt" color="text.secondary">File</Typography>
            <Typography component="dd">
              {[input.fileName, input.formatLabel, [count(input.statement.lineCount, 'transaction'), period].filter(Boolean).join(', ')].join(' · ')}
            </Typography>
            <Typography component="dt" color="text.secondary">The file</Typography>
            <Typography component="dd">{describeStatement(input)}</Typography>
          </Box>
          {input.note && <Alert severity="warning">{input.note}</Alert>}

          <RadioGroup aria-label="Account" value={selected} onChange={event => setSelected(event.target.value)}>
            {visible.map(choice => (
              <FormControlLabel key={choice.account.id} value={choice.account.id} disabled={choice.disabledReason !== undefined}
                control={<Radio size="small" />} label={<AccountLabel choice={choice} />}
                sx={{ mr: 0, py: 0.25, '& .MuiFormControlLabel-label': { flex: 1, minWidth: 0 } }} />
            ))}
            {visible.length > 0 && <Divider sx={{ my: 0.5 }} />}
            <FormControlLabel value={CREATE} control={<Radio size="small" />}
              label={<Typography>Create a new account…</Typography>} />
          </RadioGroup>

          <Stack>
            {hasClosed && (
              <FormControlLabel control={<Checkbox size="small" checked={showClosed} onChange={event => setShowClosed(event.target.checked)} />}
                label="Show closed accounts" />
            )}
            <FormControlLabel
              control={<Checkbox size="small" checked={remember} onChange={event => setRemember(event.target.checked)} />}
              label={input.remember.label} />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close({ kind: 'skip' })}>Skip This File</Button>
        <Button onClick={() => close()}>Cancel Import</Button>
        <Button type="submit" variant="contained" disabled={selected === ''}>{selected === CREATE ? 'Create…' : 'Import'}</Button>
      </DialogActions>
    </form>
  )
}
