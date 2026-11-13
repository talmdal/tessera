// The Export dialog, in two tabs so it fits without scrolling: What to export (the format, the accounts, the dates) and
// File options (the format's own options, which it declares as data and this dialog draws, as lists two to a row). Below the
// tabs, always in view, what the file would hold (export:check): how many transactions, and what would be cut, changed
// or left out, asked again as anything changes, before the user picks where to save it. The accounts are chosen in a
// list that opens over the dialog, so choosing them doesn't move anything.
// See docs/export-design.md, "The Export dialog".
import { FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DialogProps } from '@tessera/types'
import { displayDate } from '@tessera/ledger-api'
import {
  ACCOUNT_FIELD_LABELS, EXPORT_CHANNELS, RANGE_CHOICES, fieldApplies,
  type AccountFieldName, type AccountValues, type CheckResponse, type ExportAccountChoice, type ExportDialogInput,
  type ExportDialogResult, type ExportFormatInfo, type ExportOptionField, type ExportOptions, type ExportRequest, type ExportResult,
  type RangeChoice, type RangeState
} from '@tessera/export-api'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, DialogContent, FormControlLabel, FormHelperText, ListItemText,
  MenuItem, Stack, Tab, Tabs, TextField, Typography
} from '@tessera/ui'
import { archivedNote } from '../shared/notes'
import { RANGE_LABELS, rangeOf, rangeProblem } from '../shared/ranges'

/** How long the dialog waits after a change before asking what the file would hold. */
const CHECK_DELAY_MS = 150

/** The accounts list's first item, which ticks (or clears) every account. */
const ALL = '(all)'

type TabId = 'export' | 'options'

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** Whether a format can hold an account of this type. */
const holds = (format: ExportFormatInfo | undefined, account: ExportAccountChoice) =>
  !format?.accountTypes || format.accountTypes.includes(account.type)

/** Where an account is and what it is, in a line: 'Family · Savings · CAD · Closed'. */
const detailsOf = (account: ExportAccountChoice) =>
  [account.location, account.typeLabel, account.currency, account.closed ? 'Closed' : ''].filter(Boolean).join(' · ')

/**
 * A select in the theme's own menu, as the other dialogs' pickers are. A direct child of the row it sits in, so it keeps
 * the same margins as the fields beside it (a wrapper would keep the theme's dense margin where they lose it).
 */
function Select<T extends string>({ id, label, value, options, onChange, sx }: {
  id: string, label: string, value: T, options: { value: T, label: string, disabled?: boolean }[], onChange: (value: T) => void, sx?: object
}) {
  return (
    <TextField select size="small" label={label} value={value} fullWidth sx={sx}
      onChange={event => onChange(event.target.value as T)}
      slotProps={{ select: { SelectDisplayProps: { id } as object }, inputLabel: { shrink: true } }}>
      {options.map(option => <MenuItem key={option.value} value={option.value} disabled={option.disabled} dense>{option.label}</MenuItem>)}
    </TextField>
  )
}

/**
 * The accounts, as a list with a checkbox each that opens over the dialog, with All accounts first. The field shows what
 * is chosen in a line: one account's name, 'All accounts (5)', or '3 accounts: Chequing, Savings, Visa'.
 */
function AccountsField({ accounts, format, selected, onChange }: {
  accounts: ExportAccountChoice[], format: ExportFormatInfo, selected: readonly string[], onChange: (ids: string[]) => void
}) {
  const allowed = accounts.filter(a => holds(format, a))
  const chosen = allowed.filter(a => selected.includes(a.id))
  const all = chosen.length === allowed.length && allowed.length > 0
  const summary = chosen.length === 0 ? 'None chosen'
    : all && allowed.length > 1 ? `All accounts (${allowed.length.toLocaleString()})`
      : chosen.length === 1 ? chosen[0].name
        : `${chosen.length.toLocaleString()} accounts: ${chosen.map(a => a.name).join(', ')}`
  return (
    <TextField select size="small" label="Accounts" fullWidth error={chosen.length === 0} value={chosen.map(a => a.id)}
      onChange={event => {
        const ids = event.target.value as unknown as string[]
        if (ids.includes(ALL)) onChange(all ? [] : allowed.map(a => a.id))
        else onChange(ids)
      }}
      slotProps={{
        select: {
          multiple: true,
          // Without this, a list with nothing chosen shows an empty field rather than saying so
          displayEmpty: true,
          renderValue: () => summary,
          SelectDisplayProps: { id: 'export-accounts' } as object,
          MenuProps: { slotProps: { paper: { sx: { maxHeight: 360 } } } }
        },
        inputLabel: { shrink: true }
      }}>
      <MenuItem value={ALL} dense>
        <Checkbox size="small" checked={all} indeterminate={!all && chosen.length > 0} sx={{ py: 0, pl: 0 }} />
        <ListItemText primary="All accounts" />
      </MenuItem>
      {accounts.map(account => {
        const can = holds(format, account)
        return (
          <MenuItem key={account.id} value={account.id} disabled={!can} dense>
            <Checkbox size="small" checked={can && selected.includes(account.id)} sx={{ py: 0, pl: 0 }} />
            <ListItemText primary={account.name} secondary={can ? detailsOf(account) : `${detailsOf(account)} · Not possible in this file type`} />
          </MenuItem>
        )
      })}
    </TextField>
  )
}

