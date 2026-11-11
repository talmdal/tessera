// A row being edited: the same columns as a displayed row, as inputs, and a second line with the memo and the buttons.
// Enter saves and Escape cancels (unless a list is open, which takes those keys first).
import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, MEMO_MAX_LENGTH, PAYEE_NAME_MAX_LENGTH, STATUS_LETTERS, TRANSACTION_NUMBER_MAX_LENGTH, amountToInput,
  todayIso, type Account, type AccountsResult, type Category, type PayeeSuggestion
} from '@tessera/accounts-api'
import { Alert, Autocomplete, Box, Button, Stack, TableCell, TableRow, TextField } from '@tessera/ui'
import { addDays, columnsFor, sameChoice, stepNumber, type CategoryChoice, type Draft, type DraftField } from './model'

type CategoryOption = CategoryChoice | { kind: 'create', path: string, label: string }

export interface EditorProps {
  draft: Draft
  onChange(update: (draft: Draft) => Draft): void
  account: Account
  choices: CategoryChoice[]
  problems: Partial<Record<DraftField, string>>
  /** A failure not tied to one field. */
  error?: string
  busy: boolean
  /** The field to focus when the editor appears. */
  focus?: DraftField
  onSave(): void
  onCancel(): void
  /** The new-entry row: a known payee fills in what it was last used for. */
  isNew: boolean
}

const dense = { size: 'small' as const, margin: 'none' as const, fullWidth: true, variant: 'outlined' as const }
const cell = { px: 0.5, py: 0.5, verticalAlign: 'top' }

