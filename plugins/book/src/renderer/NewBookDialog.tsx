// File › New Book…: a name, and where it goes. No parent creates a new book file (after the command asks to
// close the open one); a parent creates a sub-book inside the open book, and no file.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  BOOK_CHANNELS, BOOK_NAME_MAX_LENGTH, flattenTree, validateBookName,
  type NewBookDialogInput, type NewBookDialogResult, type Result, type SubBook
} from '@tessera/book-api'
import { Alert, Button, DialogActions, DialogContent, MenuItem, Stack, TextField } from '@tessera/ui'

/** Select values: no parent (a new file), the open book itself, or a sub-book's id. */
export const NO_PARENT = '(none)'
export const BOOK_ITSELF = '(book)'

const toValue = (parentId: string | null | undefined) => parentId === undefined ? NO_PARENT : parentId === null ? BOOK_ITSELF : parentId

export default function NewBookDialog({ input, close, setBusy }: DialogProps<NewBookDialogInput, NewBookDialogResult>) {
  const { tree } = input
  const [name, setName] = useState('')
  const [parent, setParent] = useState(toValue(input.parentId))
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)

  const options = useMemo(() => [
    { value: NO_PARENT, label: 'None (create a new book file)', depth: 0 },
    { value: BOOK_ITSELF, label: tree.book.name, depth: 0 },
    ...flattenTree(tree.subBooks).map(({ subBook, depth }) => ({ value: subBook.id, label: subBook.name, depth: depth + 1 }))
  ], [tree])

  const nameProblem = validateBookName(name)
  const nameError = serverError?.field === 'name' ? serverError.message : touched ? nameProblem : undefined
  const parentName = options.find(o => o.value === parent)?.label ?? tree.book.name

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (nameProblem || saving) return
    if (parent === NO_PARENT) {
      close({ kind: 'file', name: name.trim() })
      return
    }

    setSaving(true)
    setBusy(true)
    setServerError(undefined)
    try {
      const result = await window.api.invoke<Result<SubBook>>(BOOK_CHANNELS.createSubBook, {
        name, parentId: parent === BOOK_ITSELF ? null : parent
      })
      if (result.ok) { close({ kind: 'subBook', id: result.value.id }); return }
      setServerError(result.error)
    } catch (err) {
      setServerError({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            autoFocus
            required
            size="small"
            label="Name"
            value={name}
            onChange={event => { setName(event.target.value); setServerError(undefined) }}
            onBlur={() => setTouched(true)}
            error={nameError !== undefined}
            helperText={nameError ?? (parent === NO_PARENT ? 'Also the suggested file name.' : ' ')}
            slotProps={{ htmlInput: { maxLength: BOOK_NAME_MAX_LENGTH } }}
          />
          <TextField
            select
            size="small"
            label="Parent book"
            value={parent}
            onChange={event => { setParent(event.target.value); setServerError(undefined) }}
            helperText={parent === NO_PARENT
              ? `Closes “${tree.book.name}” and creates a new book file.`
              : `Created inside “${parentName}”, in the same file.`}
          >
            {options.map(option => (
              <MenuItem key={option.value} value={option.value} sx={{ pl: 2 + option.depth * 2 }}>{option.label}</MenuItem>
            ))}
          </TextField>
          {serverError && serverError.field !== 'name' && <Alert severity="error">{serverError.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>{parent === NO_PARENT ? 'Create…' : 'Create'}</Button>
      </DialogActions>
    </form>
  )
}
