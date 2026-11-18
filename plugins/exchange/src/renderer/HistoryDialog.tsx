// What has been imported into this book, and the chance to take one back out.
//
// The history is the only place an import that has already been read through can be found again, so it shows
// what each one did rather than just when it happened: the file, the accounts, and how many rows were written,
// merged or already here. An import that cannot be undone says so instead of offering a button that fails.
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { HistoryDialogInput, HistoryDialogResult, HistoryEntry } from '@tessera/exchange-api'
import {
  Button, Chip, DialogActions, DialogContent, List, ListItemButton, Stack, Typography
} from '@tessera/ui'
import { showTimestamp } from './display'

export default function HistoryDialog({ input, close }: DialogProps<HistoryDialogInput, HistoryDialogResult>) {
  const [chosen, setChosen] = useState<string>()
  const selected = input.entries.find(entry => entry.batch.id === chosen)
  const canUndo = selected !== undefined && selected.blocked === undefined

  return (
    <>
      <DialogContent dividers sx={{ p: 0 }}>
        <List dense disablePadding aria-label="Imports">
          {input.entries.map(entry => (
            <ListItemButton
              key={entry.batch.id}
              selected={entry.batch.id === chosen}
              onClick={() => setChosen(entry.batch.id)}
              sx={{ display: 'block', borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>{entry.batch.fileName}</Typography>
                <Typography variant="caption" color="text.secondary">{when(entry)}</Typography>
                {entry.batch.undoneAt !== undefined && <Chip size="small" label="Undone" variant="outlined" />}
                {entry.batch.closedAt === undefined && (
                  <Chip size="small" label="Still being read" color="info" variant="outlined" />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {entry.accountNames.join(', ')} · {describe(entry)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
          {selected?.blocked ?? (selected === undefined ? 'Choose an import to undo it.' : '')}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button onClick={() => close()}>Close</Button>
          <Button variant="contained" color="warning" disabled={!canUndo} data-undo-ok
            onClick={() => selected && close({ undo: selected.batch.id })}>Undo Import</Button>
        </Stack>
      </DialogActions>
    </>
  )
}

/**
 * When the import happened, in the user's terms. A batch read over several sittings says so, because its rows
 * are spread across those days and an undo takes all of them back.
 */
export function when(entry: HistoryEntry): string {
  const started = day(entry.batch.importedAt)
  const last = day(entry.batch.lastAcceptedAt)
  return started === last ? started : `${started} – ${last}`
}

const day = showTimestamp

/** What the import did, in counts the user can check against their statement. */
export function describe(entry: HistoryEntry): string {
  const { imported, merged, duplicates } = entry.batch.counts
  const parts: string[] = []
  if (imported > 0) parts.push(`${imported} added`)
  if (merged > 0) parts.push(`${merged} matched`)
  if (duplicates > 0) parts.push(`${duplicates} already here`)
  return parts.length === 0 ? 'nothing written' : parts.join(', ')
}
