// New Recurring Transaction… and Edit…: one form, in two halves — what the transaction is, and when it repeats.
// It saves through the plugin, so a reason it can't be saved is shown on the field at fault and the dialog stays.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  AMOUNT_COLUMNS, CATEGORY_SEPARATOR, MEMO_MAX_LENGTH, PAYEE_NAME_MAX_LENGTH, TRANSACTION_NUMBER_MAX_LENGTH,
  amountToInput, categoryLabel, parseAmount,
  type Account, type Category
} from '@tessera/accounts-api'
import {
  DEFAULT_REMIND_DAYS, SERIES_NAME_MAX_LENGTH, SERIES_NOTES_MAX_LENGTH,
  addIsoDays,
  type RecurringResult, type SaveFromTransactionRequest, type Schedule, type Series, type SeriesDialogInput,
  type SeriesInput, type SeriesTemplate
} from '@tessera/recurring-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, Divider, FormControlLabel, MenuItem, Stack,
  TextField, Typography
} from '@tessera/ui'
import { RECURRING_CHANNELS } from '@tessera/recurring-api'
import { showDate } from './display'
import { ScheduleEditor } from './ScheduleEditor'

type Field = 'name' | 'accountId' | 'amount' | 'payee' | 'categoryId' | 'transferAccountId' | 'number' | 'memo'
  | 'schedule' | 'remindDays' | 'notes'

/** The category field's value for a transfer: `transfer:<accountId>`. */
const TRANSFER = 'transfer:'

/** What the form holds: text as typed, so nothing is lost or reformatted while the user edits. */
interface Form {
  name: string
  accountId: string
  /** Unsigned, as the register shows it; `decrease` carries the direction. */
  amount: string
  decrease: boolean
  payee: string
  /** A category id, or `transfer:<accountId>`, or '' for neither. */
  category: string
  number: string
  autoNumber: boolean
  memo: string
  estimated: boolean
  schedule: Schedule
  remindDays: number
  notes: string
}

const defaultSchedule = (today: string): Schedule => ({ frequency: 'monthly', interval: 1, startDate: today })

function formFrom(input: SeriesDialogInput, accounts: Account[]): Form {
  const blank: Form = {
    name: '', accountId: accounts[0]?.id ?? '', amount: '', decrease: true, payee: '', category: '',
    number: '', autoNumber: false, memo: '', estimated: false,
    schedule: defaultSchedule(input.today), remindDays: DEFAULT_REMIND_DAYS, notes: ''
  }
  if (input.mode === 'create') return { ...blank, accountId: input.accountId ?? blank.accountId }

  const series: Series = input.mode === 'edit' ? input.series : ({} as Series)
  const template: SeriesTemplate = input.mode === 'edit' ? input.series.template : input.template
  const account = accounts.find(a => a.id === (input.mode === 'edit' ? series.accountId : input.accountId))
  return {
    name: input.mode === 'edit' ? series.name : '',
    accountId: (input.mode === 'edit' ? series.accountId : input.accountId) ?? blank.accountId,
    amount: template.amount === 0 ? '' : amountToInput(Math.abs(template.amount), account?.currency ?? 'CAD'),
    decrease: template.amount < 0,
    payee: template.payee ?? '',
    category: template.transferAccountId !== undefined ? `${TRANSFER}${template.transferAccountId}` : template.categoryId ?? '',
    number: template.number ?? '',
    autoNumber: template.autoNumber,
    memo: template.memo ?? '',
    estimated: template.estimated,
    schedule: input.mode === 'edit' ? series.schedule : input.schedule,
    remindDays: input.mode === 'edit' ? series.remindDays : DEFAULT_REMIND_DAYS,
    notes: input.mode === 'edit' ? series.notes ?? '' : ''
  }
}

