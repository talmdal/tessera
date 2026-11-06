// Reconcile with Statement…: the statement's date, and the balances it starts and ends with. The starting balance is
// where the last reconciliation left the account, as Money fills it in; the user changes it only when the statement
// disagrees. For a credit card or loan the balances are amounts owed, as the statement prints them (stored negative).
//
// Below them, as in Money's Balance Account, the statement's service charge and interest: amounts the register
// doesn't have yet. Each becomes a transaction, already marked, when reconciling begins.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  amountToInput, categoryLabel, chargeLabel, formatAmount, isIsoDate, isLiability, parseAmount, todayIso,
  type ChargeKind, type ReconcileDialogInput, type StatementCharge, type StatementInput
} from '@tessera/accounts-api'
import { Alert, Autocomplete, Button, DialogActions, DialogContent, Stack, TextField, Typography } from '@tessera/ui'
import { showDate } from '../display'

/** One charge as typed. An empty date follows the statement date. */
export interface ChargeForm {
  amount: string
  date: string
  categoryId: string | null
}

export interface StatementForm {
  statementDate: string
  startingBalance: string
  statementBalance: string
  serviceCharge: ChargeForm
  interest: ChargeForm
}

type Field = 'statementDate' | 'startingBalance' | 'statementBalance' | ChargeKind
type Problems = Partial<Record<Field, string>>

const CHARGES: readonly ChargeKind[] = ['serviceCharge', 'interest']

/** The form's values from what the dialog was given. */
export function initialFigures(input: ReconcileDialogInput): StatementForm {
  const { account, current, lastReconciled, defaultCategories } = input
  const shown = (minor: number) => amountToInput(isLiability(account.type) ? -minor : minor, account.currency)
  const charge = (kind: ChargeKind): ChargeForm => ({ amount: '', date: '', categoryId: defaultCategories?.[kind] ?? null })
  return {
    statementDate: current?.statementDate ?? todayIso(),
    startingBalance: shown(current?.startingBalance ?? lastReconciled.balance),
    statementBalance: current ? shown(current.statementBalance) : '',
    serviceCharge: charge('serviceCharge'),
    interest: charge('interest')
  }
}

/** The figures as the service takes them (balances signed, charges unsigned), or what is wrong with each field. */
export function readFigures(form: StatementForm, input: ReconcileDialogInput): { figures?: StatementInput, problems: Problems } {
  const { account } = input
  const problems: Problems = {}
  if (!isIsoDate(form.statementDate)) problems.statementDate = 'Enter the statement date.'
  const signed = (field: 'startingBalance' | 'statementBalance', blank: string) => {
    if (form[field].trim() === '') { problems[field] = blank; return 0 }
    const parsed = parseAmount(form[field], account.currency)
    if (!parsed.ok) { problems[field] = parsed.message; return 0 }
    return isLiability(account.type) ? -parsed.value : parsed.value
  }
  const startingBalance = signed('startingBalance', 'Enter the balance the statement starts with.')
  const statementBalance = signed('statementBalance', 'Enter the balance the statement ends with.')

  // Optional: blank or zero adds nothing
  const charges: Partial<Record<ChargeKind, StatementCharge>> = {}
  for (const kind of CHARGES) {
    const typed = form[kind]
    if (typed.amount.trim() === '') continue
    const parsed = parseAmount(typed.amount, account.currency)
    if (!parsed.ok) { problems[kind] = parsed.message; continue }
    if (parsed.value < 0) { problems[kind] = 'Enter the amount as the statement shows it, without a sign.'; continue }
    if (parsed.value === 0) continue
    const date = typed.date === '' ? form.statementDate : typed.date
    if (!isIsoDate(date)) { problems[kind] = 'Enter the date.'; continue }
    charges[kind] = { amount: parsed.value, date, ...(typed.categoryId !== null && { categoryId: typed.categoryId }) }
  }

  if (Object.keys(problems).length > 0) return { problems }
  return { figures: { statementDate: form.statementDate, startingBalance, statementBalance, ...charges }, problems }
}

