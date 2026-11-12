// CSV Columns: a CSV file's layout, shown for every file, filled in with the layout remembered for files like it or
// with the guess, for the user to check and correct. The options, a role picker over each column, the file's rows,
// and a live preview of what will be imported, made by the same code the format imports with (../shared).
// See docs/import-formats-design.md, "The CSV Columns dialog".
import { FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { DateOrder, DecimalSeparator } from '@tessera/import-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, MenuItem, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography
} from '@tessera/ui'
import { readCsv, valuesOf, type Delimiter } from '../shared/csv'
import { firstLine, type LayoutDialogInput, type LayoutDialogResult } from '../shared/dialog'
import { directionWords, pendingWords } from '../shared/dictionary'
import { dataWidth } from '../shared/fit'
import type { Uncertain } from '../shared/guess'
import { problemsOf, ROLE_NAMES, ROLES, rolesOf, withRole, type CsvLayout, type Role } from '../shared/layout'
import { readLines } from '../shared/lines'

const SEPARATORS: { value: Delimiter, label: string }[] = [
  { value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' }, { value: '|', label: 'Bar (|)' }
]
const ORDERS: { value: DateOrder, label: string }[] = [
  { value: 'YMD', label: 'Year/Month/Day' }, { value: 'MDY', label: 'Month/Day/Year' }, { value: 'DMY', label: 'Day/Month/Year' }
]
const DECIMALS: { value: DecimalSeparator, label: string }[] = [{ value: '.', label: '1,234.56' }, { value: ',', label: '1.234,56' }]
/** Rows of the file shown in the table, after the header. */
const TABLE_ROWS = 8
/** Lines shown in the preview. */
const PREVIEW_LINES = 5
/** Rows offered as where the data starts. */
const START_ROWS = 30

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const showDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`))
const showPeriod = (from: string, to: string) => dateFormat.formatRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`))

