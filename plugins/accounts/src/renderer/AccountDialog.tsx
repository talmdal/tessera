// New Account… and Edit Account…: one form. It checks what it can as the user types (the same rules the service
// enforces), then saves through the plugin, so a name already taken is shown on the name field and the dialog stays.
import { FormEvent, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { flattenTree } from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNT_CLASS, ACCOUNT_NAME_MAX_LENGTH, ACCOUNT_NOTES_MAX_LENGTH, ACCOUNT_NUMBER_MAX_LENGTH,
  ACCOUNT_TEXT_MAX_LENGTH, ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, CREDIT_LIMIT_TYPES, MINIMUM_BALANCE_TYPES, amountToInput, currencyCodes,
  isCurrencyCode, isIsoDate, isLiability, parseAmount, todayIso, validateAccountName,
  type Account, type AccountDialogInput, type AccountInput, type AccountType, type AccountsResult, type SaveAccountRequest
} from '@tessera/accounts-api'
import { Alert, Autocomplete, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, MenuItem, Stack, TextField } from '@tessera/ui'

/** The select's value for the ledger itself (sub-ledgers use their ids). */
export const IN_LEDGER = '(ledger)'

type Field = 'name' | 'type' | 'subLedgerId' | 'currency' | 'openingDate' | 'openingBalance' | 'creditLimit' | 'minimumBalance'
  | 'showAvailableBalance' | 'institution' | 'accountNumber' | 'notes'

const currencyName = (() => {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'currency' })
    return (code: string) => names.of(code) ?? code
  } catch {
    return (code: string) => code
  }
})()

const ASSETS = ACCOUNT_TYPES.filter(t => ACCOUNT_CLASS[t] === 'asset')
const LIABILITIES = ACCOUNT_TYPES.filter(t => ACCOUNT_CLASS[t] === 'liability')

/** What the form holds: text as typed, so nothing is lost or reformatted while the user edits. */
interface Form {
  name: string
  type: AccountType
  subLedger: string
  currency: string
  openingDate: string
  /** As entered: for a liability, the amount owed (stored negative). */
  openingBalance: string
  creditLimit: string
  minimumBalance: string
  /** Show the balance less the minimum. */
  showAvailableBalance: boolean
  institution: string
  accountNumber: string
  notes: string
}

/** Minor units as the form shows them; as they are when the currency isn't one, so a bad currency never stops the form. */
function shownAmount(minor: number, currency: string): string {
  return isCurrencyCode(currency) ? amountToInput(minor, currency) : String(minor)
}

/** An account's values as the form holds them: text as typed, and what a liability owes shown as a positive amount. */
function formOf(a: Omit<AccountInput, 'subLedgerId'> & { subLedgerId: string | null }): Form {
  const shown = isLiability(a.type) ? -a.openingBalance : a.openingBalance
  return {
    name: a.name, type: a.type, subLedger: a.subLedgerId ?? IN_LEDGER, currency: a.currency, openingDate: a.openingDate,
    openingBalance: shownAmount(shown, a.currency), creditLimit: a.creditLimit === undefined ? '' : shownAmount(a.creditLimit, a.currency),
    minimumBalance: a.minimumBalance === undefined ? '' : shownAmount(a.minimumBalance, a.currency),
    showAvailableBalance: a.showAvailableBalance === true,
    institution: a.institution ?? '', accountNumber: a.accountNumber ?? '', notes: a.notes ?? ''
  }
}

function initialForm(input: AccountDialogInput): Form {
  if (input.mode === 'edit') return formOf(input.account)
  // A new account starts blank, or from what the caller knows (an importer's statement): still checked as typed
  const initial = input.initial ?? {}
  return formOf({
    name: '', type: 'chequing', currency: input.defaultCurrency, openingDate: todayIso(), openingBalance: 0,
    ...initial,
    subLedgerId: initial.subLedgerId !== undefined ? initial.subLedgerId : input.subLedgerId
  })
}