/**
 * The account fields a format writes (OFX's account number and bank number), for each account exported: filled in from
 * the account, and changeable for this export only. Typing here never changes the account (Q10).
 */
function AccountFields({ format, accounts, values, onChange }: {
  format: ExportFormatInfo, accounts: ExportAccountChoice[], values: AccountValues,
  onChange: (accountId: string, field: AccountFieldName, value: string) => void
}) {
  const rows = accounts.map(account => ({ account, uses: format.accountFields.filter(use => fieldApplies(use, account.type)) }))
    .filter(row => row.uses.length > 0)
  if (rows.length === 0) return null
  return (
    <Stack spacing={1.5} component="section" aria-label="Account details for this file">
      {rows.map(({ account, uses }) => (
        <Box key={account.id}>
          {rows.length > 1 && <Typography variant="body2" sx={{ mb: 0.5 }}>{account.name}</Typography>}
          <Stack direction="row" spacing={1.5}>
            {uses.map(use => (
              <TextField key={use.field} size="small" label={ACCOUNT_FIELD_LABELS[use.field]} required={use.need === 'required'} sx={{ flex: 1 }}
                value={values[account.id]?.[use.field] ?? account[use.field] ?? ''}
                onChange={event => onChange(account.id, use.field, event.target.value)}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { autoComplete: 'off' } }} />
            ))}
          </Stack>
        </Box>
      ))}
      <Typography variant="body2" color="text.secondary">
        From the account, and used for this export only: to keep a change, make it in Accounts › Edit Account….
      </Typography>
    </Stack>
  )
}

/** One of a format's options, drawn from its declaration. */
function OptionField({ field, value, onChange }: { field: ExportOptionField, value: string | boolean, onChange: (value: string | boolean) => void }) {
  const id = `export-option-${field.key}`
  switch (field.kind) {
    case 'boolean':
      return (
        <Box>
          <FormControlLabel label={field.label} control={<Checkbox size="small" checked={value === true} onChange={event => onChange(event.target.checked)} />} />
          {field.description && <FormHelperText sx={{ mt: -0.5, ml: 4 }}>{field.description}</FormHelperText>}
        </Box>
      )
    case 'text':
      return (
        <TextField size="small" label={field.label} value={String(value)} helperText={field.description} required={field.required}
          slotProps={{ htmlInput: { maxLength: field.maxLength } }} onChange={event => onChange(event.target.value)} />
      )
    case 'choice': {
      // A list rather than radio buttons, two to a row, so a format's options fit without scrolling; the chosen
      // option's description (else the field's) is the line under it
      const chosen = field.options.find(option => option.value === value)
      return (
        <TextField select size="small" label={field.label} value={String(value)} fullWidth helperText={chosen?.description ?? field.description}
          onChange={event => onChange(event.target.value)}
          slotProps={{ select: { SelectDisplayProps: { id } as object }, inputLabel: { shrink: true } }}>
          {field.options.map(option => <MenuItem key={option.value} value={option.value} dense>{option.label}</MenuItem>)}
        </TextField>
      )
    }
  }
}

/**
 * A tab's panel. Both panels share one cell of a grid, the one not shown hidden but still taking its room, so the
 * dialog is as tall as the taller panel whichever is shown, and doesn't jump when the tab changes.
 */
