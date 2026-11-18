// Which account a statement belongs to, when nothing saved or printed on it settles the question: pick one of
// the book's accounts, or create a new one prefilled from the statement. The choice can be remembered, so the
// next import of this source asks nothing.
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { ChooseAccountInput, ChooseAccountResult } from '@tessera/exchange-api'
import {
  Button, Checkbox, DialogActions, DialogContent, FormControlLabel, List, ListItemButton, ListItemIcon,
  ListItemText, Radio, Stack, Typography
} from '@tessera/ui'
import { maskNumber } from './display'

const CREATE = '::create::'

export default function ChooseAccountDialog({ input, close }: DialogProps<ChooseAccountInput, ChooseAccountResult>) {
  const [chosen, setChosen] = useState<string>()
  const [remember, setRemember] = useState(true)

  const usable = (currency: string) => input.currency === undefined || currency === input.currency

  const confirm = () => {
    if (chosen === undefined) return
    close(chosen === CREATE
      ? { kind: 'create', remember }
      : { kind: 'existing', accountId: chosen, remember })
  }

  return (
    <>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2">
          {input.statement} in “{input.fileName}” is not linked to an account in this book yet. Choose the
          account its transactions belong to{input.canCreate ? ', or create a new one filled in from the statement' : ''}.
        </Typography>

        <List dense sx={{ maxHeight: 360, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
          aria-label="Accounts">
          {input.accounts.map(account => {
            const disabled = !usable(account.currency)
            const detail = [
              maskNumber(account.number),
              disabled ? `${account.currency}, but the statement is ${input.currency}` : undefined,
              account.closed ? 'closed' : undefined
            ].filter(Boolean).join(' · ')
            return (
              <ListItemButton key={account.id} disabled={disabled} selected={chosen === account.id}
                onClick={() => setChosen(account.id)} onDoubleClick={() => { setChosen(account.id); if (!disabled) confirm() }}
                data-account={account.id}>
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <Radio edge="start" size="small" checked={chosen === account.id} tabIndex={-1} disableRipple
                    slotProps={{ input: { 'aria-label': `Use ${account.name}` } }} />
                </ListItemIcon>
                <ListItemText primary={account.name} secondary={detail === '' ? undefined : detail} />
              </ListItemButton>
            )
          })}
          {input.canCreate && (
            <ListItemButton selected={chosen === CREATE} onClick={() => setChosen(CREATE)} data-account="create">
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Radio edge="start" size="small" checked={chosen === CREATE} tabIndex={-1} disableRipple
                  slotProps={{ input: { 'aria-label': 'Create a new account' } }} />
              </ListItemIcon>
              <ListItemText primary="Create a new account…"
                secondary="Opens the New Account dialog, filled in from the statement" />
            </ListItemButton>
          )}
        </List>

        <Stack direction="row">
          <FormControlLabel
            control={<Checkbox checked={remember} onChange={event => setRemember(event.target.checked)} />}
            label="Remember this choice for this statement source"
          />
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={() => close()}>Skip This Statement</Button>
        <Button variant="contained" disabled={chosen === undefined} onClick={confirm} data-account-confirm>
          {chosen === CREATE ? 'Create Account…' : 'Use This Account'}
        </Button>
      </DialogActions>
    </>
  )
}