/** The form as an `AccountInput`, or the problems that stop it being one. */
export function toInput(form: Form): { input?: AccountInput, problems: Partial<Record<Field, string>> } {
  const problems: Partial<Record<Field, string>> = {}
  const nameProblem = validateAccountName(form.name)
  if (nameProblem) problems.name = nameProblem
  const currency = form.currency.trim().toUpperCase()
  if (!isCurrencyCode(currency)) problems.currency = 'Choose a currency, like CAD.'
  if (!isIsoDate(form.openingDate)) problems.openingDate = 'Enter the date the account opened.'

  let openingBalance = 0
  let creditLimit: number | undefined
  let minimumBalance: number | undefined
  if (!problems.currency) {
    const balance = parseAmount(form.openingBalance.trim() === '' ? '0' : form.openingBalance, currency)
    if (balance.ok) openingBalance = isLiability(form.type) ? -balance.value : balance.value
    else problems.openingBalance = balance.message
    if (CREDIT_LIMIT_TYPES.includes(form.type) && form.creditLimit.trim() !== '') {
      const limit = parseAmount(form.creditLimit, currency)
      if (!limit.ok) problems.creditLimit = limit.message
      else if (limit.value < 0) problems.creditLimit = 'Enter a credit limit of zero or more.'
      else creditLimit = limit.value
    }
    if (MINIMUM_BALANCE_TYPES.includes(form.type) && form.minimumBalance.trim() !== '') {
      const minimum = parseAmount(form.minimumBalance, currency)
      if (!minimum.ok) problems.minimumBalance = minimum.message
      else if (minimum.value < 0) problems.minimumBalance = 'Enter a minimum balance of zero or more.'
      else minimumBalance = minimum.value
    }
  }
  const showAvailableBalance = MINIMUM_BALANCE_TYPES.includes(form.type) && form.showAvailableBalance
  if (showAvailableBalance && minimumBalance === undefined && !problems.minimumBalance) {
    problems.minimumBalance = 'Enter the minimum balance, to show the balance above it.'
  }
  if (Object.keys(problems).length > 0) return { problems }

  const optional = (value: string) => value.trim() === '' ? undefined : value.trim()
  const input: AccountInput = {
    name: form.name.trim(), type: form.type, subLedgerId: form.subLedger === IN_LEDGER ? null : form.subLedger, currency,
    openingDate: form.openingDate, openingBalance,
    ...(creditLimit !== undefined && { creditLimit }),
    ...(minimumBalance !== undefined && { minimumBalance }),
    ...(showAvailableBalance && { showAvailableBalance: true }),
    ...(optional(form.institution) !== undefined && { institution: optional(form.institution) }),
    ...(optional(form.accountNumber) !== undefined && { accountNumber: optional(form.accountNumber) }),
    ...(optional(form.notes) !== undefined && { notes: optional(form.notes) })
  }
  return { input, problems }
}

