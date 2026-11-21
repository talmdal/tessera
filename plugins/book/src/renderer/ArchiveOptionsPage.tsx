// Tools ▸ Options ▸ Book ▸ Archive. The page edits the shared options draft; book history is read-only status.
import { useEffect, useState } from 'react'
import type { OptionsPageProps } from '@tessera/types'
import {
  ARCHIVE_SUGGESTIONS, BOOK_CHANNELS, BOOK_EVENTS, validateBookOptions, suggestedCutoff,
  type ArchiveOptionsStatus, type ArchiveSuggestion, type BookArchiveOptions, type BookOptions, type BookState
} from '@tessera/book-api'
import { Alert, Button, Checkbox, Divider, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@tessera/ui'
import { useFollowed } from './bridge'

const SUGGESTION_LABELS: Record<ArchiveSuggestion, string> = {
  startOfThisYear: 'Start of this year',
  startOfLastYear: 'Start of last year',
  oneYearAgo: 'One year ago',
  twoYearsAgo: 'Two years ago'
}

/** `2026-01-01` → `1 Jan 2026`, read locally so it is never shifted a day by UTC. */
function dateText(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ArchiveOptionsPage({ value, onChange, onValidityChange, disabled }: OptionsPageProps<BookOptions>) {
  const archive = value.archive
  const book = useFollowed<BookState>(BOOK_CHANNELS.state, BOOK_EVENTS.state)
  const [status, setStatus] = useState<ArchiveOptionsStatus>()
  const [statusError, setStatusError] = useState<string>()
  const [browseError, setBrowseError] = useState<string>()
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    let live = true
    window.api.invoke<ArchiveOptionsStatus>(BOOK_CHANNELS.archiveStatus).then(
      next => { if (live) { setStatus(next); setStatusError(undefined) } },
      err => { if (live) setStatusError(`The archive folder could not be loaded: ${err instanceof Error ? err.message : String(err)}`) }
    )
    return () => { live = false }
  }, [])

  const update = (patch: Partial<BookArchiveOptions>) => {
    const next = { ...value, archive: { ...archive, ...patch } }
    onChange(next)
    onValidityChange(validateBookOptions(next).length === 0)
  }

  const browse = async () => {
    setBrowseError(undefined)
    setBrowsing(true)
    try {
      const chosen = await window.api.invoke<string | undefined>(BOOK_CHANNELS.chooseFolder, {
        current: archive.folder,
        defaultPath: status?.defaultFolder,
        title: 'Choose Archive Folder'
      })
      if (chosen !== undefined) update({ folder: chosen })
    } catch (err) {
      setBrowseError(`The folder could not be chosen: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBrowsing(false)
    }
  }

  const folderShown = archive.folder ?? status?.defaultFolder
  const today = new Date()

  return (
    <Stack sx={{ gap: 2.5, maxWidth: 620 }} data-options-page="book.options.archive">
      <Stack sx={{ gap: 1 }}>
        <TextField
          size="small" select label="Suggest archiving data before" sx={{ maxWidth: 420 }}
          value={archive.suggest} disabled={disabled}
          onChange={event => update({ suggest: event.target.value as ArchiveSuggestion })}
          helperText="This is a rule, so its date updates each year. You can change the date in the Archive dialog."
          slotProps={{ htmlInput: { 'aria-label': 'Suggest archiving data before' } }}>
          {ARCHIVE_SUGGESTIONS.map(rule => (
            <MenuItem key={rule} value={rule}>{SUGGESTION_LABELS[rule]} — {dateText(suggestedCutoff(rule, today))}</MenuItem>
          ))}
        </TextField>
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Keep archives in</Typography>
        <Typography variant="body2" sx={{ wordBreak: 'break-all' }} data-testid="archive-folder">
          {folderShown ?? 'Tessera Archives, in your Documents folder'}
          {archive.folder === null && <Typography component="span" variant="body2" color="text.secondary"> (the default)</Typography>}
        </Typography>
        <Stack direction="row" sx={{ gap: 1 }}>
          <Button size="small" variant="outlined" disabled={disabled || browsing || status === undefined} onClick={() => { void browse() }}>Browse…</Button>
          <Button size="small" disabled={disabled || archive.folder === null} onClick={() => update({ folder: null })}>Use Default</Button>
        </Stack>
        {browseError && <Alert severity="error" variant="outlined">{browseError}</Alert>}
        {statusError && (
          <Alert severity="error" variant="outlined" action={
            <Button size="small" onClick={() => {
              setStatusError(undefined)
              window.api.invoke<ArchiveOptionsStatus>(BOOK_CHANNELS.archiveStatus).then(
                setStatus,
                err => setStatusError(`The archive folder could not be loaded: ${err instanceof Error ? err.message : String(err)}`)
              )
            }}>Retry</Button>
          }>{statusError}</Alert>
        )}
      </Stack>

      <Divider />

      <Stack sx={{ gap: 0.5 }}>
        <Typography variant="subtitle2">Remove</Typography>
        <FormControlLabel
          control={<Checkbox size="small" checked={archive.removeReconciled} disabled={disabled}
            onChange={event => update({ removeReconciled: event.target.checked })} />}
          label="Reconciled transactions" sx={{ mr: 0 }} />
        <FormControlLabel
          control={<Checkbox size="small" checked={archive.removeVoided} disabled={disabled}
            onChange={event => update({ removeVoided: event.target.checked })} />}
          label="Voided transactions" sx={{ mr: 0 }} />
        <Typography variant="caption" color="text.secondary">
          Unreconciled transactions are always kept.
        </Typography>
        {!archive.removeReconciled && !archive.removeVoided && (
          <Alert severity="info" variant="outlined">Archiving will copy the book without removing anything.</Alert>
        )}
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Last archived</Typography>
        <Typography variant="body2" data-testid="last-archived">
          {book === undefined
            ? 'Looking…'
            : !book.isOpen || book.book === undefined
              ? 'Open a book to see its archive history.'
              : book.book.archivedThrough === undefined
                ? `“${book.book.name}” has never been archived.`
                : `“${book.book.name}” was archived through ${dateText(book.book.archivedThrough)}.`}
        </Typography>
      </Stack>
    </Stack>
  )
}
