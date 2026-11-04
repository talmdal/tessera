// Move To…: moves an account or a sub-book to another sub-book, or to the book itself. It moves through the
// plugin, so a reason it can't (a name taken there) is shown here and the dialog stays.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { descendantIds, flattenTree } from '@tessera/book-api'
import { ACCOUNTS_CHANNELS, type AccountsResult, type MoveDialogInput, type MoveRequest } from '@tessera/accounts-api'
import { Alert, Button, DialogActions, DialogContent, MenuItem, Stack, TextField } from '@tessera/ui'

export const TO_BOOK = '(book)'

export default function MoveDialog({ input, close, setBusy }: DialogProps<MoveDialogInput, { to: string | null }>) {
  const { item } = input
  const current = item.parentId ?? TO_BOOK
  const [to, setTo] = useState(current)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const places = useMemo(() => {
    const { subBooks } = input
    // A sub-book can't go into itself or anything beneath it
    const excluded = item.kind === 'subBook' ? new Set([item.id, ...descendantIds(subBooks, item.id)]) : new Set<string>()
    return [
      { value: TO_BOOK, label: input.bookName, depth: 0 },
      ...flattenTree(subBooks)
        .filter(({ subBook }) => !excluded.has(subBook.id))
        .map(({ subBook, depth }) => ({ value: subBook.id, label: subBook.name, depth: depth + 1 }))
    ]
  }, [input, item])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const target = to === TO_BOOK ? null : to
    if (to === current) { close({ to: target }); return }
    setSaving(true)
    setBusy(true)
    try {
      const request: MoveRequest = { kind: item.kind, id: item.id, to: target }
      const result = await window.api.invoke<AccountsResult<void>>(ACCOUNTS_CHANNELS.move, request)
      if (result.ok) { close({ to: target }); return }
      setError(result.error.message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField select autoFocus size="small" label="Move to" value={to} onChange={event => { setTo(event.target.value); setError(undefined) }}
            helperText={to === current ? `“${item.name}” is already here.` : ' '}>
            {places.map(place => <MenuItem key={place.value} value={place.value} sx={{ pl: 2 + place.depth * 2 }}>{place.label}</MenuItem>)}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving || to === current}>Move</Button>
      </DialogActions>
    </form>
  )
}
