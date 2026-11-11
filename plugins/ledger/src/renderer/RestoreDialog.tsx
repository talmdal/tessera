// File › Restore Ledger…: choose a backup (those in the default backup folder, or Browse… for another), then restore
// it as a new ledger, or in its ledger's place with the current file kept under another name. Nothing is ever
// replaced or deleted. The dialog runs the restore itself, so it can show each step until the ledger is open.
import { FormEvent, useEffect, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_EVENTS, LEDGER_FILE_EXTENSION, validateLedgerFileName,
  type BackupInfo, type RestoreDialogInput, type RestoreDialogResult, type RestoreOutcome, type RestorePlan,
  type RestoreProgress, type RestoreRequest, type Result
} from '@tessera/ledger-api'
import {
  Alert, Box, Button, CircularProgress, DialogActions, DialogContent, FormControlLabel, List, ListItemButton,
  ListItemText, Radio, RadioGroup, Stack, TextField, Typography
} from '@tessera/ui'

type Mode = 'new' | 'inPlace'
type FieldErrors = Partial<Record<'name' | 'folder' | 'keepAs', string>>

const KIND: Record<BackupInfo['kind'], string> = {
  manual: 'Backed up by hand',
  auto: 'Backed up automatically',
  ledger: 'A ledger file, last changed'
}

/** "9 Nov 2026, 10:14". */
export const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** The list's order: newest first, as the privileged side lists them, kept as backups are added. */
const newestFirst = (list: BackupInfo[]) => [...list].sort((a, b) => b.takenAt.localeCompare(a.takenAt))

const message = (err: unknown) => String((err as Error)?.message ?? err)