/** A canonical amount as the register writes it: grouped, with a minus sign. */
export function showAmount(canonical: string): string {
  const negative = canonical.startsWith('-')
  const [whole, fraction] = canonical.replace(/^-/, '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '−' : ''}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`
}

/** An amount, in the theme's error colour when negative, in the numeric font role. */
function Money({ amount }: { amount: string }) {
  return <Box component="span" sx={{ typography: 'numeric', ...(amount.startsWith('-') && { color: 'error.main' }) }}>{showAmount(amount)}</Box>
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What the guess wasn't sure of, for one control. */
const doubtsFor = (uncertain: readonly Uncertain[], field: Uncertain['field'], column?: number) =>
  uncertain.filter(u => u.field === field && (column === undefined || u.column === column))

/**
 * A select in the theme's own menu, as every option and role picker here is. `id` goes on the part that takes focus
 * (where the dialog starts, for a guess); `name`, when given, is its accessible name instead of its label.
 */
function Choice<T extends string>({ id, label, name, value, options, onChange, doubt, width = 170, fullWidth }: {
  id: string, label: string, name?: string, value: T, options: { value: T, label: string }[], onChange: (value: T) => void,
  doubt?: string, width?: number, fullWidth?: boolean
}) {
  return (
    <TextField select size="small" label={label} value={value} color={doubt ? 'warning' : undefined} focused={doubt ? true : undefined}
      helperText={doubt ? 'A guess: check it' : undefined} fullWidth={fullWidth} sx={fullWidth ? undefined : { width }}
      onChange={event => onChange(event.target.value as T)}
      slotProps={{
        select: { SelectDisplayProps: { id, ...(name && { 'aria-label': name, 'aria-labelledby': undefined }) } as object },
        inputLabel: { shrink: true }
      }}>
      {options.map(option => <MenuItem key={option.value} value={option.value} dense>{option.label}</MenuItem>)}
    </TextField>
  )
}

/** Every role, and Ignore, as the role pickers list them. */
const ROLE_OPTIONS: { value: Role | 'ignore', label: string }[] = [{ value: 'ignore', label: 'Ignore' }, ...ROLES.map(r => ({ value: r, label: ROLE_NAMES[r] }))]

/** The file's rows under the pickers: the same whatever role or option changes, so drawn once per start row. */
const FileRows = memo(function FileRows({ rows, first, width }: { rows: string[][], first: number, width: number }) {
  return (
    <TableBody>
      {rows.map((row, i) => (
        <TableRow key={first + i}>
          {Array.from({ length: width }, (_, column) => <TableCell key={column} sx={{ whiteSpace: 'nowrap' }}>{row[column] ?? ''}</TableCell>)}
        </TableRow>
      ))}
    </TableBody>
  )
})

export default function LayoutDialog({ input, close }: DialogProps<LayoutDialogInput, LayoutDialogResult>) {
  const [layout, setLayout] = useState<CsvLayout>(input.layout)
  // What the guess wasn't sure of stays highlighted until the user changes it
  const [uncertain, setUncertain] = useState<Uncertain[]>(input.uncertain)
  const [showLeftOut, setShowLeftOut] = useState(false)
  const importRef = useRef<HTMLButtonElement>(null)

  const rows = useMemo(() => readCsv(input.text, layout.delimiter).rows.map(valuesOf), [input.text, layout.delimiter])
  const firstRow = layout.skip + (layout.header ? 1 : 0)
  const width = Math.max(1, dataWidth(rows, firstRow))
  const roles = rolesOf(layout, width)
  const header = layout.header ? rows[layout.skip] ?? [] : undefined
  const problems = problemsOf(layout, width)
  const read = useMemo(() => problems.length === 0 ? readLines(rows, layout, input.pivot) : undefined, [rows, layout, input.pivot, problems.length])
  const lines = read?.statements.flatMap(s => s.lines) ?? []
  const leftOut = read?.leftOut.filter(l => !l.quiet) ?? []
  const canImport = problems.length === 0 && lines.length > 0

  const change = (next: CsvLayout, settled: Uncertain['field'], column?: number) => {
    setLayout(next)
    setUncertain(current => current.filter(u => !(u.field === settled && (column === undefined || u.column === column))))
  }
  const setRole = (column: number, role: Role | undefined) => {
    const values = rows.slice(firstRow).map(r => r[column] ?? '')
    change(withRole(layout, column, role, values, { direction: directionWords, pending: pendingWords }), 'column', column)
  }

  // Focus: on Import when the layout was remembered and still fits; on the first uncertain choice otherwise
  useEffect(() => {
    const first = input.uncertain[0]
    const target = input.start === 'remembered' || !first ? undefined
      : document.getElementById(first.field === 'column' ? `csv-role-${first.column}` : `csv-${first.field}`)
    if (target) target.focus()
    else importRef.current?.focus()
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canImport) close({ kind: 'layout', layout })
  }

  const startRows = rows.slice(0, START_ROWS).map((r, i) => {
    const text = r.filter(v => v.trim() !== '').slice(0, 3).join(', ')
    return { value: String(i), label: `Row ${i + 1}${text ? `: ${text.length > 40 ? `${text.slice(0, 39)}…` : text}` : ' (blank)'}` }
  })
  const dates = lines.map(l => l.line.date).sort()
  const balances = read?.statements.filter(s => s.balance) ?? []
  const doubt = (field: Uncertain['field']) => doubtsFor(uncertain, field)[0]?.why
  const shownRows = useMemo(() => rows.slice(firstRow, firstRow + TABLE_ROWS), [rows, firstRow])

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>{firstLine(input)}</Typography>
          {input.start === 'misfit' && <Alert severity="warning">{input.misfit}</Alert>}

          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Choice id="csv-separator" label="Separator" value={layout.delimiter} options={SEPARATORS}
              onChange={delimiter => setLayout({ ...layout, delimiter })} width={140} />
            <Choice id="csv-start" label="Start at" value={String(layout.skip)} options={startRows} width={260}
              doubt={doubt('start')} onChange={skip => change({ ...layout, skip: Number(skip) }, 'start')} />
            <FormControlLabel label={`Row ${layout.skip + 1} is the header`}
              control={<Checkbox size="small" checked={layout.header} onChange={event => change({ ...layout, header: event.target.checked }, 'start')} />} />
            <Choice id="csv-dateOrder" label="Dates" value={layout.dateOrder} options={ORDERS} doubt={doubt('dateOrder')}
              onChange={dateOrder => change({ ...layout, dateOrder }, 'dateOrder')} />
            <Choice id="csv-decimal" label="Decimal" value={layout.decimal} options={DECIMALS} width={130} doubt={doubt('decimal')}
              onChange={decimal => change({ ...layout, decimal }, 'decimal')} />
          </Stack>
          <FormControlLabel
            label="Money out is shown as positive (amounts are reversed)"
            control={<Checkbox id="csv-reversed" size="small" checked={layout.reversed}
              onChange={event => change({ ...layout, reversed: event.target.checked }, 'reversed')} />} />

          {uncertain.length > 0 && (
            <Box component="ul" aria-label="Guesses to check" sx={{ m: 0, pl: 2.5 }}>
              {uncertain.map(u => (
                <li key={`${u.field}${u.column ?? ''}`}>
                  <Typography color="warning.main">{u.column !== undefined ? `Column ${u.column + 1}: ` : ''}{u.why}</Typography>
                </li>
              ))}
            </Box>
          )}

          <TableContainer sx={{ maxHeight: 320, border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <Table size="small" stickyHeader aria-label="The file's columns">
              <TableHead>
                <TableRow>
                  {roles.map((role, column) => {
                    const name = header?.[column]?.trim()
                    const guess = doubtsFor(uncertain, 'column', column)[0]?.why
                    return (
                      <TableCell key={column} sx={{ minWidth: 140, verticalAlign: 'top' }}>
                        <Choice id={`csv-role-${column}`} label={`Column ${column + 1}`} fullWidth
                          name={`Role for column ${column + 1}${name ? `, ${name}` : ''}`}
                          value={role ?? 'ignore'} options={ROLE_OPTIONS} doubt={guess}
                          onChange={value => setRole(column, value === 'ignore' ? undefined : value)} />
                        {name && <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 'bold' }}>{name}</Typography>}
                      </TableCell>
                    )
                  })}
                </TableRow>
              </TableHead>
              <FileRows rows={shownRows} first={firstRow} width={width} />
            </Table>
          </TableContainer>

          <Box>
            <Typography variant="subtitle2" component="h3">What will be imported</Typography>
            {problems.length > 0 ? (
              <Typography color="error.main" role="alert">{problems[0]}</Typography>
            ) : (
              <>
                <Table size="small" aria-label="What will be imported">
                  <TableBody>
                    {lines.slice(0, PREVIEW_LINES).map(({ row, line }) => (
                      <TableRow key={row}>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{showDate(line.date)}</TableCell>
                        <TableCell>{line.payee ?? ''}{line.memo ? ` · ${line.memo}` : ''}</TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}><Money amount={line.amount} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Typography sx={{ mt: 1 }} aria-label="Summary of what will be imported">
                  {lines.length === 0 ? 'No lines: nothing would be imported.' : plural(lines.length, 'line')}
                  {(read?.statements.length ?? 0) > 1 && ` in ${plural(read!.statements.length, 'account')}`}
                  {dates.length > 0 && ` · ${showPeriod(dates[0], dates[dates.length - 1])}`}
                  {balances.length === 1 && <> · closing balance <Money amount={balances[0].balance!.amount} /></>}
                  {input.truncated && ' · in the first part of the file'}
                </Typography>
                {leftOut.length > 0 && (
                  <>
                    <Button size="small" onClick={() => setShowLeftOut(!showLeftOut)} aria-expanded={showLeftOut}>
                      {plural(leftOut.length, 'row')} left out {showLeftOut ? '▾' : '▸'}
                    </Button>
                    {showLeftOut && (
                      <Box component="ul" aria-label="Rows left out" sx={{ m: 0, pl: 2.5 }}>
                        {leftOut.map(l => <li key={l.row}><Typography variant="body2">Row {l.row + 1}: {l.reason}</Typography></li>)}
                      </Box>
                    )}
                  </>
                )}
              </>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close({ kind: 'skip' })}>Skip This File</Button>
        <Button onClick={() => close()}>Cancel Import</Button>
        <Button ref={importRef} type="submit" variant="contained" disabled={!canImport}>Import</Button>
      </DialogActions>
    </form>
  )
}