export function TransactionEditor(props: EditorProps) {
  const { draft, onChange, account, choices, problems, error, busy, focus, onSave, onCancel, isNew } = props
  const columns = columnsFor(account)
  const [payees, setPayees] = useState<PayeeSuggestion[]>([])
  const [categoryText, setCategoryText] = useState(draft.category?.label ?? '')
  const refs = useRef<Partial<Record<DraftField, HTMLInputElement | null>>>({})

  useEffect(() => { refs.current[focus ?? 'date']?.focus() }, [focus, draft.id])

  useEffect(() => {
    let live = true
    window.api.invoke<PayeeSuggestion[]>(ACCOUNTS_CHANNELS.searchPayees, { prefix: draft.payee }).then(
      found => { if (live) setPayees(found) }, () => undefined)
    return () => { live = false }
  }, [draft.payee])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange(current => ({ ...current, [key]: value }))

  /** A known payee, chosen for a new entry, fills in the category and amount it was last used with, if still empty. */
  const choosePayee = (name: string) => {
    const known = payees.find(p => p.name === name)
    onChange(current => {
      const next = { ...current, payee: name }
      if (!isNew || !known) return next
      if (next.category === null) {
        next.category = (known.lastTransferAccountId !== undefined
          ? choices.find(c => c.kind === 'transfer' && c.accountId === known.lastTransferAccountId)
          : choices.find(c => c.kind === 'category' && c.id === known.lastCategoryId)) ?? null
      }
      if (next.decrease === '' && next.increase === '' && known.lastAmount !== undefined && known.lastAmount !== 0) {
        const text = amountToInput(Math.abs(known.lastAmount), account.currency)
        if (known.lastAmount < 0) next.decrease = text; else next.increase = text
      }
      return next
    })
  }

  /** Creates a category typed in the field: income when the amount is a deposit, an expense otherwise. */
  const createCategory = async (path: string) => {
    const kind = draft.increase.trim() !== '' && draft.decrease.trim() === '' ? 'income' : 'expense'
    const result = await window.api.invoke<AccountsResult<Category>>(ACCOUNTS_CHANNELS.createCategory, { path, kind })
    if (result.ok) set('category', { kind: 'category', id: result.value.id, label: path.split(':').map(p => p.trim()).join(' : ') })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.key === 'Enter') { event.preventDefault(); onSave() }
    else if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }

  const dateKeys = (event: KeyboardEvent) => {
    const step = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : 0
    if (step !== 0) { event.preventDefault(); set('date', addDays(draft.date, step)) }
    else if (event.key === 't' || event.key === 'T') { event.preventDefault(); set('date', todayIso()) }
  }
  const numberKeys = (event: KeyboardEvent) => {
    const step = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : 0
    if (step !== 0 && /^\d*$/.test(draft.number.trim())) { event.preventDefault(); set('number', stepNumber(draft.number || '0', step)) }
  }

  const options: CategoryOption[] = choices
  const status = STATUS_LETTERS[draft.status]

  return (
    <>
      <TableRow data-editing={draft.id ?? 'new'} onKeyDown={onKeyDown} sx={{ '& td': { borderBottom: 0 } }}>
        <TableCell sx={{ ...cell, textAlign: 'center', pt: 1.25 }} aria-label="Status">{status}</TableCell>
        <TableCell sx={cell}>
          <TextField {...dense} placeholder="Num" value={draft.number} error={problems.number !== undefined}
            onChange={event => set('number', event.target.value)} onKeyDown={numberKeys}
            inputRef={(element: HTMLInputElement | null) => { refs.current.number = element }}
            slotProps={{ htmlInput: { 'aria-label': 'Number', maxLength: TRANSACTION_NUMBER_MAX_LENGTH } }} />
        </TableCell>
        <TableCell sx={cell}>
          <TextField {...dense} type="date" value={draft.date} error={problems.date !== undefined}
            onChange={event => set('date', event.target.value)} onKeyDown={dateKeys}
            inputRef={(element: HTMLInputElement | null) => { refs.current.date = element }}
            // A new transaction can't be dated before the account's last archival date: the calendar starts there
            slotProps={{ htmlInput: { 'aria-label': 'Date', ...(isNew && account.lastArchiveDate !== undefined && { min: account.lastArchiveDate }) } }} />
        </TableCell>
        <TableCell sx={cell}>
          <Autocomplete
            freeSolo
            options={payees.map(p => p.name)}
            inputValue={draft.payee}
            onInputChange={(_event, value, reason) => { if (reason !== 'reset') set('payee', value) }}
            onChange={(_event, value) => { if (typeof value === 'string') choosePayee(value) }}
            renderInput={params => (
              <TextField {...params} {...dense} placeholder="Payee" error={problems.payee !== undefined}
                inputRef={(element: HTMLInputElement | null) => { refs.current.payee = element }}
                // Merged, not replaced: the Autocomplete's own input props carry its ref and adornments
                slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'aria-label': 'Payee', maxLength: PAYEE_NAME_MAX_LENGTH } }} />
            )}
          />
        </TableCell>
        <TableCell sx={cell}>
          <Autocomplete<CategoryOption>
            options={options}
            value={draft.category}
            isOptionEqualToValue={(a, b) => a.kind !== 'create' && b.kind !== 'create' && sameChoice(a, b)}
            getOptionLabel={option => option.label}
            inputValue={categoryText}
            onInputChange={(_event, value) => setCategoryText(value)}
            filterOptions={(all, state) => {
              const typed = state.inputValue.trim()
              const matches = all.filter(o => o.label.toLowerCase().includes(typed.toLowerCase()))
              const exact = all.some(o => o.label.toLowerCase() === typed.toLowerCase())
              return typed !== '' && !exact && !typed.toLowerCase().startsWith('transfer')
                ? [...matches, { kind: 'create', path: typed, label: `Create category “${typed}”` }]
                : matches
            }}
            onChange={(_event, value) => {
              if (value?.kind === 'create') void createCategory(value.path)
              else set('category', value ?? null)
            }}
            renderInput={params => (
              <TextField {...params} {...dense} placeholder="Category" error={problems.category !== undefined}
                inputRef={(element: HTMLInputElement | null) => { refs.current.category = element }}
                slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'aria-label': 'Category' } }} />
            )}
          />
        </TableCell>
        <TableCell sx={cell}>
          <TextField {...dense} placeholder={columns.decrease} value={draft.decrease} error={problems.amount !== undefined}
            onChange={event => onChange(current => ({ ...current, decrease: event.target.value, increase: event.target.value === '' ? current.increase : '' }))}
            inputRef={(element: HTMLInputElement | null) => { refs.current.amount = element }}
            slotProps={{ htmlInput: { 'aria-label': columns.decrease, inputMode: 'decimal', style: { textAlign: 'right' } } }} />
        </TableCell>
        <TableCell sx={cell}>
          <TextField {...dense} placeholder={columns.increase} value={draft.increase} error={problems.amount !== undefined}
            onChange={event => onChange(current => ({ ...current, increase: event.target.value, decrease: event.target.value === '' ? current.decrease : '' }))}
            slotProps={{ htmlInput: { 'aria-label': columns.increase, inputMode: 'decimal', style: { textAlign: 'right' } } }} />
        </TableCell>
        <TableCell sx={cell} />
      </TableRow>
      <TableRow onKeyDown={onKeyDown}>
        <TableCell sx={cell} />
        <TableCell sx={cell} colSpan={7}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ flex: 1 }}>
              <TextField {...dense} placeholder="Memo" value={draft.memo} error={problems.memo !== undefined}
                onChange={event => set('memo', event.target.value)}
                inputRef={(element: HTMLInputElement | null) => { refs.current.memo = element }}
                slotProps={{ htmlInput: { 'aria-label': 'Memo', maxLength: MEMO_MAX_LENGTH } }} />
            </Box>
            <Button size="small" variant="contained" onClick={onSave} disabled={busy}>Enter</Button>
            <Button size="small" onClick={onCancel} disabled={busy}>Cancel</Button>
          </Stack>
          {(error || Object.keys(problems).length > 0) && (
            <Alert severity="error" sx={{ mt: 0.5, py: 0 }}>
              {error ?? Object.values(problems).filter(Boolean).join(' ')}
            </Alert>
          )}
        </TableCell>
      </TableRow>
    </>
  )
}
