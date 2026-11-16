// New Line… and Edit Line…: what a line is for (new lines only), how much, how often and when it is due, and for an
// edit, from which month the change applies (or to the month shown only). The preview shows the budget year the change
// lands in, worked out with the service's own functions. Saved through the plugin; problems show on their fields and
// the dialog stays. A line changed elsewhere since the dialog opened is reloaded, keeping what was typed.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { type Category } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, BUDGET_NOTES_MAX_LENGTH, FREQUENCIES, FREQUENCY_LABELS, isMonth,
  type AddLineRequest, type BudgetLine, type BudgetResult, type ChangeLineRequest, type Frequency, type LineDialogInput,
  type PlanChange, type TargetChoice
} from '@tessera/budget-api'
import {
  Alert, Autocomplete, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, MenuItem, Radio, RadioGroup, Stack,
  TextField, Typography
} from '@tessera/ui'
import { amount as shown, monthName, shortMonth } from './display'
import {
  basePlan, changeOf, checkForm, initialForm, laterPlans, lineAfter, needsDay, planChanged, preview, scheduleChanged, secondDayHint,
  withNoDay, type LineField, type LineForm
} from './lineForm'

type Option = TargetChoice | { create: 'income' | 'expense', path: string, label: string }
const isCreate = (o: Option | null): o is Extract<Option, { create: string }> => o !== null && 'create' in o