function Panel({ id, shown, children }: { id: TabId, shown: boolean, children: ReactNode }) {
  return (
    <Box role="tabpanel" id={`export-panel-${id}`} aria-labelledby={`export-tab-${id}`} aria-hidden={!shown}
      {...(!shown && { inert: '' })}
      sx={{ gridArea: '1 / 1', visibility: shown ? 'visible' : 'hidden', pt: 2 }}>
      {children}
    </Box>
  )
}

/** What the file would hold, as the plugin worked it out. */
function Preview({ check, error, checking, local }: { check?: CheckResponse, error?: string, checking: boolean, local?: string }) {
  if (local) return <Alert severity="info">{local}</Alert>
  if (error) return <Alert severity="error">{error}</Alert>
  if (!check) return <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={16} aria-label="Working out what the file will hold" /></Stack>
  return (
    <Stack spacing={1} aria-busy={checking} aria-live="polite">
      <Typography>
        Will export {plural(check.transactions, 'transaction')} from {plural(check.accounts, 'account')},{' '}
        {displayDate(check.range.from)} to {displayDate(check.range.to)}.
      </Typography>
      {check.problems.length > 0 && (
        <Alert severity="error"><Stack spacing={0.5}>{check.problems.map(p => <span key={p}>{p}</span>)}</Stack></Alert>
      )}
      {/* One note for every account an archive file takes over from, however many */}
      {archivedNote(check.archived) && <Alert severity="info">{archivedNote(check.archived)}</Alert>}
      {check.warnings.length > 0 && (
        <Alert severity="warning"><Stack spacing={0.5}>{check.warnings.map(w => <span key={w}>{w}</span>)}</Stack></Alert>
      )}
    </Stack>
  )
}