export default function ReconcileDialog({ input, close }: DialogProps<ReconcileDialogInput, StatementInput>) {
  const { account, lastReconciled, current } = input
  const liability = isLiability(account.type)
  const [form, setForm] = useState(() => initialFigures(input))
  const [problems, setProblems] = useState<Problems>({})

  const categories = useMemo(() => (input.categories ?? [])
    .map(category => ({ category, label: categoryLabel(input.categories, category.id) ?? category.name }))
    .sort((a, b) => a.label.localeCompare(b.label)), [input.categories])

  const set = (field: 'statementDate' | 'startingBalance' | 'statementBalance', value: string) => {
    setForm(f => ({ ...f, [field]: value }))
    setProblems(p => ({ ...p, [field]: undefined }))
  }
  const setCharge = (kind: ChargeKind, change: Partial<ChargeForm>) => {
    setForm(f => ({ ...f, [kind]: { ...f[kind], ...change } }))
    setProblems(p => ({ ...p, [kind]: undefined }))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const read = readFigures(form, input)
    if (!read.figures) { setProblems(read.problems); return }
    close(read.figures)
  }

  // A starting balance other than the ledger's: completing will offer an adjustment for the difference
  const typed = form.startingBalance.trim() === '' ? undefined : parseAmount(form.startingBalance, account.currency)
  const differs = typed?.ok === true && (liability ? -typed.value : typed.value) !== lastReconciled.balance
  const owed = (minor: number) => formatAmount(liability ? -minor : minor, account.currency)
  const field = (name: Field, helper: string) => ({
    error: problems[name] !== undefined, helperText: problems[name] ?? helper
  })

  const chargeRow = (kind: ChargeKind) => {
    const label = chargeLabel(kind, account.type)
    const charge = form[kind]
    const chosen = categories.find(c => c.category.id === charge.categoryId) ?? null
    return (
      <Stack direction="row" spacing={1} data-charge={kind}>
        <TextField size="small" label={label} value={charge.amount} sx={{ flex: 1 }}
          onChange={event => setCharge(kind, { amount: event.target.value })} {...field(kind, ' ')}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
        <TextField size="small" type="date" label={`${label} date`} value={charge.date || form.statementDate} sx={{ flex: 1 }}
          onChange={event => setCharge(kind, { date: event.target.value })} helperText=" "
          slotProps={{ inputLabel: { shrink: true } }} />
        <Autocomplete
          size="small"
          sx={{ flex: 1.4 }}
          options={categories}
          value={chosen}
          onChange={(_event, value) => setCharge(kind, { categoryId: value?.category.id ?? null })}
          getOptionLabel={option => option.label}
          isOptionEqualToValue={(a, b) => a.category.id === b.category.id}
          renderOption={(props, option) => <li {...props} key={option.category.id}>{option.label}</li>}
          // margin="none": nested in the Autocomplete, the field would otherwise keep the theme's dense top margin
          renderInput={params => <TextField {...params} margin="none" label={`${label} category`} helperText=" " />}
        />
      </Stack>
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {current
              ? `You are part way through reconciling “${account.name}” with the statement of ${showDate(current.statementDate)}. Check the figures, then carry on.`
              : `Enter the figures from the “${account.name}” statement. Next, you mark the transactions it lists.`}
          </Typography>
          <TextField size="small" type="date" label="Statement date" value={form.statementDate} autoFocus sx={{ maxWidth: 220 }}
            onChange={event => set('statementDate', event.target.value)} {...field('statementDate', ' ')}
            slotProps={{ inputLabel: { shrink: true } }} />
          <Stack direction="row" spacing={1}>
            <TextField size="small" label={liability ? 'Starting amount owed' : 'Starting balance'} value={form.startingBalance} sx={{ flex: 1 }}
              onChange={event => set('startingBalance', event.target.value)}
              {...field('startingBalance', lastReconciled.date
                ? `Reconciled to ${showDate(lastReconciled.date)}: ${owed(lastReconciled.balance)}`
                : `Not reconciled before: ${owed(lastReconciled.balance)} from the opening balance`)}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
            <TextField size="small" label={liability ? 'Ending amount owed' : 'Ending balance'} value={form.statementBalance} sx={{ flex: 1 }}
              onChange={event => set('statementBalance', event.target.value)} {...field('statementBalance', ' ')}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
          </Stack>
          {differs && (
            <Alert severity="info">
              The statement starts from a different balance than your reconciled records. If it still differs when you
              finish, you can add a balance adjustment for it.
            </Alert>
          )}

          <Stack spacing={1}>
            <Typography variant="subtitle2" component="h3">Charges and interest on the statement</Typography>
            <Typography variant="body2" color="text.secondary">
              {current
                ? 'Optional. Any you entered before are already in the register; amounts here are added as new transactions.'
                : 'Optional. Each amount is added to the register as a transaction, already marked as on the statement.'}
            </Typography>
            {chargeRow('serviceCharge')}
            {chargeRow('interest')}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button type="submit" variant="contained">{current ? 'Continue' : 'Next'}</Button>
      </DialogActions>
    </form>
  )
}
