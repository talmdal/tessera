// Edit Statement Line: turning `SQ *THE DAILY GRIND 4471 OTTAWA ON` into `The Daily Grind` — for this row and
// optionally for every row like it from now on — and giving it a category.
//
// The category is here because a row that matches nothing arrives with none: OFX and most CSV exports carry no
// category at all, so without this the only way to categorise a new transaction would be to accept it
// uncategorised and then find it in the register. A row that *merges* keeps the register transaction's own
// category, which is already the user's and which an import has no business overwriting.
//
// The preview beneath the box is the reason this is a dialog and not an inline edit. Renaming happens *before*
// matching, so a new name can turn this row from one Tessera was about to add into one it will merge with a
// transaction already in the register — which is the feature working, and is exactly the sort of thing that
// must not happen behind the user's back. So the row's disposition is shown, live, before they agree to it.
import { useEffect, useRef, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  EXCHANGE_CHANNELS,
  type ExchangeResult, type RenameDialogInput, type RenameDialogResult, type RenamePreview
} from '@tessera/exchange-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, MenuItem, Stack, TextField,
  Typography
} from '@tessera/ui'
import { Amount, DISPOSITIONS, showDate } from './display'

/** How long the typing has to stop before the preview is asked for. Long enough not to ask on every keystroke. */
const SETTLE_MS = 250

/**
 * The select's value while nothing has chosen a category. Not an option the user can pick: a row only has no
 * category because it arrived without one, and once the user sets it they choose a real one.
 */
const UNSET = ''

export default function RenameDialog({ input, close }: DialogProps<RenameDialogInput, RenameDialogResult>) {
  const [payee, setPayee] = useState(input.payee)
  const [categoryId, setCategoryId] = useState(input.categoryId ?? UNSET)
  const [always, setAlways] = useState(false)
  const [preview, setPreview] = useState<RenamePreview>(input.preview)
  const [stale, setStale] = useState(false)
  const latest = useRef(0)

  const trimmed = payee.trim()
  /** Clearing the box means "no rename of my own": the book's rules decide again. */
  const proposed: string | null = trimmed === '' ? null : trimmed
  const changed = trimmed !== input.payee.trim()

  useEffect(() => {
    if (!changed) { setPreview(input.preview); setStale(false); return }
    setStale(true)
    const ticket = ++latest.current
    const timer = setTimeout(() => {
      void window.api.invoke<ExchangeResult<RenamePreview>>(EXCHANGE_CHANNELS.renamePreview, {
        accountId: input.accountId, statementId: input.statementId, rowKey: input.rowKey, payee: proposed
      }).then(result => {
        // Only the most recent answer counts: a slow reply to an earlier keystroke must not overwrite it.
        if (ticket !== latest.current) return
        if (result?.ok === true) setPreview(result.value)
        setStale(false)
      }, () => { if (ticket === latest.current) setStale(false) })
    }, SETTLE_MS)
    // Whatever changes next — another keystroke, typing the name back to what it was, the dialog closing —
    // makes this request stale. Without this, a reply still in flight after the name was typed back passed the
    // ticket check and put a match on screen for a name that had not changed.
    return () => { clearTimeout(timer); latest.current += 1 }
  }, [trimmed, changed])   // eslint-disable-line react-hooks/exhaustive-deps

  const disposition = DISPOSITIONS[preview.disposition]

  return (
    <>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box>
          <Typography variant="caption" color="text.secondary">The statement line</Typography>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
            <Typography variant="body2">{showDate(input.date)}</Typography>
            <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-word' }}>{input.original}</Typography>
            <Amount minor={input.amount} currency={input.currency} />
          </Stack>
        </Box>

        <TextField
          size="small" label="Payee" value={payee} autoFocus fullWidth
          onChange={event => setPayee(event.target.value)}
          helperText={proposed === null
            ? 'Empty: the book’s payee rules decide this row’s name.'
            : 'The name this transaction will have in the register.'}
          slotProps={{ htmlInput: { 'aria-label': 'Payee' } }} />

        <TextField
          size="small" select label="Category" value={categoryId} fullWidth
          onChange={event => setCategoryId(event.target.value)}
          slotProps={{
            htmlInput: { 'aria-label': 'Category' },
            inputLabel: { shrink: true },
            select: {
              displayEmpty: true,
              renderValue: (value: unknown) => value === UNSET
                ? <em>None yet — choose a category</em>
                : input.categories.find(c => c.id === value)?.label ?? ''
            }
          }}
          helperText={preview.disposition === 'merge'
            ? 'This line matches a transaction already in the register, which keeps its own category.'
            : 'The category this transaction will have.'}
          disabled={preview.disposition === 'merge' || preview.disposition === 'duplicate'}>
          {input.categories.map(category => (
            <MenuItem key={category.id} value={category.id}>{category.label}</MenuItem>
          ))}
        </TextField>

        {input.offerLearning && <FormControlLabel
          control={<Checkbox size="small" checked={always} disabled={proposed === null}
            onChange={event => setAlways(event.target.checked)} />}
          label={
            <Stack>
              <Typography variant="body2">Always rename this payee</Typography>
              <Typography variant="caption" color="text.secondary">
                Writes a rule, so next month’s statement renames it without asking.
              </Typography>
            </Stack>
          } />}

        <Box sx={{ opacity: stale ? 0.5 : 1 }}>
          <Typography variant="caption" color="text.secondary">What this row becomes</Typography>
          <Alert
            severity={preview.disposition === 'duplicate' ? 'warning' : 'info'}
            variant="outlined"
            icon={false}
            sx={{ mt: 0.5, ...(disposition.colour !== undefined && { color: disposition.colour }) }}>
            <Typography variant="body2" data-preview-note>{preview.note}</Typography>
            {preview.matches !== undefined && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {showDate(preview.matches.date)}
                {preview.matches.payee !== undefined ? ` · ${preview.matches.payee}` : ''}
              </Typography>
            )}
          </Alert>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" data-rename-ok
          onClick={() => close({
            // Only what changed: sent back unchanged, a rule's name or category would be saved as the user's own.
            ...(changed && { payee: proposed }),
            // Only ever a category: there is no going back to none, which is a row's state on import, not a choice.
            ...(categoryId !== UNSET && categoryId !== (input.categoryId ?? UNSET) && { categoryId }),
            always: input.offerLearning && always && proposed !== null
          })}>OK</Button>
      </DialogActions>
    </>
  )
}