export default function LineDialog({ input, close, setBusy }: DialogProps<LineDialogInput, { id: string }>) {
  const { budget, month } = input
  const [line, setLine] = useState<BudgetLine | undefined>(input.line)
  const [form, setForm] = useState<LineForm>(() => initialForm(input))
  const [choices, setChoices] = useState<TargetChoice[]>(input.choices ?? [])
  const [typed, setTyped] = useState('')
  const [touched, setTouched] = useState<Partial<Record<LineField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<{ message: string, field?: string }>()
  const [notice, setNotice] = useState<string>()
  const [saving, setSaving] = useState(false)

  const editing = line !== undefined
  const base = line ? basePlan(line, month) : undefined
  const checked = checkForm(form, budget.currency, { needsTarget: !editing })
  const { plan } = checked
  const changedPlan = plan !== undefined && base !== undefined && planChanged(plan, base)
  const onlyAllowed = plan === undefined || base === undefined || !scheduleChanged(plan, base)
  const ownAmount = line?.overrides?.[month]
  const apply = onlyAllowed ? form.apply : 'from'
  const later = apply === 'from' ? laterPlans(line, form.from) : []

  // The change this save would make, and the line after it, for the preview
  const change: PlanChange | undefined = !plan ? undefined
    : !editing ? { apply: 'from', plan }
    : changedPlan || (apply === 'only' && ownAmount !== plan.amount) ? changeOf({ ...form, apply }, plan, month) : undefined
  const after = useMemo(() => change ? lineAfter(line, change) : line, [change && JSON.stringify(change), line])
  const shownYear = useMemo(() => after ? preview(after, apply === 'only' ? month : form.from, budget.yearStartMonth) : undefined,
    [after, apply, form.from, month, budget.yearStartMonth])

  const problem = (field: LineField) =>
    server?.field === field ? server.message : (touched[field] || submitted) ? checked.problems[field] : undefined
  const text = (field: LineField) => ({ error: problem(field) !== undefined, helperText: problem(field) ?? ' ', onBlur: () => setTouched(t => ({ ...t, [field]: true })) })
  const set = (next: Partial<LineForm>) => { setForm(current => ({ ...current, ...next })); setServer(undefined) }

  const options: Option[] = choices
  const createCategory = async (option: Extract<Option, { create: string }>) => {
    setServer(undefined)
    const result = await window.api.invoke<BudgetResult<Category>>(BUDGET_CHANNELS.createCategory, { path: option.path, kind: option.create })
    if (!result.ok) { setServer({ message: result.error.message, field: 'target' }); return }
    const label = option.path.split(':').map(p => p.trim()).filter(Boolean).join(' : ')
    const choice: TargetChoice = { target: { kind: 'category', categoryId: result.value.id }, group: result.value.kind, label }
    setChoices(current => [...current, choice].sort((a, b) => a.label.localeCompare(b.label)))
    set({ target: choice })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    setNotice(undefined)
    if (!plan || saving) return
    setSaving(true)
    setBusy(true)
    try {
      let result: BudgetResult<BudgetLine>
      if (!line) {
        const request: AddLineRequest = {
          budgetId: budget.id,
          input: { target: form.target!.target, plan, ...(form.notes.trim() !== '' && { notes: form.notes.trim() }) }
        }
        result = await window.api.invoke<BudgetResult<BudgetLine>>(BUDGET_CHANNELS.addLine, request)
      } else {
        const notes = form.notes.trim() === (line.notes ?? '') ? undefined : form.notes.trim() === '' ? null : form.notes.trim()
        if (change === undefined && notes === undefined) { close({ id: line.id }); return }
        const request: ChangeLineRequest = { lineId: line.id, expectedRev: line.rev, ...(change && { change }), ...(notes !== undefined && { notes }) }
        result = await window.api.invoke<BudgetResult<BudgetLine>>(BUDGET_CHANNELS.changeLine, request)
      }
      if (result.ok) { close({ id: result.value.id }); return }
      if (result.error.code === 'CONFLICT' && line) {
        // Changed elsewhere: load it as it is now, keep what was typed, and let the user save again
        const now = await window.api.invoke<BudgetResult<BudgetLine>>(BUDGET_CHANNELS.line, { lineId: line.id })
        if (now.ok) {
          setLine(now.value)
          setNotice('This line was changed elsewhere. It has been reloaded, and what you typed is kept: check the preview, and save again.')
          return
        }
      }
      setServer(result.error)
    } catch (err) {
      setServer({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  const frequencyChange = (frequency: Frequency) => setForm(current => {
    const next = { ...current, frequency }
    return needsDay(frequency) ? withNoDay(next, false) : next
  })
  const dayless = form.noDay && !needsDay(form.frequency)

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {editing
            ? <Typography variant="body2" data-line-for>For <strong>{input.label}</strong>{input.group === 'income' ? ' (income)' : ''}</Typography>
            : (
              <Autocomplete<Option>
                size="small" autoHighlight
                options={options}
                value={form.target}
                groupBy={option => isCreate(option) ? 'New category' : option.target.kind === 'transfer' ? 'Transfers' : option.group === 'income' ? 'Income' : 'Expenses'}
                getOptionLabel={option => option.label}
                isOptionEqualToValue={(a, b) => !isCreate(a) && !isCreate(b) && JSON.stringify(a.target) === JSON.stringify(b.target)}
                inputValue={typed}
                onInputChange={(_event, value) => setTyped(value)}
                filterOptions={(all, state) => {
                  const wanted = state.inputValue.trim()
                  const matches = all.filter(o => o.label.toLowerCase().includes(wanted.toLowerCase()))
                  const exact = all.some(o => o.label.toLowerCase() === wanted.toLowerCase())
                  if (wanted === '' || exact || input.canCreateCategory !== true || wanted.toLowerCase().startsWith('transfer')) return matches
                  return [
                    ...matches,
                    { create: 'expense', path: wanted, label: `Create expense category “${wanted}”` },
                    { create: 'income', path: wanted, label: `Create income category “${wanted}”` }
                  ]
                }}
                onChange={(_event, value) => {
                  if (isCreate(value)) void createCategory(value)
                  else set({ target: value })
                }}
                renderInput={params => <TextField {...params} autoFocus margin="none" label="For" required {...text('target')} />}
              />
            )}

          <Stack direction="row" spacing={1}>
            <TextField autoFocus={editing} size="small" label="Amount" value={form.amount} sx={{ flex: 1 }} onChange={event => set({ amount: event.target.value })}
              {...text('amount')} slotProps={{ htmlInput: { inputMode: 'decimal', style: { textAlign: 'right' } } }} />
            <TextField select size="small" label="How often" value={form.frequency} sx={{ flex: 1.4 }} onChange={event => frequencyChange(event.target.value as Frequency)} {...text('frequency')}>
              {FREQUENCIES.map(f => <MenuItem key={f} value={f}>{FREQUENCY_LABELS[f]}</MenuItem>)}
            </TextField>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            {dayless
              ? <TextField size="small" type="month" label="First due in" value={form.due} sx={{ flex: 1 }} onChange={event => set({ due: event.target.value })}
                  {...text('due')} slotProps={{ inputLabel: { shrink: true } }} />
              : <TextField size="small" type="date" label="First due" value={form.due} sx={{ flex: 1 }} onChange={event => set({ due: event.target.value })}
                  {...text('due')} slotProps={{ inputLabel: { shrink: true } }} />}
            <FormControlLabel sx={{ flex: 1.4, ml: 0, mt: 0.5 }} disabled={needsDay(form.frequency)}
              control={<Checkbox size="small" checked={dayless} onChange={event => setForm(current => withNoDay(current, event.target.checked))} />}
              label="No particular day" />
          </Stack>
          {form.frequency === 'twiceAMonth' && (
            <TextField size="small" label="Second day" value={form.secondDay} onChange={event => set({ secondDay: event.target.value })}
              {...text('secondDay')} helperText={problem('secondDay') ?? `Leave empty for ${secondDayHint(form)}.`}
              slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 2 } }} sx={{ maxWidth: '12em' }} />
          )}

          {editing && (changedPlan || ownAmount !== undefined) && (
            <Box data-apply>
              <Typography variant="body2" color="text.secondary">Apply</Typography>
              <RadioGroup value={apply} onChange={event => set({ apply: event.target.value as 'from' | 'only' })}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <FormControlLabel value="from" control={<Radio size="small" />} label="From" sx={{ mr: 0 }} />
                  <TextField size="small" type="month" margin="none" value={form.from} disabled={apply !== 'from'}
                    onChange={event => { if (isMonth(event.target.value)) set({ from: event.target.value }) }}
                    slotProps={{ htmlInput: { 'aria-label': 'Apply from' } }} sx={{ width: '11em' }} />
                  <Typography variant="body2">on</Typography>
                </Stack>
                <FormControlLabel value="only" disabled={!onlyAllowed} control={<Radio size="small" />} label={`${monthName(month)} only`} />
              </RadioGroup>
              {!onlyAllowed && <Typography variant="caption" color="text.secondary">Only the amount can change for a single month.</Typography>}
              {later.length > 0 && (
                <FormControlLabel
                  control={<Checkbox size="small" checked={form.replaceLater} onChange={event => set({ replaceLater: event.target.checked })} />}
                  label={`Replace the later ${later.length === 1 ? 'change' : 'changes'}, from ${later.map(p => monthName(p.from)).join(', ')}`} />
              )}
              {ownAmount !== undefined && (
                <Typography variant="caption" color="text.secondary" component="div">
                  {monthName(month)} has its own amount, {shown(ownAmount, budget.currency)}.
                </Typography>
              )}
            </Box>
          )}

          {shownYear && <Preview months={shownYear.months} total={shownYear.total} currency={budget.currency} />}

          <TextField size="small" label="Notes" value={form.notes} multiline minRows={2} onChange={event => set({ notes: event.target.value })}
            {...text('notes')} slotProps={{ htmlInput: { maxLength: BUDGET_NOTES_MAX_LENGTH } }} />

          {notice && <Alert severity="warning">{notice}</Alert>}
          {server && (server.field === undefined || !['target', 'amount', 'frequency', 'due', 'secondDay', 'from', 'notes'].includes(server.field)) && <Alert severity="error">{server.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>{editing ? 'Save' : 'Add Line'}</Button>
      </DialogActions>
    </form>
  )
}

/** The budget year, month by month, with the days it falls due, and its total. */
function Preview({ months, total, currency }: { months: { month: string, amount: number, due: string[], own: boolean }[], total: number, currency: string }) {
  const from = months[0].month, to = months[months.length - 1].month
  return (
    <Box component="section" aria-label="Preview" data-preview sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
      <Typography variant="caption" color="text.secondary">{from.slice(0, 4) === to.slice(0, 4) ? from.slice(0, 4) : `${monthName(from)} to ${monthName(to)}`}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(9.5em, 1fr))', columnGap: 1.5, rowGap: 0.25 }}>
        {months.map(m => (
          <Typography key={m.month} variant="body2" data-preview-month={m.month} sx={{ whiteSpace: 'nowrap' }}>
            <Box component="span" sx={{ color: 'text.secondary', mr: 0.5 }}>{shortMonth(m.month)}</Box>
            <Box component="span" sx={{ typography: 'numeric' }}>{m.amount === 0 ? '—' : shown(m.amount, currency)}</Box>
            {m.due.length > 0 && <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.85em' }}> (due {m.due.map(d => Number(d.slice(8, 10))).join(', ')})</Box>}
            {m.own && <Box component="span" sx={{ color: 'text.secondary' }} title="Its own amount"> •</Box>}
          </Typography>
        ))}
      </Box>
      <Typography variant="body2" sx={{ mt: 0.5 }} data-preview-total>Year <Box component="span" sx={{ typography: 'numeric' }}>{shown(total, currency)}</Box></Typography>
    </Box>
  )
}
