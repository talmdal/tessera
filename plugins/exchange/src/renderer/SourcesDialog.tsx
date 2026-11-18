// Statement Sources: each bank file this book has been told belongs to an account, and the one quirk worth
// setting per source — how many days that bank takes to post.
//
// The window is per source because posting lag is a property of the bank. One card issuer posts the next day,
// another a week later; a single window is either too tight for the slow one, so its rows land as duplicates of
// what the user typed, or loose enough that the fast one's rows pair with unrelated transactions. Blank means
// "use the option", and the placeholder says what that currently is.
//
// Forgetting a source is here too, because there was nowhere else to do it: the next statement from it asks
// which account it belongs to again.
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { isDateWindow, type SourcesDialogInput, type SourcesDialogResult } from '@tessera/exchange-api'
import {
  Button, Checkbox, DialogActions, DialogContent, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, Tooltip, Typography
} from '@tessera/ui'
import { maskNumber, showTimestamp } from './display'

export default function SourcesDialog({ input, close }: DialogProps<SourcesDialogInput, SourcesDialogResult>) {
  // Raw text per source, not a number: an empty or half-typed box must stay editable, and a number field that
  // re-renders an unusable value as "NaN" cannot be typed past.
  const [windows, setWindows] = useState<Record<string, string>>(() =>
    Object.fromEntries(input.sources.map(s => [s.id, s.dateWindow === undefined ? '' : String(s.dateWindow)])))
  const [removed, setRemoved] = useState<Set<string>>(new Set())

  /** The source's window as typed: undefined for "use the option", NaN for something unusable. */
  const parsed = (id: string): number | undefined => {
    const text = (windows[id] ?? '').trim()
    return text === '' ? undefined : /^\d+$/.test(text) ? Number(text) : NaN
  }
  const invalid = input.sources.filter(s => {
    if (removed.has(s.id)) return false
    const value = parsed(s.id)
    return value !== undefined && !isDateWindow(value)
  })

  const toggleRemoved = (id: string) => setRemoved(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const save = () => close({
    // Only what changed, so an untouched source is not rewritten.
    windows: input.sources
      .filter(s => !removed.has(s.id) && parsed(s.id) !== s.dateWindow)
      .map(s => ({ id: s.id, dateWindow: parsed(s.id) ?? null })),
    removed: [...removed]
  })

  return (
    <>
      <DialogContent dividers sx={{ p: 0 }}>
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 1.5, pb: 1 }}>
          How many days either side a statement line may sit from a transaction in the register and still match.
          Leave it blank to use the setting in Options ({input.defaultWindow} {input.defaultWindow === 1 ? 'day' : 'days'}).
        </Typography>
        <Table size="small" aria-label="Statement sources">
          <TableHead>
            <TableRow>
              <TableCell>Source</TableCell>
              <TableCell>Account</TableCell>
              <TableCell>Last imported</TableCell>
              <TableCell sx={{ width: 130 }}>Days either side</TableCell>
              <TableCell sx={{ width: 72 }} align="center">Forget</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {input.sources.map(source => {
              const gone = removed.has(source.id)
              const value = parsed(source.id)
              const bad = !gone && value !== undefined && !isDateWindow(value)
              return (
                <TableRow key={source.id} data-source={source.id}
                  sx={{ opacity: gone ? 0.5 : 1, '& td': { textDecoration: gone ? 'line-through' : undefined } }}>
                  <TableCell>
                    <Typography variant="body2">{source.label}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {source.formatLabel} · {maskNumber(source.numberKey)}
                    </Typography>
                  </TableCell>
                  <TableCell>{source.accountName}</TableCell>
                  <TableCell>{source.lastImportedAt === undefined ? '' : showTimestamp(source.lastImportedAt)}</TableCell>
                  <TableCell>
                    <TextField
                      size="small" variant="standard" fullWidth disabled={gone}
                      value={windows[source.id] ?? ''}
                      placeholder={String(input.defaultWindow)}
                      error={bad}
                      onChange={event => setWindows(current => ({ ...current, [source.id]: event.target.value }))}
                      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': `Days either side for ${source.label}` } }} />
                  </TableCell>
                  <TableCell align="center">
                    <Tooltip title="The next statement from this source will ask which account it belongs to">
                      <Checkbox size="small" checked={gone} onChange={() => toggleRemoved(source.id)}
                        slotProps={{ input: { 'aria-label': `Forget ${source.label}` } }} />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Typography variant="caption" color={invalid.length > 0 ? 'error' : 'text.secondary'} sx={{ pl: 1 }}>
          {invalid.length > 0 ? `A window is a whole number of days from 0 to ${input.maxWindow}.` : ''}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="contained" disabled={invalid.length > 0} onClick={save} data-sources-ok>Save</Button>
        </Stack>
      </DialogActions>
    </>
  )
}