/** The form as the service takes it. `undefined` when a field it checks here is not usable yet. */
export function toSeriesInput(form: Form, currency: string): { input?: SeriesInput, problems: Partial<Record<Field, string>> } {
  const problems: Partial<Record<Field, string>> = {}
  if (form.accountId === '') problems.accountId = 'Choose an account.'

  // An estimate nobody has made yet is allowed, and stored as zero
  const blankEstimate = form.amount.trim() === '' && form.estimated
  const parsed = blankEstimate ? undefined : parseAmount(form.amount, currency)
  if (parsed !== undefined) {
    if (!parsed.ok) problems.amount = parsed.message
    else if (parsed.value < 0) problems.amount = 'Enter the amount without a sign.'
    else if (parsed.value === 0 && !form.estimated) problems.amount = 'Enter an amount, or say that it varies.'
  }

  if (form.name.trim().length > SERIES_NAME_MAX_LENGTH) problems.name = `Use at most ${SERIES_NAME_MAX_LENGTH} characters.`
  if (Object.keys(problems).length > 0) return { problems }

  const magnitude = parsed?.ok === true ? parsed.value : 0
  // Never -0: it survives in memory even though JSON flattens it, and makes a stored amount compare oddly
  const signed = magnitude === 0 ? 0 : form.decrease ? -magnitude : magnitude
  const transfer = form.category.startsWith(TRANSFER) ? form.category.slice(TRANSFER.length) : undefined
  const template: SeriesTemplate = {
    amount: signed,
    autoNumber: form.autoNumber,
    estimated: form.estimated,
    ...(form.payee.trim() !== '' && { payee: form.payee.trim() }),
    ...(form.memo.trim() !== '' && { memo: form.memo.trim() }),
    ...(!form.autoNumber && form.number.trim() !== '' && { number: form.number.trim() }),
    ...(transfer !== undefined ? { transferAccountId: transfer } : form.category !== '' ? { categoryId: form.category } : {})
  }
  return {
    input: {
      accountId: form.accountId,
      template,
      schedule: form.schedule,
      remindDays: form.remindDays,
      ...(form.name.trim() !== '' && { name: form.name.trim() }),
      ...(form.notes.trim() !== '' && { notes: form.notes.trim() })
    },
    problems
  }
}

