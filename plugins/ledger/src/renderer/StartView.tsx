// The main-area page while no ledger is open: create or open one, or pick a recent ledger.
import { useState } from 'react'
import type { Result } from '@tessera/ledger-api'
import {
  LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_EVENTS, type LedgerInfo, type LedgerState, type RecentLedger
} from '@tessera/ledger-api'
import {
  Alert, Box, Button, Icon, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'

const opened = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `Opened ${date.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

export default function StartView() {
  const state = useFollowed<LedgerState>(LEDGER_CHANNELS.state, LEDGER_EVENTS.state)
  const recent = useFollowed<RecentLedger[]>(LEDGER_CHANNELS.recent, LEDGER_EVENTS.recent) ?? []
  const [error, setError] = useState<string>()

  const run = (command: string) => () => {
    setError(undefined)
    runCommand(command).catch(err => setError(String(err?.message ?? err)))
  }

  const open = async (entry: RecentLedger) => {
    setError(undefined)
    try {
      const result = await window.api.invoke<Result<LedgerInfo | undefined>>(LEDGER_CHANNELS.open, { path: entry.path })
      if (!result.ok) setError(result.error.message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }

  const forget = (entry: RecentLedger) => {
    window.api.invoke(LEDGER_CHANNELS.recentRemove, { path: entry.path }).catch(err => setError(String(err?.message ?? err)))
  }

  const remove = (entry: RecentLedger) => {
    window.api.invoke(LEDGER_CHANNELS.delete, { path: entry.path }).catch(err => setError(String(err?.message ?? err)))
  }

  return (
    <Stack spacing={2} sx={{ p: 3, maxWidth: 760 }} data-ledger-page="start">
      <Box>
        <Typography variant="h5" component="h1">Welcome to Tessera</Typography>
        <Typography color="text.secondary">
          A ledger holds your accounts and transactions in one file. Create one, or open a ledger you already have.
        </Typography>
      </Box>

      {state?.error && (
        // A ledger that won't open is when a backup is needed most
        <Alert severity="warning" action={<Button color="inherit" size="small" onClick={run(LEDGER_COMMANDS.restore)}>Restore from a Backup…</Button>}>
          {state.error}
        </Alert>
      )}
      {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}

      <Stack direction="row" spacing={1}>
        <Button variant="contained" startIcon={<Icon name="Add" />} onClick={run(LEDGER_COMMANDS.new)}>New Ledger…</Button>
        <Button variant="outlined" startIcon={<Icon name="Folder" />} onClick={run(LEDGER_COMMANDS.open)}>Open Ledger…</Button>
        <Button variant="outlined" startIcon={<Icon name="Undo" />} onClick={run(LEDGER_COMMANDS.restore)}>Restore from a Backup…</Button>
      </Stack>

      <Box>
        <Typography variant="h6" component="h2" id="ledger-recent-heading">Recent ledgers</Typography>
        {recent.length === 0
          ? <Typography color="text.secondary">Ledgers you open will be listed here.</Typography>
          : (
            <List aria-labelledby="ledger-recent-heading" dense>
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
