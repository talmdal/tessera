// The main-area page while no book is open: create or open one, or pick a recent book.
import { useState } from 'react'
import type { Result } from '@tessera/book-api'
import {
  BOOK_CHANNELS, BOOK_COMMANDS, BOOK_EVENTS, type BackupStatus, type BookInfo, type BookState, type RecentBook
} from '@tessera/book-api'
import {
  Alert, Box, Button, Icon, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Tooltip, Typography
} from '@tessera/ui'
import { asSentence, runCommand, useFollowed } from './bridge'

const opened = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `Opened ${date.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

/** The warning for a book whose last automatic backup didn't complete, leading to the backup settings. */
function BackupWarning({ status, onSettings }: { status: BackupStatus | undefined, onSettings(): void }) {
  if (!status?.book || (status.lastResult !== 'failed' && status.lastResult !== 'interrupted')) return null
  const why = asSentence(status.lastResult === 'interrupted'
    ? 'it was cut short when Tessera quit'
    : status.lastError ?? 'the reason was not recorded')
  return (
    <Alert severity="warning" data-testid="backup-warning"
      action={<Button color="inherit" size="small" onClick={onSettings}>Backup Settings…</Button>}>
      The last backup of “{status.book.name}” didn’t complete: {why} It will be tried again the next time the book closes.
    </Alert>
  )
}

export default function StartView() {
  const state = useFollowed<BookState>(BOOK_CHANNELS.state, BOOK_EVENTS.state)
  const backups = useFollowed<BackupStatus>(BOOK_CHANNELS.backupsStatus, BOOK_EVENTS.backups)
  const recent = useFollowed<RecentBook[]>(BOOK_CHANNELS.recent, BOOK_EVENTS.recent) ?? []
  const [error, setError] = useState<string>()

  const run = (command: string) => () => {
    setError(undefined)
    runCommand(command).catch(err => setError(String(err?.message ?? err)))
  }

  const open = async (entry: RecentBook) => {
    setError(undefined)
    try {
      const result = await window.api.invoke<Result<BookInfo | undefined>>(BOOK_CHANNELS.open, { path: entry.path })
      if (!result.ok) setError(result.error.message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }

  const forget = (entry: RecentBook) => {
    window.api.invoke(BOOK_CHANNELS.recentRemove, { path: entry.path }).catch(err => setError(String(err?.message ?? err)))
  }

  const remove = (entry: RecentBook) => {
    window.api.invoke(BOOK_CHANNELS.delete, { path: entry.path }).catch(err => setError(String(err?.message ?? err)))
  }

  return (
    <Stack spacing={2} sx={{ p: 3, maxWidth: 760 }} data-book-page="start">
      <Box>
        <Typography variant="h5" component="h1">Welcome to Tessera</Typography>
        <Typography color="text.secondary">
          A book holds your accounts and transactions in one file. Create one, or open a book you already have.
        </Typography>
      </Box>

      {state?.error && <Alert severity="warning">{state.error}</Alert>}
      <BackupWarning status={backups} onSettings={run(BOOK_COMMANDS.backupSettings)} />
      {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}

      <Stack direction="row" spacing={1}>
        <Button variant="contained" startIcon={<Icon name="Add" />} onClick={run(BOOK_COMMANDS.new)}>New Book…</Button>
        <Button variant="outlined" startIcon={<Icon name="Folder" />} onClick={run(BOOK_COMMANDS.open)}>Open Book…</Button>
        <Button variant="text" startIcon={<Icon name="Restore" />} onClick={run(BOOK_COMMANDS.restore)}>Restore Backup…</Button>
      </Stack>

      <Box>
        <Typography variant="h6" component="h2" id="book-recent-heading">Recent books</Typography>
        {recent.length === 0
          ? <Typography color="text.secondary">Books you open will be listed here.</Typography>
          : (
            <List aria-labelledby="book-recent-heading" dense>
              {recent.map(entry => {
                const missing = entry.exists === false
                return (
                  <Box component="li" key={entry.path} sx={{ display: 'flex', alignItems: 'center' }}>
                    <ListItemButton onClick={() => open(entry)} disabled={missing} sx={{ borderRadius: 1 }}>
                      <ListItemIcon sx={{ minWidth: 36 }}><Icon name="AccountBalance" /></ListItemIcon>
                      <ListItemText
                        primary={entry.name}
                        secondary={missing ? `${entry.path} (not found)` : `${entry.path}${opened(entry.openedAt) ? ` · ${opened(entry.openedAt)}` : ''}`}
                      />
                    </ListItemButton>
                    <Tooltip title="Remove from this list (the file stays)">
                      <IconButton aria-label={`Remove ${entry.name} from the list`} onClick={() => forget(entry)}><Icon name="Close" /></IconButton>
                    </Tooltip>
                    <Tooltip title={missing ? 'The file is gone' : 'Delete: move the file to the trash'}>
                      <span>
                        <IconButton aria-label={`Delete ${entry.name}`} onClick={() => remove(entry)} disabled={missing}><Icon name="Delete" /></IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                )
              })}
            </List>
          )}
      </Box>
    </Stack>
  )
}