export default function ExportDialog({ input, close }: DialogProps<ExportDialogInput, ExportDialogResult>) {
  const { formats, accounts, preselectedId, today } = input
  const preselected = accounts.find(a => a.id === preselectedId)
  const [tab, setTab] = useState<TabId>('export')
  const [formatId, setFormatId] = useState(input.formatId)
  const [optionsByFormat, setOptionsByFormat] = useState<Record<string, ExportOptions>>(input.options)
  const startFormat = formats.find(f => f.id === input.formatId) ?? formats[0]
  // To begin with, the account the user is looking at, or every account the format can hold
  const [selected, setSelected] = useState<string[]>(() => preselected ? [preselected.id] : accounts.filter(a => holds(startFormat, a)).map(a => a.id))
  const [oneId, setOneId] = useState<string | undefined>(preselected?.id)
  const [rangeState, setRangeState] = useState<RangeState>(input.range)
  // Account fields typed for this export (never saved to the account)
  const [accountValues, setAccountValues] = useState<AccountValues>({})
  const [check, setCheck] = useState<CheckResponse>()
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)

  const format = formats.find(f => f.id === formatId) ?? formats[0]
  const options = optionsByFormat[format.id] ?? {}
  const hasOptions = format.options.length > 0
  const allowed = accounts.filter(a => holds(format, a))
  // For a format holding one account: the one chosen, else the one the user is looking at, else the first it can hold
  const one = allowed.find(a => a.id === oneId) ?? allowed.find(a => a.id === preselectedId) ?? allowed[0]

  const accountIds = useMemo(() => format.accounts === 'one'
    ? (one ? [one.id] : [])
    : accounts.filter(a => selected.includes(a.id) && holds(format, a)).map(a => a.id), [format, one, selected, accounts])
  const range = rangeOf(rangeState, today)
  const local = accountIds.length === 0 ? 'Choose at least one account to export.' : rangeProblem(range)
  // Only what was typed for the accounts exported, so the request (and the check it asks for) changes only with them
  const typed = Object.fromEntries(accountIds.filter(id => accountValues[id]).map(id => [id, accountValues[id]]))
  const request: ExportRequest = { formatId: format.id, accountIds, range, options, ...(Object.keys(typed).length > 0 && { accountValues: typed }) }
  const requestKey = JSON.stringify(request)

  // What the file would hold, asked a moment after the last change; an answer to an earlier request is ignored
  useEffect(() => {
    if (local) return
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      window.api.invoke<ExportResult<CheckResponse>>(EXPORT_CHANNELS.check, JSON.parse(requestKey)).then(result => {
        if (!live) return
        setChecking(false)
        if (result.ok) { setCheck(result.value); setError(undefined) } else { setCheck(undefined); setError(result.error.message) }
      }, err => {
        if (!live) return
        setChecking(false)
        setCheck(undefined)
        setError(String((err as Error)?.message ?? err))
      })
    }, CHECK_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [requestKey, local])

  // A format without options has no options tab to stay on
  useEffect(() => { if (!hasOptions && tab === 'options') setTab('export') }, [hasOptions, tab])

  const setAccountValue = (accountId: string, field: AccountFieldName, value: string) =>
    setAccountValues(all => ({ ...all, [accountId]: { ...all[accountId], [field]: value } }))
  const setOption = (key: string, value: string | boolean) =>
    setOptionsByFormat(all => ({ ...all, [format.id]: { ...all[format.id], [key]: value } }))
  const chooseRange = (choice: RangeChoice) =>
    setRangeState(choice === 'custom' ? { choice, ...rangeOf(rangeState, today) } : { choice })
  const setDate = (end: 'from' | 'to', value: string) =>
    setRangeState({ ...rangeOf(rangeState, today), choice: 'custom', [end]: value === '' ? undefined : value })

  const ready = !local && !checking && check !== undefined && error === undefined && check.problems.length === 0
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) close({ ...request, rangeState })
  }
  // An open end shows the date the export will start or end on, once the plugin has worked it out
  const shownFrom = range.from ?? (!local && check ? check.range.from : '')
  const shownTo = range.to ?? (!local && check ? check.range.to : '')

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Tabs value={tab} onChange={(_, value: TabId) => setTab(value)} aria-label="Export">
          <Tab value="export" label="What to export" id="export-tab-export" aria-controls="export-panel-export" />
          <Tab value="options" label="File options" id="export-tab-options" aria-controls="export-panel-options" disabled={!hasOptions} />
        </Tabs>
        <Box sx={{ display: 'grid' }}>
          <Panel id="export" shown={tab === 'export'}>
            <Stack spacing={2.5}>
              <Box>
                <Select id="export-format" label="Format" value={format.id} onChange={setFormatId}
                  options={formats.map(f => ({ value: f.id, label: f.label }))} />
                {format.description && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{format.description}</Typography>}
              </Box>
              {format.accounts === 'one'
                ? (
                  <Box>
                    <Select id="export-account" label="Account" value={one?.id ?? ''} onChange={setOneId}
                      options={accounts.map(a => ({ value: a.id, label: holds(format, a) ? a.name : `${a.name} (${a.typeLabel.toLowerCase()}: not possible in this file type)`, disabled: !holds(format, a) }))} />
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>This file type holds one account per file.</Typography>
                  </Box>
                )
                : <AccountsField accounts={accounts} format={format} selected={selected} onChange={setSelected} />}
              {format.accountFields.length > 0 && (
                <AccountFields format={format} accounts={accounts.filter(a => accountIds.includes(a.id))} values={accountValues} onChange={setAccountValue} />
              )}
              {/* The three fields are the row's own children: margins alike, so they line up */}
              <Stack direction="row" spacing={1.5}>
                <Select id="export-range" label="Dates" value={rangeState.choice} onChange={chooseRange} sx={{ flex: 1 }}
                  options={RANGE_CHOICES.map(choice => ({ value: choice, label: RANGE_LABELS[choice] }))} />
                <TextField size="small" type="date" label="From" value={shownFrom} onChange={event => setDate('from', event.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1 }} />
                <TextField size="small" type="date" label="To" value={shownTo} onChange={event => setDate('to', event.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1 }} />
              </Stack>
            </Stack>
          </Panel>
          <Panel id="options" shown={tab === 'options'}>
            <Box component="section" aria-label={`${format.label} options`}
              sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 3, rowGap: 2, alignItems: 'start' }}>
              {format.options.map(field => (
                <OptionField key={`${format.id}:${field.key}`} field={field} value={options[field.key] ?? field.default} onChange={value => setOption(field.key, value)} />
              ))}
            </Box>
          </Panel>
        </Box>

        <Box sx={{ mt: 2.5 }}>
          <Preview check={check} error={error} checking={checking} local={local} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, px: 1 }}>
          The file will hold these transactions as plain text. Keep it somewhere safe.
        </Typography>
        <Button onClick={() => close()}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={!ready}>Export…</Button>
      </DialogActions>
    </form>
  )
}
