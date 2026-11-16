// New Budget… and Budget Properties…: one form. It checks what it can as the user types (the rules the service
// enforces), suggests the currency most accounts in the scope use, and says which accounts the currency leaves out.
// Saved through the plugin, so a name already taken is shown on the name field and the dialog stays.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { LEDGER_NAME_MAX_LENGTH, descendantIds, flattenTree, validateLedgerName } from '@tessera/ledger-api'
import { currencyCodes, isCurrencyCode, minorDigits, mostUsedCurrency } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, BUDGET_NOTES_MAX_LENGTH, DEFAULT_HISTORY_MONTHS,
  type Budget, type BudgetDialogInput, type BudgetDialogResult, type BudgetInput, type BudgetResult, type SaveBudgetRequest, type ScopeAccount
} from '@tessera/budget-api'
import { Alert, Autocomplete, Button, DialogActions, DialogContent, FormControlLabel, MenuItem, Radio, RadioGroup, Stack, TextField, Typography } from '@tessera/ui'
import { monthOnly } from './display'

/** The select's value for the whole ledger (sub-ledgers use their ids). */
export const WHOLE_LEDGER = '(ledger)'

type Field = 'name' | 'subLedgerId' | 'currency' | 'yearStartMonth' | 'notes'

interface Form {
  name: string
  covers: string
  currency: string
  yearStartMonth: number
  notes: string
}

/** The accounts a scope covers: a sub-ledger and every one beneath it, or the whole ledger. */
export function accountsIn(covers: string, input: Pick<BudgetDialogInput, 'subLedgers' | 'accounts'>): ScopeAccount[] {
  if (covers === WHOLE_LEDGER) return input.accounts
  const within = new Set([covers, ...descendantIds(input.subLedgers, covers)])
  return input.accounts.filter(a => a.subLedgerId !== null && within.has(a.subLedgerId))
}

/** "Not counted: US Visa, in USD", for the accounts in the scope the currency leaves out; undefined when none is. */
export function notCountedNote(accounts: readonly ScopeAccount[], currency: string): string | undefined {
  const left = accounts.filter(a => a.currency !== currency).sort((a, b) => a.name.localeCompare(b.name))
  if (left.length === 0) return undefined
  return `Not counted: ${left.map(a => `${a.name}, in ${a.currency}`).join('; ')}`
}

/**
 * Budget Properties…: why a currency can't be chosen, as the service would refuse it. A budget's amounts are kept in
 * minor units, so in a currency with other decimals they would mean other amounts; a budget with no lines can change.
 */
export function currencyProblem(input: Pick<BudgetDialogInput, 'budget' | 'lineCount'>, currency: string): string | undefined {
  const code = currency.trim().toUpperCase()
  const from = input.budget?.currency
  if (!from || code === from || !isCurrencyCode(code) || (input.lineCount ?? 0) === 0 || minorDigits(code) === minorDigits(from)) return undefined
  const places = (c: string) => { const d = minorDigits(c); return d === 0 ? 'no decimal places' : d === 1 ? '1 decimal place' : `${d} decimal places` }
  return `Its lines are planned in ${from}, which has ${places(from)}; ${code} has ${places(code)}. Make a new budget to plan in ${code}.`
}

/**
 * Budget Properties…: the transfer lines a scope and currency would leave counting nothing, by label. A transfer counts
 * only with an account outside the scope, in the budget's currency (docs/budget-design.md, "Transfers across the
 * budget's scope").
 */
export function strandedLines(input: Pick<BudgetDialogInput, 'transferLines' | 'subLedgers' | 'accounts'>, covers: string, currency: string): string[] {
  const inside = new Set(accountsIn(covers, input).map(a => a.id))
  const code = currency.trim().toUpperCase()
  return (input.transferLines ?? []).filter(line => {
    const account = input.accounts.find(a => a.id === line.accountId)
    return account !== undefined && (inside.has(account.id) || account.currency !== code)
  }).map(line => line.label)
}

/** Whether the form changes what the budget covers, or its currency. */
const changed = (a: Budget, f: Form) => (a.subLedgerId ?? WHOLE_LEDGER) !== f.covers || a.currency !== f.currency.trim().toUpperCase()

