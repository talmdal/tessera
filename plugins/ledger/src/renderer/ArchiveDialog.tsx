// File › Archive Ledger…: what archiving does, in the words agreed for it; the date to archive before; what that would
// archive, what stays and why, and the choices it offers; where the archive file goes. The dialog runs the archive
// itself, so it can show each step until it is done. See docs/ledger-compaction-design.md, "The Archive Ledger dialog".
import { FormEvent, useEffect, useId, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_EVENTS, displayDate,
  type ArchiveDialogInput, type ArchiveDialogResult, type ArchiveOutcome, type ArchivePreview, type ArchiveProgress, type Result
} from '@tessera/ledger-api'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, DialogContent, FormControlLabel, Stack, TextField, Typography
} from '@tessera/ui'

/** How long the dialog waits after the date or an option changes before it asks what that would archive. */
export const PREVIEW_AFTER_MS = 300

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** "9 Nov 2026", for when the last archive was made. */
const onDay = (iso: string) => new Date(iso).toLocaleDateString([], { dateStyle: 'medium' })

const message = (err: unknown) => String((err as Error)?.message ?? err)

/** A step of the archive, as the dialog says it. */
export function stepText(progress: ArchiveProgress | undefined, ledgerName: string): string {
  switch (progress?.step) {
    case 'copying': return progress.done !== undefined && progress.done > 0 ? `Copying “${ledgerName}”… ${Math.round(progress.done * 100)}%` : `Copying “${ledgerName}”…`
    case 'checking': return 'Checking the copy…'
    case 'removing': return 'Removing archived transactions…'
    case 'compacting': return `Compacting “${ledgerName}”…`
    default: return 'Archiving…'
  }
}

export default function ArchiveDialog({ input, close, setBusy }: DialogProps<ArchiveDialogInput, ArchiveDialogResult>) {
  const [before, setBefore] = useState(input.suggestedBefore)
  /** What the user chose for each option; an option not chosen takes its default. */
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<ArchivePreview>()
  const [dateError, setDateError] = useState<string>()
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ArchiveProgress>()
  const dateLabel = useId()

  const offered = useMemo(() => (preview?.parts ?? []).flatMap(part => part.options ?? []), [preview])
  /** Every option offered, with the user's choice or its default. */
  const options = useMemo(() => Object.fromEntries(offered.map(o => [o.id, chosen[o.id] ?? o.default])), [offered, chosen])
  const problem = !ISO_DATE.test(before) ? 'Enter a date.' : before > input.today ? 'Choose today or a date before it.' : undefined

  useEffect(() => window.api.on<ArchiveProgress>(LEDGER_EVENTS.archiveProgress, setProgress), [])

  // What archiving before the date would do: asked a moment after the date or an option last changed
  const chosenKey = JSON.stringify(chosen)
  useEffect(() => {
    setDateError(problem)
    if (problem) { setPreview(undefined); return }
    let live = true
    const timer = setTimeout(() => {
      window.api.invoke<Result<ArchivePreview>>(LEDGER_CHANNELS.archivePreview, { before, options: chosen }).then(result => {
        if (!live) return
        if (result.ok) { setPreview(result.value); setError(undefined) }
        else if (result.error.field === 'before') { setPreview(undefined); setDateError(result.error.message) }
        else { setPreview(undefined); setError(result.error.message) }
      }, err => { if (live) setError(message(err)) })
    }, PREVIEW_AFTER_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [before, chosenKey, problem])

  const current = preview?.before === before ? preview : undefined
  const summaries = (current?.parts ?? []).filter(part => part.count > 0).map(part => part.summary)
  const notes = (current?.parts ?? []).flatMap(part => part.notes ?? [])
  const warnings = (current?.parts ?? []).flatMap(part => part.warnings ?? [])
  const canArchive = !running && !problem && current !== undefined && current.count > 0

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canArchive) return
    setRunning(true)
    setBusy(true)
    setError(undefined)
    setProgress(undefined)
    try {
      const result = await window.api.invoke<Result<ArchiveOutcome>>(LEDGER_CHANNELS.archiveRun, { before, options })
      if (result.ok) { close(result.value); return }
      if (result.error.field === 'before') setDateError(result.error.message)
      else setError(result.error.message)
    } catch (err) {
      setError(message(err))
    } finally {
      setRunning(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography>
            During the archival process, Tessera makes a copy of your current ledger. Then within the current ledger,
            Tessera removes transactions that are no longer required.
          </Typography>
          <Typography>To access the archived transactions later, you can open the archive file.</Typography>

          <Box>
            <Typography id={dateLabel} sx={{ mb: 1 }}>Tessera will archive transactions that occurred before</Typography>
            <TextField
              type="date" size="small" value={before} disabled={running}
              onChange={event => setBefore(event.target.value)}
              error={dateError !== undefined}
              helperText={dateError ?? (input.lastArchive
                ? `Last archived on ${onDay(input.lastArchive.archivedAt)}, before ${displayDate(input.lastArchive.before)}.`
                : ' ')}
              slotProps={{ htmlInput: { 'aria-labelledby': dateLabel, max: input.today } }}
            />
          </Box>

          <Box aria-live="polite" aria-label="What will be archived" role="region">
            {!problem && !current && !error && <Typography variant="body2" color="text.secondary">Looking at what there is to archive…</Typography>}
            {current && (
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 600 }}>
                  {current.count > 0 ? `${summaries.join('; ')} will be archived.` : `Nothing to archive before ${displayDate(current.before)}.`}
                </Typography>
                {notes.map(note => <Typography key={note} variant="body2" color="text.secondary">{note}</Typography>)}
                {warnings.map(warning => (
                  <Alert key={warning.message} severity="warning">
                    <Typography variant="body2">{warning.message}</Typography>
                    {(warning.details ?? []).map(detail => <Typography key={detail} variant="body2">{detail}</Typography>)}
                  </Alert>
                ))}
                {offered.map(option => (
                  <FormControlLabel
                    key={option.id} label={option.label} disabled={running}
                    control={<Checkbox size="small" checked={options[option.id] ?? option.default}
                      onChange={event => setChosen(all => ({ ...all, [option.id]: event.target.checked }))} />}
                  />
                ))}
                {current.count > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    The archive file is saved as “{current.copy.name}” in “{current.copy.folder}”.
                  </Typography>
                )}
              </Stack>
            )}
          </Box>

          {running && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }} role="status" aria-live="polite">
              {/* A CSS animation: it keeps moving while the main process is busy */}
              <CircularProgress size={20} {...(progress?.step === 'copying' && progress.done !== undefined && { variant: 'determinate' as const, value: progress.done * 100 })} />
              <Typography variant="body2">{stepText(progress, input.ledgerName)}</Typography>
            </Stack>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={running}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={!canArchive}>Archive</Button>
      </DialogActions>
    </form>
  )
}
