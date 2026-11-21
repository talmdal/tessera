// File › Archive…: pick the cut-off, see exactly what would be removed, and run it. The dialog only gathers and
// shows; the confirmation, the optional backup and the archive happen in the main process (book:archive.run).
// See docs/archive-design.md, "The Archive dialog".
import { useEffect, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  BOOK_CHANNELS,
  type ArchiveDialogInput, type ArchiveOutcome, type ArchivePlan, type Result
} from '@tessera/book-api'
import {
  Alert, Box, Button, Checkbox, CircularProgress, Collapse, DialogActions, DialogContent, Divider, FormControlLabel,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography
} from '@tessera/ui'

/** `2026-01-01` → `1 Jan 2026` (locale-dependent), read as a local date so it is never a day out. */
export function dateText(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** Why a cut-off can't be used, or undefined when it can. The same checks the main process makes, said early. */
export function dateProblem(before: string, input: Pick<ArchiveDialogInput, 'today' | 'lastArchivedThrough'>): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return 'Enter a date.'
  if (before > input.today) return 'This date is in the future. Archive up to today at most.'
  if (input.lastArchivedThrough !== undefined && before <= input.lastArchivedThrough) {
    return `Already archived through ${dateText(input.lastArchivedThrough)}. Choose a later date.`
  }
  return undefined
}

/** The file name the archive will get (a counter is added if it is taken). Display only: the writer decides. */
const suggestedName = (bookName: string, before: string) => `${bookName} Archive through ${before}.tessera`

export default function ArchiveDialog({ input, close, setBusy }: DialogProps<ArchiveDialogInput, ArchiveOutcome>) {
  const [before, setBefore] = useState(input.suggested)
  const [folder, setFolder] = useState(input.folder)
  const [backupFirst, setBackupFirst] = useState(input.backupStale)
  const [plan, setPlan] = useState<ArchivePlan | undefined>()
  const [planning, setPlanning] = useState(false)
  const [details, setDetails] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [running, setRunning] = useState(false)

  const problem = useMemo(() => dateProblem(before, input), [before, input])

  // The plan follows the date; an answer for a date the user has moved on from is dropped
  useEffect(() => {
    if (problem !== undefined) { setPlan(undefined); return }
    let live = true
    setPlanning(true)
    window.api.invoke<Result<ArchivePlan>>(BOOK_CHANNELS.archivePlan, { before }).then(
      result => {
        if (!live) return
        setPlanning(false)
        if (result.ok) { setPlan(result.value); setError(undefined) }
        else { setPlan(undefined); setError(result.error.message) }
      },
      err => { if (live) { setPlanning(false); setPlan(undefined); setError(err instanceof Error ? err.message : String(err)) } })
    return () => { live = false }
  }, [before, problem])

  const browse = async () => {
    const chosen = await window.api.invoke<string | undefined>(BOOK_CHANNELS.chooseFolder, {
      current: folder, defaultPath: folder, title: 'Choose Archive Folder'
    })
    if (chosen !== undefined) setFolder(chosen)
  }

  const run = async () => {
    setRunning(true)
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.api.invoke<Result<ArchiveOutcome | null>>(BOOK_CHANNELS.archiveRun, { before, folder, backupFirst })
      if (!result.ok) setError(result.error.message)
      else if (result.value !== null) close(result.value)      // null: cancelled at the confirmation — stay open
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setBusy(false)
    }
  }

  const ready = problem === undefined && plan !== undefined && plan.blocker === undefined && plan.documents > 0 && !running

  return (
    <>
      <DialogContent>
        <Stack sx={{ gap: 2, pt: 0.5 }}>
          <TextField
            size="small" type="date" label="Archive data before" value={before}
            onChange={event => setBefore(event.target.value)}
            error={problem !== undefined} helperText={problem ?? 'Transactions before this date that are reconciled or voided are removed and kept in the archive.'}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: input.today, 'data-testid': 'archive-before' } }}
          />

          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-all' }} data-testid="archive-file">
              “{suggestedName(input.book.name, before)}” in {folder}
            </Typography>
            <Button size="small" variant="outlined" onClick={() => { void browse() }}>Browse…</Button>
          </Stack>

          <Divider />

          {error && <Alert severity="error">{error}</Alert>}
          {plan?.blocker !== undefined && <Alert severity="warning" data-testid="archive-blocker">{plan.blocker}</Alert>}

          {planning
            ? <Stack sx={{ alignItems: 'center', p: 1 }}><CircularProgress size={24} aria-label="Working out what would be removed" /></Stack>
            : plan && plan.blocker === undefined && (
              <Stack sx={{ gap: 1 }} data-testid="archive-plan">
                {plan.documents === 0
                  ? <Typography variant="body2" color="text.secondary">
                      There is nothing to archive before {dateText(before)}: everything is either recent or not yet reconciled.
                    </Typography>
                  : <Typography variant="body2">
                      {plan.parts.filter(part => part.documents > 0).map(part => part.describe).join(', ')} will be removed
                      and kept in the archive. <strong>No account’s balance changes.</strong>
                    </Typography>}

                {plan.warnings.map((warning, at) => (
                  <Alert key={at} severity="warning" sx={{ py: 0 }}>{warning.message}</Alert>
                ))}

                {plan.rows.length > 0 && (
                  <Box>
                    <Button size="small" onClick={() => setDetails(open => !open)} aria-expanded={details}>
                      {details ? 'Hide details' : 'Details…'}
                    </Button>
                    <Collapse in={details}>
                      <Table size="small" aria-label="What each account is left with">
                        <TableHead>
                          <TableRow>
                            <TableCell>Account</TableCell>
                            <TableCell align="right">Removed</TableCell>
                            <TableCell>Afterwards</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {plan.rows.map(row => (
                            <TableRow key={`${row.contributor}:${row.id}`}>
                              <TableCell>{row.label}</TableCell>
                              <TableCell align="right">{row.removed.toLocaleString()}</TableCell>
                              <TableCell>{row.detail}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Collapse>
                  </Box>
                )}
              </Stack>
            )}

          {input.backupStale && (
            <FormControlLabel
              control={<Checkbox checked={backupFirst} onChange={event => setBackupFirst(event.target.checked)} />}
              label={`Back up “${input.book.name}” first`}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" color="error" disabled={!ready} onClick={() => { void run() }}>
          {running ? 'Archiving…' : 'Archive'}
        </Button>
      </DialogActions>
    </>
  )
}