export default function SeriesDialog({ input, close, setBusy }: DialogProps<SeriesDialogInput, { id: string }>) {
  const accounts = useMemo(
    () => input.chart.accounts.map(summary => summary.account).filter(account => !account.closed),
    [input.chart])
  const [form, setForm] = useState<Form>(() => formFrom(input, accounts))
  const [problems, setProblems] = useState<Partial<Record<Field, string>>>({})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const set = (patch: Partial<Form>) => setForm(was => ({ ...was, ...patch }))
  const account = accounts.find(a => a.id === form.accountId)
  const currency = account?.currency ?? 'CAD'
  const columns = AMOUNT_COLUMNS[account?.type ?? 'chequing']

  const categories = useMemo(() => {
    const byLabel = input.categories
      .map(category => ({ id: category.id, label: categoryLabel(input.categories, category.id) ?? category.name }))
      .filter(entry => entry.label.includes(CATEGORY_SEPARATOR) || !input.categories.some(c => c.parentId === entry.id))
    return byLabel.sort((a, b) => a.label.localeCompare(b.label))
  }, [input.categories])

  const transfers = useMemo(
    () => accounts.filter(a => a.id !== form.accountId && a.currency === currency),
    [accounts, form.accountId, currency])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const { input: seriesInput, problems: found } = toSeriesInput(form, currency)
    setProblems(found)
    if (!seriesInput) return

    setSaving(true)
    setBusy?.(true)
    try {
      // Made from a transaction already in a register: the plugin records it as the new series' last entry
      const result = input.mode === 'fromTransaction'
        ? await window.api.invoke<RecurringResult<Series>>(RECURRING_CHANNELS.createFromTransaction, {
          input: seriesInput,
          source: { accountId: input.accountId, transactionId: input.transactionId }
        } satisfies SaveFromTransactionRequest)
        : await window.api.invoke<RecurringResult<Series>>(RECURRING_CHANNELS.saveSeries, {
          input: seriesInput,
          ...(input.mode === 'edit' && { id: input.series.id, expectedRev: input.series.rev })
        })
      if (result.ok) { close({ id: result.value.id }); return }
      const field = result.error.field as Field | undefined
      if (field) setProblems({ [field]: result.error.message })
      else setError(result.error.message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSaving(false)
      setBusy?.(false)
    }
  }

  if (accounts.length === 0) {
    return (
      <Box data-recurring-dialog="series">
        <DialogContent dividers>
          <Alert severity="info">Add an account first: a recurring transaction has to go somewhere.</Alert>
        </DialogContent>
        <DialogActions><Button onClick={() => close(undefined)}>Close</Button></DialogActions>
      </Box>
    )
  }

  return (
    <Box component="form" onSubmit={submit} data-recurring-dialog="series">
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}
          {input.mode === 'fromTransaction' && (
            <Alert severity="info">
              Taken from the transaction of {showDate(input.sourceDate)}. That one stays in the register as it is;
              this schedules the next one.
            </Alert>
          )}

          <Typography variant="overline" color="text.secondary">What it is</Typography>
          <Stack direction="row" spacing={2}>
            <TextField
              select label="Account" size="small" sx={{ flex: 1 }} value={form.accountId}
              onChange={e => set({ accountId: e.target.value, category: '' })}
              error={problems.accountId !== undefined} helperText={problems.accountId}
              slotProps={{ htmlInput: { 'aria-label': 'Account' } }}
            >
              {accounts.map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
            </TextField>
            <TextField
              label="Payee" size="small" sx={{ flex: 1 }} value={form.payee}
              onChange={e => set({ payee: e.target.value })}
              error={problems.payee !== undefined} helperText={problems.payee}
              slotProps={{ htmlInput: { maxLength: PAYEE_NAME_MAX_LENGTH, 'aria-label': 'Payee' } }}
            />
          </Stack>

          <Stack direction="row" spacing={2}>
            <TextField
              select label="Direction" size="small" sx={{ width: 170 }} value={form.decrease ? 'out' : 'in'}
              onChange={e => set({ decrease: e.target.value === 'out' })}
              slotProps={{ htmlInput: { 'aria-label': 'Direction' } }}
            >
              <MenuItem value="out">{columns.decrease}</MenuItem>
              <MenuItem value="in">{columns.increase}</MenuItem>
            </TextField>
            <TextField
              label="Amount" size="small" sx={{ width: 170 }} value={form.amount}
              onChange={e => set({ amount: e.target.value })}
              error={problems.amount !== undefined} helperText={problems.amount ?? currency}
              slotProps={{ htmlInput: { inputMode: 'decimal', 'aria-label': 'Amount' } }}
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={form.estimated} onChange={e => set({ estimated: e.target.checked })} />}
              label={<Typography variant="body2">The amount varies</Typography>} />
          </Stack>

          <TextField
            select label="Category or transfer" size="small" fullWidth value={form.category}
            onChange={e => set({ category: e.target.value })}
            error={problems.categoryId !== undefined || problems.transferAccountId !== undefined}
            helperText={problems.categoryId ?? problems.transferAccountId}
            slotProps={{ htmlInput: { 'aria-label': 'Category or transfer' } }}
          >
            <MenuItem value="">(none)</MenuItem>
            {categories.map(c => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
            {transfers.length > 0 && <Divider />}
            {transfers.map(a => (
              <MenuItem key={a.id} value={`${TRANSFER}${a.id}`}>
                {form.decrease ? `Transfer to: ${a.name}` : `Transfer from: ${a.name}`}
              </MenuItem>
            ))}
          </TextField>

          <Stack direction="row" spacing={2}>
            <TextField
              label="Number" size="small" sx={{ width: 170 }} value={form.autoNumber ? '' : form.number}
              disabled={form.autoNumber}
              onChange={e => set({ number: e.target.value })}
              error={problems.number !== undefined} helperText={problems.number}
              slotProps={{ htmlInput: { maxLength: TRANSACTION_NUMBER_MAX_LENGTH, 'aria-label': 'Number' } }}
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={form.autoNumber} onChange={e => set({ autoNumber: e.target.checked })} />}
              label={<Typography variant="body2">Use the next cheque number</Typography>} />
          </Stack>

          <TextField
            label="Memo" size="small" fullWidth value={form.memo}
            onChange={e => set({ memo: e.target.value })}
            error={problems.memo !== undefined} helperText={problems.memo}
            slotProps={{ htmlInput: { maxLength: MEMO_MAX_LENGTH, 'aria-label': 'Memo' } }}
          />

          <Divider />
          <Typography variant="overline" color="text.secondary">When it repeats</Typography>
          <ScheduleEditor
            schedule={form.schedule}
            onChange={schedule => set({ schedule })}
            remindDays={form.remindDays}
            onRemindDays={remindDays => set({ remindDays })}
            // The transaction it was made from is already in the register, so the preview starts after it
            {...(input.mode === 'fromTransaction' && { previewFrom: addIsoDays(input.sourceDate, 1) })}
            calendar={{ holidays: input.holidays }}
          />
          {problems.schedule && <Alert severity="warning">{problems.schedule}</Alert>}

          <Divider />
          <TextField
            label="Name" size="small" fullWidth value={form.name}
            onChange={e => set({ name: e.target.value })}
            placeholder={form.payee.trim() || 'Taken from the payee'}
            error={problems.name !== undefined}
            helperText={problems.name ?? 'Shown in the list. Left empty, it takes the payee’s name.'}
            slotProps={{ htmlInput: { maxLength: SERIES_NAME_MAX_LENGTH, 'aria-label': 'Name' } }}
          />
          <TextField
            label="Notes" size="small" fullWidth multiline minRows={2} value={form.notes}
            onChange={e => set({ notes: e.target.value })}
            slotProps={{ htmlInput: { maxLength: SERIES_NOTES_MAX_LENGTH, 'aria-label': 'Notes' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close(undefined)}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>
          {input.mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Box>
  )
}