export default function AccountDialog({ input, close, setBusy }: DialogProps<AccountDialogInput, { id: string }>) {
  const [form, setForm] = useState(() => initialForm(input))
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)

  const places = useMemo(() => [
    { value: IN_LEDGER, label: input.ledgerName, depth: 0 },
    ...flattenTree(input.subLedgers).map(({ subLedger, depth }) => ({ value: subLedger.id, label: subLedger.name, depth: depth + 1 }))
  ], [input])
  const currencies = useMemo(() => {
    const codes = currencyCodes()
    return codes.length > 0 ? codes : [input.defaultCurrency]
  }, [input.defaultCurrency])

  const { input: account, problems } = toInput(form)
  const problem = (field: Field) =>
    server?.field === field ? server.message : (touched[field] || submitted) ? problems[field] : undefined
  const liability = isLiability(form.type)
  const hasLimit = CREDIT_LIMIT_TYPES.includes(form.type)
  const hasMinimum = MINIMUM_BALANCE_TYPES.includes(form.type)

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm(current => ({ ...current, [key]: value }))
    setServer(undefined)
  }
  const touch = (field: Field) => () => setTouched(current => ({ ...current, [field]: true }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (!account || saving) return
    setSaving(true)
    setBusy(true)
    try {
      const request: SaveAccountRequest = input.mode === 'edit'
        ? { id: input.account.id, input: account, expectedRev: input.account.rev }
        : { input: account }
      const result = await window.api.invoke<AccountsResult<Account>>(ACCOUNTS_CHANNELS.saveAccount, request)
      if (result.ok) { close({ id: result.value.id }); return }
      setServer(result.error)
    } catch (err) {
      setServer({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  const text = (field: Field) => ({
    error: problem(field) !== undefined,
    helperText: problem(field) ?? ' ',
    onBlur: touch(field)
  })

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          <TextField autoFocus required size="small" label="Name" value={form.name}
            onChange={event => set('name', event.target.value)} {...text('name')}
            slotProps={{ htmlInput: { maxLength: ACCOUNT_NAME_MAX_LENGTH } }} />

          <Stack direction="row" spacing={1}>
            <TextField select size="small" label="Type" value={form.type} sx={{ flex: 1 }}
              onChange={event => set('type', event.target.value as AccountType)} {...text('type')}>
              <MenuItem disabled divider>Assets</MenuItem>
              {ASSETS.map(type => <MenuItem key={type} value={type} sx={{ pl: 3 }}>{ACCOUNT_TYPE_LABELS[type]}</MenuItem>)}
              <MenuItem disabled divider>Liabilities</MenuItem>
              {LIABILITIES.map(type => <MenuItem key={type} value={type} sx={{ pl: 3 }}>{ACCOUNT_TYPE_LABELS[type]}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="In" value={form.subLedger} sx={{ flex: 1 }}
              onChange={event => set('subLedger', event.target.value)} {...text('subLedgerId')}>
              {places.map(place => <MenuItem key={place.value} value={place.value} sx={{ pl: 2 + place.depth * 2 }}>{place.label}</MenuItem>)}
            </TextField>
          </Stack>

          <Stack direction="row" spacing={1}>
            <TextField size="small" type="date" label="Opened" value={form.openingDate} sx={{ flex: 1 }}
              onChange={event => set('openingDate', event.target.value)} {...text('openingDate')}
              slotProps={{ inputLabel: { shrink: true } }} />
            <TextField size="small" label={liability ? 'Amount owed' : 'Opening balance'} value={form.openingBalance} sx={{ flex: 1 }}
              onChange={event => set('openingBalance', event.target.value)} {...text('openingBalance')}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
            <Autocomplete
              size="small"
              sx={{ flex: 1 }}
              options={currencies}
              value={isCurrencyCode(form.currency) ? form.currency : null}
              onChange={(_event, value) => set('currency', value ?? '')}
              getOptionLabel={code => code}
              renderOption={(props, code) => <li {...props} key={code}>{code} · {currencyName(code)}</li>}
              // margin="none": the theme gives every TextField a dense top margin, which the Stack row removes from its
              // direct children only. This field is nested in the Autocomplete, so it would sit lower than its row.
              renderInput={params => <TextField {...params} margin="none" label="Currency" {...text('currency')} />}
            />
          </Stack>

          {hasLimit && (
            <TextField size="small" label="Credit limit" value={form.creditLimit}
              onChange={event => set('creditLimit', event.target.value)} {...text('creditLimit')}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
          )}

          {hasMinimum && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField size="small" label="Minimum balance" value={form.minimumBalance} sx={{ flex: 1 }}
                onChange={event => set('minimumBalance', event.target.value)} {...text('minimumBalance')}
                slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
              <FormControlLabel
                sx={{ flex: 2, ml: 0, mt: 0.5 }}
                control={<Checkbox size="small" checked={form.showAvailableBalance} onChange={event => set('showAvailableBalance', event.target.checked)} />}
                label="Show the balance above the minimum"
              />
            </Stack>
          )}

          <Stack direction="row" spacing={1}>
            <TextField size="small" label="Institution" value={form.institution} sx={{ flex: 1 }}
              onChange={event => set('institution', event.target.value)} {...text('institution')}
              slotProps={{ htmlInput: { maxLength: ACCOUNT_TEXT_MAX_LENGTH } }} />
            <TextField size="small" label="Account number" value={form.accountNumber} sx={{ flex: 1 }}
              onChange={event => set('accountNumber', event.target.value)} {...text('accountNumber')}
              slotProps={{ htmlInput: { maxLength: ACCOUNT_NUMBER_MAX_LENGTH, autoComplete: 'off' } }} />
          </Stack>

          <TextField size="small" label="Notes" value={form.notes} multiline minRows={2}
            onChange={event => set('notes', event.target.value)} {...text('notes')}
            slotProps={{ htmlInput: { maxLength: ACCOUNT_NOTES_MAX_LENGTH } }} />

          {server && server.field === undefined && <Alert severity="error">{server.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>{input.mode === 'edit' ? 'Save' : 'Create'}</Button>
      </DialogActions>
    </form>
  )
}
