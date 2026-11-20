// Tools ▸ Options ▸ Book ▸ Backups. See docs/backup-restore-design.md, "The Backups options page".
//
// The page is controlled: the options dialog owns the draft, and nothing here applies anything. The two things it
// asks the book for directly are status, not options: the last backup ("Last backup", never part of the draft), and
// a folder picker, whose answer goes into the draft like any other edit.
import { useEffect, useState } from 'react'
import type { OptionsPageProps } from '@tessera/types'
import {
  BACKUP_KEEP_MAX, BACKUP_KEEP_MIN, BOOK_CHANNELS, BOOK_EVENTS, validateBookOptions,
  type BackupFrequency, type BackupStatus, type BookBackupOptions, type BookOptions
} from '@tessera/book-api'
import {
  Alert, Button, Checkbox, Divider, FormControlLabel, MenuItem, Stack, TextField, Typography
} from '@tessera/ui'
import { asSentence, useFollowed, whenText } from './bridge'

export { whenText }

const FREQUENCIES: { value: BackupFrequency, label: string }[] = [
  { value: 'everyClose', label: 'Every time the book closes' },
  { value: 'daily', label: 'Once a day' },
  { value: 'weekly', label: 'Once a week' },
  { value: 'monthly', label: 'Once a month' }
]

/** The last part of a path, on any platform: the renderer has no `node:path`. */
const fileName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file

/** A whole number as typed, or NaN for anything else — which the options' validation turns into a message. */
const wholeNumber = (text: string) => /^\s*\d+\s*$/.test(text) ? Number(text) : NaN

/**
 * A box for a whole number that shows exactly what was typed, as the Import and export page's does, for the same
 * reasons: showing the parsed value turned an empty box into "NaN" and `1.5` into `15`. Only a whole number goes up;
 * anything else goes up as NaN, so the page is invalid until it is fixed.
 */
