// Renames a sub-ledger. Saves itself, so a duplicate name is shown here and the dialog stays open.
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_NAME_MAX_LENGTH, validateLedgerName,
  type RenameSubLedgerDialogInput, type Result, type SubLedger
} from '@tessera/ledger-api'
import { Alert, Button, DialogActions, DialogContent, Stack, TextField } from '@tessera/ui'

export default function RenameDialog({ input, close, setBusy }: DialogProps<RenameSubLedgerDialogInput, { id: string }>) {
  const [name, setName] = useState(input.name)
  const [serverError, setServerError] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)

  const problem = validateLedgerName(name)
  const nameError = serverError?.field === 'name' ? serverError.message : problem

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (problem || saving) return
    if (name.trim() === input.name) { close({ id: input.id }); return }

    setSaving(true)
    setBusy(true)
    try {
      const result = await window.api.invoke<Result<SubLedger>>(LEDGER_CHANNELS.renameSubLedger, { id: input.id, name, expectedRev: input.rev })
      if (result.ok) { close({ id: result.value.id }); return }
      setServerError(result.error)
    } catch (err) {
      setServerError({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            autoFocus
            required
            size="small"
            label="Name"
            value={name}
            onChange={event => { setName(event.target.value); setServerError(undefined) }}
            error={nameError !== undefined}
            helperText={nameError ?? ' '}
            slotProps={{ htmlInput: { maxLength: LEDGER_NAME_MAX_LENGTH } }}
          />
          {serverError && serverError.field !== 'name' && <Alert severity="error">{serverError.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving || problem !== undefined}>Rename</Button>
      </DialogActions>
    </form>
  )
}