export default function RestoreDialog({ input, close, setBusy }: DialogProps<RestoreDialogInput, RestoreDialogResult>) {
  const [folder, setListedFolder] = useState<string>()
  const [backups, setBackups] = useState<BackupInfo[]>()
  const [selected, setSelected] = useState<string | undefined>(input.preselect)
  const [plan, setPlan] = useState<RestorePlan>()
  const [mode, setMode] = useState<Mode>('new')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [keepAs, setKeepAs] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RestoreProgress>()

  /** Adds (or refreshes) a backup in the list. */
  const upsert = (info: BackupInfo) => setBackups(list => newestFirst([info, ...(list ?? []).filter(b => b.path !== info.path)]))

  useEffect(() => {
    let live = true
    window.api.invoke<{ folder: string, backups: BackupInfo[] }>(LEDGER_CHANNELS.restoreList).then(({ folder, backups }) => {
      if (!live) return
      setListedFolder(folder)
      setBackups(current => newestFirst([...backups, ...(current ?? []).filter(b => !backups.some(l => l.path === b.path))]))
      setSelected(chosen => chosen ?? backups.find(b => !b.problem)?.path)
    }, err => { if (live) setError(message(err)) })
    return () => { live = false }
  }, [])

  useEffect(() => window.api.on<RestoreProgress>(LEDGER_EVENTS.restoreProgress, setProgress), [])

  // How the chosen backup can be restored, with its suggested names
  useEffect(() => {
    if (selected === undefined) return
    let live = true
    setPlan(undefined)
    setFieldErrors({})
    setError(undefined)
    window.api.invoke<Result<RestorePlan>>(LEDGER_CHANNELS.restorePlan, { path: selected }).then(result => {
      if (!live) return
      if (!result.ok) { setError(result.error.message); return }
      const next = result.value
      upsert(next.backup)
      setPlan(next)
      setName(next.asNew.name)
      setTarget(next.asNew.folder)
      setKeepAs('keepAs' in next.inPlace ? next.inPlace.keepAs ?? '' : '')
      setMode(current => current === 'inPlace' && 'unavailable' in next.inPlace ? 'new' : current)
    }, err => { if (live) setError(message(err)) })
    return () => { live = false }
  }, [selected])

  const browse = async () => {
    setError(undefined)
    try {
      const result = await window.api.invoke<Result<BackupInfo | undefined>>(LEDGER_CHANNELS.restoreBrowse)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value) { upsert(result.value); setSelected(result.value.path) }
    } catch (err) {
      setError(message(err))
    }
  }

  const changeFolder = async () => {
    try {
      const chosen = await window.api.invoke<string | undefined>(LEDGER_CHANNELS.restoreFolder, { defaultPath: target })
      if (chosen) { setTarget(chosen); setFieldErrors(errors => ({ ...errors, folder: undefined, name: undefined })) }
    } catch (err) {
      setError(message(err))
    }
  }

  const inPlace = plan && !('unavailable' in plan.inPlace) ? plan.inPlace : undefined
  const chosen = backups?.find(b => b.path === selected)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!plan || running || chosen?.problem) return
    const problems: FieldErrors = mode === 'new'
      ? { name: validateLedgerFileName(name) }
      : { keepAs: inPlace?.keepAs !== undefined ? validateLedgerFileName(keepAs) : undefined }
    if (Object.values(problems).some(Boolean)) { setFieldErrors(problems); return }

    const request: RestoreRequest = mode === 'new'
      ? { backup: plan.backup.path, mode: 'new', folder: target, name: name.trim() }
      : { backup: plan.backup.path, mode: 'inPlace', ...(inPlace?.keepAs !== undefined && { keepAs: keepAs.trim() }) }
    setRunning(true)
    setBusy(true)
    setError(undefined)
    setFieldErrors({})
    setProgress(undefined)
    try {
      const result = await window.api.invoke<Result<RestoreOutcome>>(LEDGER_CHANNELS.restoreRun, request)
      if (result.ok) { close({ ...result.value, takenAt: plan.backup.takenAt }); return }
      const { field, message: text } = result.error
      if (field === 'name' || field === 'folder' || field === 'keepAs') setFieldErrors({ [field]: text })
      else setError(text)
    } catch (err) {
      setError(message(err))
    } finally {
      setRunning(false)
      setBusy(false)
      setProgress(undefined)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box>
            <Typography variant="subtitle2" component="h3">Choose a backup</Typography>
            <Typography variant="body2" color="text.secondary">
              {folder ? `In “${folder}”, newest first.` : 'Looking for backups…'}
            </Typography>
          </Box>
          {backups && backups.length === 0 && (
            <Typography variant="body2" color="text.secondary">There are no backups here. Choose one somewhere else with Browse….</Typography>
          )}
          {backups && backups.length > 0 && (
            <List dense aria-label="Backups" sx={{ maxHeight: 240, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, py: 0 }}>
              {backups.map(backup => (
                <ListItemButton
                  key={backup.path}
                  selected={backup.path === selected}
                  disabled={running}
                  onClick={() => setSelected(backup.path)}
                  aria-label={`“${backup.ledgerName}”, ${when(backup.takenAt)}`}
                >
                  <ListItemText
                    primary={`“${backup.ledgerName}” — ${when(backup.takenAt)}`}
                    secondary={backup.problem ?? `${KIND[backup.kind]} · ${size(backup.size)}`}
                    slotProps={{ secondary: backup.problem ? { color: 'error' } : {} }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
          <Box>
            <Button size="small" onClick={browse} disabled={running}>Browse…</Button>
          </Box>

          {plan && !chosen?.problem && (
            <RadioGroup aria-label="Restore it as" value={mode} onChange={event => setMode(event.target.value as Mode)}>
              <Typography variant="subtitle2" component="h3">Restore it as</Typography>

              <FormControlLabel value="new" control={<Radio size="small" />} label="A new ledger" disabled={running} />
              {mode === 'new' && (
                <Stack spacing={1.5} sx={{ pl: 4, pb: 1 }}>
                  <TextField
                    size="small" label="Name" value={name} disabled={running} required
                    onChange={event => { setName(event.target.value); setFieldErrors(errors => ({ ...errors, name: undefined })) }}
                    error={fieldErrors.name !== undefined}
                    helperText={fieldErrors.name ?? `Saved as “${name.trim()}${LEDGER_FILE_EXTENSION}”.`}
                  />
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <TextField
                      size="small" label="Folder" value={target} fullWidth disabled={running}
                      slotProps={{ htmlInput: { readOnly: true } }}
                      error={fieldErrors.folder !== undefined} helperText={fieldErrors.folder ?? ' '}
                    />
                    <Button onClick={changeFolder} disabled={running} sx={{ mt: 0.25, flexShrink: 0 }}>Change…</Button>
                  </Stack>
                </Stack>
              )}

              <FormControlLabel
                value="inPlace" control={<Radio size="small" />} disabled={running || !inPlace}
                label={inPlace ? `In place of “${inPlace.name}”` : `In place of “${plan.backup.ledgerName}”`}
              />
              {!inPlace && 'unavailable' in plan.inPlace && (
                <Typography variant="body2" color="text.secondary" sx={{ pl: 4 }}>{plan.inPlace.unavailable}</Typography>
              )}
              {inPlace && mode === 'inPlace' && (
                <Stack spacing={1} sx={{ pl: 4 }}>
                  {inPlace.keepAs !== undefined && (
                    <TextField
                      size="small" label="Keep the current file as" value={keepAs} disabled={running} required
                      onChange={event => { setKeepAs(event.target.value); setFieldErrors(errors => ({ ...errors, keepAs: undefined })) }}
                      error={fieldErrors.keepAs !== undefined}
                      helperText={fieldErrors.keepAs
                        ?? `“${inPlace.name}${LEDGER_FILE_EXTENSION}” is renamed to “${keepAs.trim()}${LEDGER_FILE_EXTENSION}”, and the backup takes its name. Nothing is deleted.`}
                    />
                  )}
                  {inPlace.isOpen && (
                    <Typography variant="body2" color="text.secondary">
                      “{inPlace.name}” is open: it closes, and opens again as it was in this backup.
                    </Typography>
                  )}
                </Stack>
              )}
            </RadioGroup>
          )}

          {running && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }} role="status" aria-live="polite">
              {/* A CSS animation: it keeps moving while the main process is busy opening the ledger */}
              <CircularProgress size={20} {...(progress?.done !== undefined && { variant: 'determinate' as const, value: progress.done * 100 })} />
              <Typography variant="body2">{progress ? `${progress.step}…` : 'Restoring…'}</Typography>
            </Stack>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={running}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={running || !plan || chosen?.problem !== undefined}>Restore</Button>
      </DialogActions>
    </form>
  )
}