function WholeNumberField({ label, value, disabled, helperText, error, onChange }: {
  label: string, value: number, disabled: boolean, helperText: string, error: boolean, onChange(next: number): void
}) {
  const [text, setText] = useState(() => Number.isFinite(value) ? String(value) : '')
  // A change from outside (Restore Defaults) replaces what is typed; the page's own edits never do
  useEffect(() => {
    if (Number.isFinite(value) && wholeNumber(text) !== value) setText(String(value))
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TextField
      size="small" label={label} sx={{ maxWidth: 120 }}
      value={text} disabled={disabled} error={error}
      onChange={event => { setText(event.target.value); onChange(wholeNumber(event.target.value)) }}
      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': label, 'aria-describedby': 'book-backups-keep-help' } }}
      helperText={<span id="book-backups-keep-help">{helperText}</span>} />
  )
}

/** "Last backup": which book, when, and what went wrong last time, if anything did. */
function LastBackup({ status }: { status: BackupStatus | undefined }) {
  if (status === undefined) return <Typography variant="body2" color="text.secondary">Looking…</Typography>
  const { book, lastBackupAt, lastFile, lastResult, lastError } = status
  if (!book) return <Typography variant="body2" color="text.secondary">No book has been opened yet.</Typography>

  return (
    <Stack sx={{ gap: 1 }}>
      <Typography variant="body2" data-testid="last-backup">
        {lastBackupAt === undefined
          ? `“${book.name}” hasn’t been backed up yet.`
          : <>“{book.name}”: {whenText(lastBackupAt)}{lastFile && <> · <span title={lastFile}>{fileName(lastFile)}</span></>}</>}
      </Typography>
      {lastResult === 'failed' && (
        <Alert severity="warning" variant="outlined">
          The last automatic backup failed: {asSentence(lastError ?? 'the reason was not recorded')} It will be tried again the next time the book closes.
        </Alert>
      )}
      {lastResult === 'interrupted' && (
        <Alert severity="warning" variant="outlined">
          The last automatic backup was cut short when Tessera quit. It will be taken the next time the book closes.
        </Alert>
      )}
    </Stack>
  )
}

export default function BackupsOptionsPage({ value, onChange, onValidityChange, disabled }: OptionsPageProps<BookOptions>) {
  const backups = value.backups
  const status = useFollowed<BackupStatus>(BOOK_CHANNELS.backupsStatus, BOOK_EVENTS.backups)
  const [browseError, setBrowseError] = useState<string | undefined>()
  const [browsing, setBrowsing] = useState(false)

  /** Every edit revalidates: `validate` in the main process is authoritative, this only gates the buttons. */
  const update = (patch: Partial<BookBackupOptions>) => {
    const next = { ...value, backups: { ...backups, ...patch } }
    onChange(next)
    onValidityChange(validateBookOptions(next).length === 0)
  }

  const browse = async () => {
    setBrowseError(undefined)
    setBrowsing(true)
    try {
      const chosen = await window.api.invoke<string | undefined>(BOOK_CHANNELS.backupsChooseFolder, { current: backups.folder })
      if (chosen !== undefined) update({ folder: chosen })
    } catch (err) {
      setBrowseError(`The folder could not be chosen: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBrowsing(false)
    }
  }

  const keepValid = Number.isInteger(backups.keep) && backups.keep >= BACKUP_KEEP_MIN && backups.keep <= BACKUP_KEEP_MAX
  const scheduleDisabled = disabled || !backups.automatic
  const folderShown = backups.folder ?? status?.defaultFolder

  return (
    <Stack sx={{ gap: 2.5, maxWidth: 620 }} data-options-page="book.options.backups">
      <Stack sx={{ gap: 1.5 }}>
        <FormControlLabel
          control={<Checkbox size="small" checked={backups.automatic} disabled={disabled}
            onChange={event => update({ automatic: event.target.checked })} />}
          label={
            <Stack>
              <Typography variant="body2">Back up automatically when a book closes</Typography>
              <Typography variant="caption" color="text.secondary">
                Off means backups are only made when you ask for one.
              </Typography>
            </Stack>
          }
          sx={{ alignItems: 'flex-start', mr: 0 }} />

        <Stack sx={{ gap: 2, pl: 4 }}>
          <TextField
            size="small" select label="How often" sx={{ maxWidth: 320 }}
            value={backups.frequency} disabled={scheduleDisabled}
            onChange={event => update({ frequency: event.target.value as BackupFrequency })}
            helperText="A book that hasn’t changed since its last backup isn’t backed up again."
            slotProps={{ htmlInput: { 'aria-label': 'How often' } }}>
            {FREQUENCIES.map(f => <MenuItem key={f.value} value={f.value}>{f.label}</MenuItem>)}
          </TextField>

          <WholeNumberField
            label="Automatic backups to keep" value={backups.keep} disabled={scheduleDisabled} error={!keepValid}
            onChange={keep => update({ keep })}
            helperText={keepValid
              ? 'For each book. Older ones are moved to the Trash. Backups you make yourself are always kept.'
              : `Keep between ${BACKUP_KEEP_MIN} and ${BACKUP_KEEP_MAX}.`} />
        </Stack>
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Backup folder</Typography>
        <Typography variant="body2" sx={{ wordBreak: 'break-all' }} data-testid="backup-folder">
          {folderShown ?? 'Tessera Backups, in your Documents folder'}
          {backups.folder === null && <Typography component="span" variant="body2" color="text.secondary"> (the default)</Typography>}
        </Typography>
        <Stack direction="row" sx={{ gap: 1 }}>
          <Button size="small" variant="outlined" disabled={disabled || browsing} onClick={() => { void browse() }}>Browse…</Button>
          <Button size="small" disabled={disabled || backups.folder === null} onClick={() => update({ folder: null })}>Use Default</Button>
        </Stack>
        {browseError && <Alert severity="error" variant="outlined">{browseError}</Alert>}
        <Typography variant="caption" color="text.secondary">
          Choose a folder on another drive, or one your cloud service keeps in sync, so a failed disk doesn’t take your
          backups with it. Backups already made stay where they are when you change this.
        </Typography>
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Last backup</Typography>
        <LastBackup status={status} />
      </Stack>
    </Stack>
  )
}