/** The form as a `BudgetInput`, or the problems that stop it being one. */
export function toInput(form: Form): { input?: BudgetInput, problems: Partial<Record<Field, string>> } {
  const problems: Partial<Record<Field, string>> = {}
  const nameProblem = validateLedgerName(form.name)
  if (nameProblem) problems.name = nameProblem
  const currency = form.currency.trim().toUpperCase()
  if (!isCurrencyCode(currency)) problems.currency = 'Choose a currency, like CAD.'
  if (form.notes.trim().length > BUDGET_NOTES_MAX_LENGTH) problems.notes = `Use at most ${BUDGET_NOTES_MAX_LENGTH} characters.`
  if (Object.keys(problems).length > 0) return { problems }
  return {
    input: {
      name: form.name.trim(), subLedgerId: form.covers === WHOLE_LEDGER ? null : form.covers, currency, yearStartMonth: form.yearStartMonth,
      ...(form.notes.trim() !== '' && { notes: form.notes.trim() })
    },
    problems
  }
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

export default function BudgetDialog({ input, close, setBusy }: DialogProps<BudgetDialogInput, BudgetDialogResult>) {
  const editing = input.budget
  const [form, setForm] = useState<Form>(() => {
    const covers = editing ? editing.subLedgerId ?? WHOLE_LEDGER : input.subLedgerId ?? WHOLE_LEDGER
    return {
      name: editing?.name ?? '', covers,
      currency: editing?.currency ?? mostUsedCurrency(accountsIn(covers, input), input.defaultCurrency),
      yearStartMonth: editing?.yearStartMonth ?? input.yearStartMonth,
      notes: editing?.notes ?? ''
    }
  })
  // A new budget's currency follows its scope until the user chooses one
  const [currencyChosen, setCurrencyChosen] = useState(editing !== undefined)
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)
  // A new budget: no lines, or straight into Fill from History
  const [startWith, setStartWith] = useState<'empty' | 'history'>('empty')

  const places = useMemo(() => [
    { value: WHOLE_LEDGER, label: `${input.ledgerName} (the whole ledger)`, depth: 0 },
    ...flattenTree(input.subLedgers).map(({ subLedger, depth, hasChildren }) =>
      ({ value: subLedger.id, label: hasChildren ? `${subLedger.name} and its sub-ledgers` : subLedger.name, depth: depth + 1 }))
  ], [input])
  const currencies = useMemo(() => {
    const codes = currencyCodes()
    return codes.length > 0 ? codes : [input.defaultCurrency]
  }, [input.defaultCurrency])

  const inScope = accountsIn(form.covers, input)
  const note = isCurrencyCode(form.currency) ? notCountedNote(inScope, form.currency) : undefined
  const { input: budgetInput, problems } = toInput(form)
  // What a new currency or scope would do to the budget's lines: a currency refused, and transfer lines left counting nothing
  const blocked = editing ? currencyProblem(input, form.currency) : undefined
  if (blocked) problems.currency = blocked
  const stranded = editing && changed(editing, form) ? strandedLines(input, form.covers, form.currency) : []
  const problem = (field: Field) => server?.field === field ? server.message
    : (touched[field] || submitted || (field === 'currency' && blocked)) ? problems[field] : undefined
  const text = (field: Field) => ({ error: problem(field) !== undefined, helperText: problem(field) ?? ' ', onBlur: () => setTouched(t => ({ ...t, [field]: true })) })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm(current => {
      const next = { ...current, [key]: value }
      if (key === 'covers' && !currencyChosen) next.currency = mostUsedCurrency(accountsIn(next.covers, input), current.currency)
      return next
    })
    setServer(undefined)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (!budgetInput || blocked || saving) return
    setSaving(true)
    setBusy(true)
    try {
      const request: SaveBudgetRequest = editing ? { id: editing.id, input: budgetInput, expectedRev: editing.rev } : { input: budgetInput }
      const result = await window.api.invoke<BudgetResult<Budget>>(BUDGET_CHANNELS.saveBudget, request)
      if (result.ok) { close({ id: result.value.id, ...(!editing && startWith === 'history' && { fill: true }) }); return }
      setServer(result.error)
    } catch (err) {
      setServer({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          <TextField autoFocus required size="small" label="Name" value={form.name} onChange={event => set('name', event.target.value)} {...text('name')}
            slotProps={{ htmlInput: { maxLength: LEDGER_NAME_MAX_LENGTH } }} />
          <TextField select size="small" label="Covers" value={form.covers} onChange={event => set('covers', event.target.value)} {...text('subLedgerId')}>
            {places.map(place => <MenuItem key={place.value} value={place.value} sx={{ pl: 2 + place.depth * 2 }}>{place.label}</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1}>
            <Autocomplete
              size="small" sx={{ flex: 1 }} options={currencies}
              value={isCurrencyCode(form.currency) ? form.currency : null}
              onChange={(_event, value) => { setCurrencyChosen(true); set('currency', value ?? '') }}
              renderInput={params => <TextField {...params} margin="none" label="Currency" {...text('currency')}
                helperText={problem('currency') ?? note ?? 'Only accounts in this currency count.'} />}
            />
            <TextField select size="small" label="Year starts" value={form.yearStartMonth} sx={{ flex: 1 }} margin="none"
              onChange={event => set('yearStartMonth', Number(event.target.value))} {...text('yearStartMonth')}
              helperText="What Year to date means">
              {MONTHS.map(m => <MenuItem key={m} value={m}>{monthOnly(`2000-${String(m).padStart(2, '0')}`)}</MenuItem>)}
            </TextField>
          </Stack>
          <TextField size="small" label="Notes" value={form.notes} multiline minRows={2} onChange={event => set('notes', event.target.value)} {...text('notes')}
            slotProps={{ htmlInput: { maxLength: BUDGET_NOTES_MAX_LENGTH } }} />
          {!editing && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2" color="text.secondary" sx={{ pt: 1, minWidth: '5.5em' }}>Start with</Typography>
              <RadioGroup value={startWith} onChange={event => setStartWith(event.target.value as 'empty' | 'history')}>
                <FormControlLabel value="empty" control={<Radio size="small" />} label="No lines" />
                <FormControlLabel value="history" control={<Radio size="small" />} label={`Amounts from my last ${DEFAULT_HISTORY_MONTHS} months`} />
              </RadioGroup>
            </Stack>
          )}
          {editing && changed(editing, form) && (
            <Typography variant="body2" color="text.secondary" data-note="scope-changed">
              A new scope or currency changes which transactions count, in every month; the lines stay as they are.
            </Typography>
          )}
          {stranded.length > 0 && (
            <Alert severity="warning" data-note="stranded">
              {stranded.length === 1 ? `The line “${stranded[0]}” would count nothing` : `The lines ${stranded.map(l => `“${l}”`).join(', ')} would count nothing`}:
              {' '}transfers count only with an account outside the budget, in its currency.
            </Alert>
          )}
          {server && server.field === undefined && <Alert severity="error">{server.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>{editing ? 'Save' : 'Create'}</Button>
      </DialogActions>
    </form>
  )
}
