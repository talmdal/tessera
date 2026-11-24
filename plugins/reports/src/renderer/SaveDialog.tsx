// The name of a saved report (phase R4): Save Report As… (the report shown, as shown, saved under it), Rename… and
// Duplicate…. The name is checked as it is typed (the ledger's rules for names, and unique in the ledger, ignoring
// case), then again by the plugin, whose answer (a name taken meanwhile, a ledger open read-only, a report changed
// elsewhere) is shown here, the dialog staying open.
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { nameKey, validateLedgerName } from '@tessera/ledger-api'
import { REPORTS_CHANNELS, type ReportsResult, type SaveDialogInput, type SavedReport } from '@tessera/reports-api'
import { Alert, Button, DialogActions, DialogContent, TextField, Typography } from '@tessera/ui'

const WORDS = {
  saveAs: { intro: 'Saved in this ledger, with what it shows now: its period, accounts and choices.', action: 'Save' },
  rename: { intro: undefined, action: 'Rename' },
  duplicate: { intro: 'A copy, to change apart from the first.', action: 'Duplicate' }
} as const

/** What is wrong with a name, as it is typed; undefined when it will do. */
export function nameProblem(name: string, taken: readonly string[]): string | undefined {
  const problem = validateLedgerName(name)
  if (problem) return problem
  const key = nameKey(name.trim())
  const clash = taken.find(t => nameKey(t) === key)
  return clash ? `There is already a saved report named “${clash}”.` : undefined
}

export default function SaveDialog({ input, close, setBusy }: DialogProps<SaveDialogInput, { id: string }>) {
  const [name, setName] = useState(input.name)
  const [touched, setTouched] = useState(false)
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const problem = nameProblem(name, input.taken)
  const shownProblem = fieldError ?? (touched || name !== input.name ? problem : undefined)
  const words = WORDS[input.mode]

  const submit = async () => {
    setTouched(true)
    if (problem || saving) return
    setSaving(true)
    setBusy(true)
    setError(undefined)
    setFieldError(undefined)
    try {
      const reply = await (input.mode === 'saveAs'
        ? window.api.invoke<ReportsResult<SavedReport>>(REPORTS_CHANNELS.save, { ...input.report, name: name.trim() })
        : input.mode === 'rename'
          ? window.api.invoke<ReportsResult<SavedReport>>(REPORTS_CHANNELS.rename, { id: input.id, name: name.trim(), ...(input.rev !== undefined && { expectedRev: input.rev }) })
          : window.api.invoke<ReportsResult<SavedReport>>(REPORTS_CHANNELS.duplicate, { id: input.id, name: name.trim() }))
      if (reply.ok) { close({ id: reply.value.id }); return }
      const { code, message, field } = reply.error
      if (code === 'CONFLICT') setError('This report was changed elsewhere since it was opened. Close this and try again.')
      else if (field === 'name' || code === 'DUPLICATE_NAME') setFieldError(message)
      else setError(message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <>
      <DialogContent>
        <form id="save-report" onSubmit={event => { event.preventDefault(); void submit() }}>
          {words.intro && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{words.intro}</Typography>}
          <TextField
            autoFocus fullWidth size="small" label="Name" value={name} disabled={saving}
            error={shownProblem !== undefined} helperText={shownProblem ?? ' '}
            onChange={event => { setName(event.target.value); setFieldError(undefined) }}
            onBlur={() => setTouched(true)}
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        </form>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button variant="contained" type="submit" form="save-report" disabled={saving || problem !== undefined}>{words.action}</Button>
      </DialogActions>
    </>
  )
}
