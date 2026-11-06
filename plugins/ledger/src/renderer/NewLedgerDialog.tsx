// File › New Ledger…: a name, and where it goes. No parent creates a new ledger file (after the command asks to
// close the open one); a parent creates a sub-ledger inside the open ledger, and no file.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_NAME_MAX_LENGTH, flattenTree, validateLedgerName,
  type NewLedgerDialogInput, type NewLedgerDialogResult, type Result, type SubLedger
} from '@tessera/ledger-api'
import { Alert, Button, DialogActions, DialogContent, MenuItem, Stack, TextField } from '@tessera/ui'

/** Select values: no parent (a new file), the open ledger itself, or a sub-ledger's id. */
export const NO_PARENT = '(none)'
export const LEDGER_ITSELF = '(ledger)'

const toValue = (parentId: string | null | undefined) => parentId === undefined ? NO_PARENT : parentId === null ? LEDGER_ITSELF : parentId

export default function NewLedgerDialog({ input, close, setBusy }: DialogProps<NewLedgerDialogInput, NewLedgerDialogResult>) {
  const { tree } = input
  const [name, setName] = useState('')
  const [parent, setParent] = useState(toValue(input.parentId))
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)

  const options = useMemo(() => [
    { value: NO_PARENT, label: 'None (create a new ledger file)', depth: 0 },
    { value: LEDGER_ITSELF, label: tree.ledger.name, depth: 0 },
    ...flattenTree(tree.subLedgers).map(({ subLedger, depth }) => ({ value: subLedger.id, label: subLedger.name, depth: depth + 1 }))
  ], [tree])

  const nameProblem = validateLedgerName(name)
  const nameError = serverError?.field === 'name' ? serverError.message : touched ? nameProblem : undefined
  const parentName = options.find(o => o.value === parent)?.label ?? tree.ledger.name

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (nameProblem || saving) return
    if (parent === NO_PARENT) {
      close({ kind: 'file', name: name.trim() })
      return
    }

    setSaving(true)
    setBusy(true)
    setServerError(undefined)
    try {
      const result = await window.api.invoke<Result<SubLedger>>(LEDGER_CHANNELS.createSubLedger, {
        name, parentId: parent === LEDGER_ITSELF ? null : parent
      })
      if (result.ok) { close({ kind: 'subLedger', id: result.value.id }); return }
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
            onBlur={() => setTouched(true)}
            error={nameError !== undefined}
            helperText={nameError ?? (parent === NO_PARENT ? 'Also the suggested file name.' : ' ')}
            slotProps={{ htmlInput: { maxLength: LEDGER_NAME_MAX_LENGTH } }}
          />
          <TextField
            select
            size="small"
            label="Parent ledger"
            value={parent}
            onChange={event => { setParent(event.target.value); setServerError(undefined) }}
            helperText={parent === NO_PARENT
              ? `Closes “${tree.ledger.name}” and creates a new ledger file.`
              : `Created inside “${parentName}”, in the same file.`}
          >
            {options.map(option => (
              <MenuItem key={option.value} value={option.value} sx={{ pl: 2 + option.depth * 2 }}>{option.label}</MenuItem>
            ))}
          </TextField>
          {serverError && serverError.field !== 'name' && <Alert severity="error">{serverError.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>{parent === NO_PARENT ? 'Create…' : 'Create'}</Button>
      </DialogActions>
    </form>
  )
}
