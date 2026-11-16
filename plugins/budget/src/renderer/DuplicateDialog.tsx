// Duplicate Budget…: a copy of a budget, with every line, plan and month's own amount, under a new name. A name taken
// is shown on the field, and the dialog stays.
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { LEDGER_NAME_MAX_LENGTH, validateLedgerName } from '@tessera/ledger-api'
import { BUDGET_CHANNELS, type Budget, type BudgetResult, type DuplicateDialogInput, type DuplicateRequest } from '@tessera/budget-api'
import { Alert, Button, DialogActions, DialogContent, Stack, TextField, Typography } from '@tessera/ui'

export default function DuplicateDialog({ input, close, setBusy }: DialogProps<DuplicateDialogInput, { id: string }>) {
  const [name, setName] = useState(input.name)
  const [touched, setTouched] = useState(false)
  const [server, setServer] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)
  const local = validateLedgerName(name)
  const problem = server?.field === 'name' ? server.message : touched ? local : undefined

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (local || saving) return
    setSaving(true)
    setBusy(true)
    try {
      const request: DuplicateRequest = { id: input.budget.id, name: name.trim() }
      const result = await window.api.invoke<BudgetResult<Budget>>(BUDGET_CHANNELS.duplicate, request)
      if (result.ok) { close({ id: result.value.id }); return }
      setServer(result.error)
    } catch (err) {
      setServer({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            A copy of “{input.budget.name}”, with every line, its plans and each month’s own amount. It covers the same accounts.
          </Typography>
          <TextField autoFocus required size="small" label="Name" value={name}
            onChange={event => { setName(event.target.value); setServer(undefined) }} onBlur={() => setTouched(true)}
            error={problem !== undefined} helperText={problem ?? ' '} slotProps={{ htmlInput: { maxLength: LEDGER_NAME_MAX_LENGTH } }}
            onFocus={event => event.target.select()} />
          {server && server.field !== 'name' && <Alert severity="error">{server.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>Duplicate</Button>
      </DialogActions>
    </form>
  )
}
