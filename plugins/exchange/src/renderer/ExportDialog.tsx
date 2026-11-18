// File ▸ Export Transactions… — one modal question rather than a workspace, because every part of it is a
// choice with a small set of answers: what to write, over what period, in what format, and what to leave out.
//
// It deliberately has no *Back up…* button. Every one of these formats loses something, and a user who treats
// an export as a backup finds out which part mattered at the worst possible moment; keeping a book whole is
// backup, restore and archive, which is separate work. See docs/import-export-design.md#what-export-is-not.
import { useMemo, useState } from 'react'
import type { DialogProps, Json } from '@tessera/types'
import type {
  ExportDialogInput, ExportDialogResult, ExportOptionField, ExportRequest
} from '@tessera/exchange-api'
import {
  Alert, Button, Checkbox, DialogActions, DialogContent, FormControl, FormControlLabel, FormLabel, MenuItem,
  Radio, RadioGroup, Stack, TextField, Typography
} from '@tessera/ui'

type Period = 'all' | 'thisYear' | 'lastYear' | 'custom'
type ScopeKind = ExportRequest['scope']['kind']

export default function ExportDialog({ input, close }: DialogProps<ExportDialogInput, ExportDialogResult>) {
  const year = Number(input.today.slice(0, 4))

  const [scopeKind, setScopeKind] = useState<ScopeKind>(input.scope?.kind ?? 'account')
  const [accountId, setAccountId] = useState(
    input.scope?.kind === 'account' ? input.scope.accountId : (input.accounts[0]?.id ?? ''))
  const [subBookId, setSubBookId] = useState(
    input.scope?.kind === 'subBook' ? input.scope.subBookId : (input.subBooks[0]?.id ?? ''))
  const [includeDescendants, setIncludeDescendants] = useState(
    input.scope?.kind === 'subBook' ? input.scope.includeDescendants : true)

  const [period, setPeriod] = useState<Period>('all')
  const [from, setFrom] = useState(`${year}-01-01`)
  const [to, setTo] = useState(input.today)

  const [formatId, setFormatId] = useState(input.formats[0]?.id ?? '')
  const [includeCategories, setIncludeCategories] = useState(true)
  const [includeVoided, setIncludeVoided] = useState(false)
  const [clearedOnly, setClearedOnly] = useState(false)

  const format = input.formats.find(f => f.id === formatId)

  /**
   * The format-specific answers, per format rather than one bag: switching from QIF to CSV and back should
   * find the QIF flavour as it was left, not reset to the default.
   */
  const [formatOptions, setFormatOptions] = useState<Record<string, Record<string, Json>>>(
    () => Object.fromEntries(input.formats.map(f => [f.id, defaultsOf(f.fields)])))
  const options = formatOptions[formatId] ?? {}
  const setOption = (key: string, value: Json) =>
    setFormatOptions(current => ({ ...current, [formatId]: { ...current[formatId], [key]: value } }))
  const scope = scopeOf(scopeKind, accountId, subBookId, includeDescendants)
  const range = rangeOf(period, year, from, to)

  /** How many accounts this scope covers, which is what a single-account format cannot stretch to. */
  const accountCount = useMemo(() => {
    if (scope.kind === 'account') return 1
    if (scope.kind === 'book') return input.accounts.length
    // A sub-book's own accounts; descendants are the privileged side's to resolve, so this is a lower bound.
    return input.accounts.filter(a => a.subBookId === scope.subBookId).length
  }, [scope, input.accounts])

  const tooMany = format !== undefined && !format.multiAccount && accountCount > 1
  const badRange = period === 'custom' && from !== '' && to !== '' && from > to
  const nothingToExport =
    (scope.kind === 'account' && accountId === '') ||
    (scope.kind === 'subBook' && subBookId === '') ||
    input.accounts.length === 0

  const confirm = () => close({
    scope,
    ...(range !== undefined && { range }),
    formatId,
    includeCategories,
    includeVoided,
    clearedOnly,
    ...(format !== undefined && format.fields.length > 0 && { formatOptions: options })
  })

  return (
    <>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <FormControl>
          <FormLabel id="export-what">What to export</FormLabel>
          <RadioGroup aria-labelledby="export-what" value={scopeKind}
            onChange={event => setScopeKind(event.target.value as ScopeKind)}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <FormControlLabel value="account" control={<Radio size="small" />} label="One account" />
              <TextField size="small" select value={accountId} sx={{ minWidth: 240 }}
                disabled={scopeKind !== 'account'} onChange={event => setAccountId(event.target.value)}
                slotProps={{ htmlInput: { 'aria-label': 'Account to export' } }}>
                {input.accounts.map(account => (
                  <MenuItem key={account.id} value={account.id}>
                    {account.name}{account.closed === true ? ' (closed)' : ''}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <FormControlLabel value="subBook" control={<Radio size="small" />} label="A sub-book" />
              <TextField size="small" select value={subBookId} sx={{ minWidth: 240 }}
                disabled={scopeKind !== 'subBook'} onChange={event => setSubBookId(event.target.value)}
                slotProps={{ htmlInput: { 'aria-label': 'Sub-book to export' } }}>
                {input.subBooks.map(subBook => (
                  <MenuItem key={subBook.id} value={subBook.id}>{subBook.name}</MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                control={<Checkbox size="small" checked={includeDescendants} disabled={scopeKind !== 'subBook'}
                  onChange={event => setIncludeDescendants(event.target.checked)} />}
                label="and those inside it" />
            </Stack>

            <FormControlLabel value="book" control={<Radio size="small" />} label="The whole book" />
          </RadioGroup>
        </FormControl>

        <FormControl>
          <FormLabel id="export-when">When</FormLabel>
          <RadioGroup row aria-labelledby="export-when" value={period}
            onChange={event => setPeriod(event.target.value as Period)}>
            <FormControlLabel value="all" control={<Radio size="small" />} label="All dates" />
            <FormControlLabel value="thisYear" control={<Radio size="small" />} label={`This year (${year})`} />
            <FormControlLabel value="lastYear" control={<Radio size="small" />} label={`Last year (${year - 1})`} />
            <FormControlLabel value="custom" control={<Radio size="small" />} label="Chosen dates" />
          </RadioGroup>
          {period === 'custom' && (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <TextField size="small" type="date" label="From" value={from}
                slotProps={{ inputLabel: { shrink: true } }} onChange={event => setFrom(event.target.value)} />
              <TextField size="small" type="date" label="To" value={to}
                slotProps={{ inputLabel: { shrink: true } }} onChange={event => setTo(event.target.value)} />
            </Stack>
          )}
        </FormControl>

        <Stack spacing={1.5}>
          <TextField size="small" select label="Format" value={formatId} sx={{ maxWidth: 360 }}
            onChange={event => setFormatId(event.target.value)}>
            {input.formats.map(entry => (
              <MenuItem key={entry.id} value={entry.id}>{entry.label}</MenuItem>
            ))}
          </TextField>

          {/* Whatever this format asked to be able to ask. Nothing shows for a format that asked nothing. */}
          {format !== undefined && format.fields.length > 0 && (
            <Stack spacing={1} sx={{ pl: 2, borderLeft: 2, borderColor: 'divider' }}>
              {format.fields.map(field => (
                <FormatOption key={field.key} field={field} value={options[field.key]} onChange={setOption} />
              ))}
            </Stack>
          )}
        </Stack>

        <FormControl>
          <FormLabel>Include</FormLabel>
          <Stack>
            <FormControlLabel control={<Checkbox size="small" checked={includeCategories}
              onChange={event => setIncludeCategories(event.target.checked)} />}
              label="Categories" />
            <FormControlLabel control={<Checkbox size="small" checked={includeVoided}
              onChange={event => setIncludeVoided(event.target.checked)} />}
              label="Voided transactions" />
            <FormControlLabel control={<Checkbox size="small" checked={clearedOnly}
              onChange={event => setClearedOnly(event.target.checked)} />}
              label="Cleared and reconciled transactions only" />
          </Stack>
        </FormControl>

        {tooMany && (
          <Alert severity="warning" variant="outlined">
            {format?.label} holds one account, and this would export {accountCount}. Choose a single account, or
            a format that can hold several.
          </Alert>
        )}
        {badRange && <Alert severity="warning" variant="outlined">The “from” date is after the “to” date.</Alert>}
        {input.accounts.length === 0 && (
          <Alert severity="info" variant="outlined">This book has no accounts to export.</Alert>
        )}

        <Typography variant="caption" color="text.secondary">
          An exported file is not a backup: each of these formats leaves something behind.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" data-export-ok
          disabled={formatId === '' || tooMany || badRange || nothingToExport}
          onClick={confirm}>Export…</Button>
      </DialogActions>
    </>
  )
}

/** One format-specific question, by its declared kind. The dialog knows these three shapes and no others. */
function FormatOption({ field, value, onChange }: {
  field: ExportOptionField
  value: Json | undefined
  onChange: (key: string, value: Json) => void
}) {
  if (field.kind === 'boolean') {
    return (
      <FormControlLabel
        control={<Checkbox size="small" checked={value === true}
          onChange={event => onChange(field.key, event.target.checked)} />}
        label={
          <Stack>
            <Typography variant="body2">{field.label}</Typography>
            {field.detail !== undefined && (
              <Typography variant="caption" color="text.secondary">{field.detail}</Typography>
            )}
          </Stack>
        } />
    )
  }

  if (field.kind === 'choice') {
    return (
      <TextField size="small" select label={field.label} sx={{ maxWidth: 360 }}
        value={typeof value === 'string' ? value : field.default}
        {...(field.detail !== undefined && { helperText: field.detail })}
        onChange={event => onChange(field.key, event.target.value)}>
        {field.options.map(option => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}{option.detail !== undefined ? ` — ${option.detail}` : ''}
          </MenuItem>
        ))}
      </TextField>
    )
  }

  return (
    <TextField size="small" label={field.label} sx={{ maxWidth: 360 }}
      value={typeof value === 'string' ? value : field.default}
      {...(field.detail !== undefined && { helperText: field.detail })}
      {...(field.maxLength !== undefined && { slotProps: { htmlInput: { maxLength: field.maxLength } } })}
      onChange={event => onChange(field.key, event.target.value)} />
  )
}

/** What a format's questions start at, before the user touches any of them. */
export function defaultsOf(fields: readonly ExportOptionField[]): Record<string, Json> {
  return Object.fromEntries(fields.map(field => [field.key, field.default as Json]))
}

function scopeOf(
  kind: ScopeKind, accountId: string, subBookId: string, includeDescendants: boolean
): ExportRequest['scope'] {
  if (kind === 'account') return { kind: 'account', accountId }
  if (kind === 'subBook') return { kind: 'subBook', subBookId, includeDescendants }
  return { kind: 'book' }
}

/** The chosen period as a range, or undefined for all dates — which is the absence of a range, not a wide one. */
export function rangeOf(period: Period, year: number, from: string, to: string): ExportRequest['range'] {
  switch (period) {
    case 'thisYear': return { from: `${year}-01-01`, to: `${year}-12-31` }
    case 'lastYear': return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }
    case 'custom': return {
      ...(from !== '' && { from }),
      ...(to !== '' && { to })
    }
    default: return undefined
  }
}
