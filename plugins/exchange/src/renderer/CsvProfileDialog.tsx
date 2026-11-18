// Matching a delimited file's columns to Tessera's fields.
//
// The live preview is the whole point of this dialog. A user cannot reason about `dateFormat: 'MDY'`, but they
// can see at a glance that the preview says *5 March* when their statement says *3 May* — so the grid of the
// file's first rows sits above a preview of the first few transactions exactly as Tessera would read them, and
// both update on every change. See docs/import-export-design.md#csv.
import { useMemo, useState } from 'react'
import type { DialogProps, Json } from '@tessera/types'
import {
  CSV_FIELDS, parseCsvAmount, parseCsvDate, validateCsvProfile,
  type CsvColumn, type CsvField, type CsvProfile, type QuestionDialogInput
} from '@tessera/exchange-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, MenuItem, Stack, Table,
  TableBody, TableCell, TableHead, TableRow, TextField, Typography
} from '@tessera/ui'

/** What each field is called in the drop-downs, in the order a user looks for them. */
const FIELD_LABELS: Record<CsvField, string> = {
  date: 'Date',
  amount: 'Amount (signed)',
  debit: 'Debit / money out',
  credit: 'Credit / money in',
  payee: 'Payee',
  memo: 'Memo',
  number: 'Cheque number',
  category: 'Category',
  balance: 'Balance',
  externalId: 'Reference ID'
}

const IGNORE = '::ignore::'
const PREVIEW_ROWS = 3

const DATE_FORMATS: { value: string, label: string }[] = [
  { value: 'ISO', label: 'Year first (2026-10-15)' },
  { value: 'DMY', label: 'Day first (15/10/2026)' },
  { value: 'MDY', label: 'Month first (10/15/2026)' }
]

export default function CsvProfileDialog({ input, close }: DialogProps<QuestionDialogInput, Json>) {
  const { question } = input
  const sample = question.kind === 'csvProfile' ? question.sample : []
  const suggested = (question.kind === 'csvProfile' ? question.suggested : undefined) as CsvProfile | undefined

  const [profile, setProfile] = useState<CsvProfile>(() => suggested ?? EMPTY)
  const patch = (fields: Partial<CsvProfile>) => setProfile(current => ({ ...current, ...fields }))

  // The sample includes the header row when the file has one; the rows beneath it are the data.
  const header = profile.header ? (sample[0] ?? []) : []
  const dataRows = profile.header ? sample.slice(1) : sample
  const width = Math.max(0, ...sample.map(row => row.length))

  /** The column identifier for position `at`: the header name when there is one, else the index. */
  const columnAt = (at: number): CsvColumn => profile.header ? (header[at] ?? at) : at

  /** Which field, if any, position `at` is currently mapped to. */
  const fieldAt = (at: number): CsvField | undefined =>
    CSV_FIELDS.find(field => sameColumn(profile.columns[field], columnAt(at)))

  /** Mapping a column to a field takes that field off whatever column held it: a field has one column. */
  const mapColumn = (at: number, field: string) => {
    setProfile(current => {
      const columns = { ...current.columns }
      for (const existing of CSV_FIELDS) {
        if (sameColumn(columns[existing], columnAt(at))) delete columns[existing]
      }
      if (field !== IGNORE) columns[field as CsvField] = columnAt(at)
      return { ...current, columns: columns as CsvProfile['columns'] }
    })
  }

  const preview = useMemo(() => previewOf(dataRows, header, profile), [dataRows, header, profile])
  const problem = validateCsvProfile(profile)

  return (
    <>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {question.detail ?? 'Tessera needs to know what each column of this file holds.'} Check the preview
          below before pressing OK — it shows the first few rows exactly as they will be imported.
        </Typography>

        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <TextField size="small" label="Profile name" value={profile.name} sx={{ minWidth: 220 }}
            helperText="Saved under this name, and used again for this file shape"
            onChange={event => patch({ name: event.target.value })} />
          <TextField size="small" select label="Dates" value={namedFormat(profile.dateFormat)} sx={{ minWidth: 200 }}
            onChange={event => patch({ dateFormat: event.target.value })}>
            {DATE_FORMATS.map(format => <MenuItem key={format.value} value={format.value}>{format.label}</MenuItem>)}
          </TextField>
          <TextField size="small" select label="Decimal separator" value={profile.decimal} sx={{ minWidth: 160 }}
            onChange={event => patch({ decimal: event.target.value as '.' | ',' })}>
            <MenuItem value=".">Point (1,234.56)</MenuItem>
            <MenuItem value=",">Comma (1.234,56)</MenuItem>
          </TextField>
          <FormControlLabel
            control={<Checkbox size="small" checked={profile.debitsArePositive === true}
              onChange={event => patch({ debitsArePositive: event.target.checked })} />}
            label="Money out is written as a positive number"
            sx={{ display: profile.columns.amount === undefined ? 'none' : undefined }} />
        </Stack>

        <Box>
          <Typography variant="subtitle2" gutterBottom>The file</Typography>
          <Box sx={{ overflow: 'auto', maxHeight: 260, border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <Table size="small" stickyHeader aria-label="File columns">
              <TableHead>
                <TableRow>
                  {Array.from({ length: width }, (_, at) => (
                    <TableCell key={at} sx={{ minWidth: 150 }}>
                      <TextField size="small" select fullWidth variant="standard"
                        value={fieldAt(at) ?? IGNORE}
                        onChange={event => mapColumn(at, event.target.value)}
                        label={profile.header ? (header[at] ?? `Column ${at + 1}`) : `Column ${at + 1}`}
                        slotProps={{ htmlInput: { 'aria-label': `What column ${at + 1} holds` } }}>
                        <MenuItem value={IGNORE}><em>Ignore</em></MenuItem>
                        {CSV_FIELDS.map(field => (
                          <MenuItem key={field} value={field}>{FIELD_LABELS[field]}</MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {dataRows.slice(0, 8).map((row, at) => (
                  <TableRow key={at}>
                    {Array.from({ length: width }, (_, cell) => (
                      <TableCell key={cell} sx={{ whiteSpace: 'nowrap' }}>{row[cell] ?? ''}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" gutterBottom>How Tessera will read it</Typography>
          {problem !== undefined
            ? <Alert severity="info" variant="outlined">{problem}</Alert>
            : (
              <Table size="small" aria-label="Preview">
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Payee</TableCell>
                    <TableCell align="right">Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.map((row, at) => (
                    <TableRow key={at}>
                      <TableCell sx={{ color: row.date === undefined ? 'error.main' : undefined }}>
                        {row.date ?? 'Not a date'}
                      </TableCell>
                      <TableCell>{row.payee ?? ''}</TableCell>
                      <TableCell align="right" sx={{
                        fontVariantNumeric: 'tabular-nums',
                        color: row.amount === undefined ? 'error.main' : row.amount < 0 ? 'error.main' : 'success.main'
                      }}>
                        {row.amount === undefined ? 'Not an amount' : money(row.amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          {profile.columns.externalId !== undefined && (
            <Alert severity="success" variant="outlined" sx={{ mt: 1 }}>
              This file has a reference the bank supplies, so Tessera can tell a repeated import apart exactly
              rather than by guesswork.
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" disabled={problem !== undefined}
          onClick={() => close(profile as unknown as Json)} data-question-ok>OK</Button>
      </DialogActions>
    </>
  )
}

/** The profile a file with no suggestion starts from: enough to render, not enough to accept. */
const EMPTY: CsvProfile = {
  name: 'Imported CSV', delimiter: ',', quote: '"', skip: 0, header: true, encoding: 'utf-8',
  columns: { date: 0 }, dateFormat: 'ISO', decimal: '.'
}

/** Two column identifiers meaning the same column. Compared loosely: a name may arrive as a number. */
const sameColumn = (a: CsvColumn | undefined, b: CsvColumn) => a !== undefined && String(a) === String(b)

/** A free-form pattern is shown as the named order it behaves like, so the drop-down always has a value. */
function namedFormat(format: string): string {
  const upper = format.toUpperCase()
  if (upper === 'ISO' || upper === 'YMD') return 'ISO'
  if (upper === 'DMY' || upper === 'MDY') return upper
  const letters = [...upper].filter(c => c === 'D' || c === 'M' || c === 'Y')
  if (letters[0] === 'Y') return 'ISO'
  return letters[0] === 'D' ? 'DMY' : 'MDY'
}

export interface PreviewRow {
  date?: string
  payee?: string
  amount?: number
}

/**
 * The first rows as Tessera would read them. Deliberately the same arithmetic the reader uses — the preview
 * would be worse than useless if it could disagree with the import it is predicting.
 */
export function previewOf(rows: string[][], header: string[], profile: CsvProfile): PreviewRow[] {
  const { columns } = profile
  const at = (row: string[], column: CsvColumn | undefined) => {
    if (column === undefined) return undefined
    const index = typeof column === 'number'
      ? column
      : header.findIndex(name => normalise(name) === normalise(column))
    if (index < 0 || index >= row.length) return undefined
    const value = row[index].trim()
    return value === '' ? undefined : value
  }

  const skip = profile.skipRows?.trim().toLowerCase()
  return rows
    .filter(row => !row.every(cell => cell.trim() === ''))
    .filter(row => skip === undefined || skip === '' || !(row[0] ?? '').trim().toLowerCase().startsWith(skip))
    .slice(0, PREVIEW_ROWS)
    .map(row => ({
      date: parseCsvDate(at(row, columns.date), profile.dateFormat),
      payee: at(row, columns.payee),
      amount: amountOf(row, at, profile)
    }))
}

function amountOf(
  row: string[],
  at: (row: string[], column: CsvColumn | undefined) => string | undefined,
  profile: CsvProfile
): number | undefined {
  const { columns, decimal } = profile
  if (columns.amount !== undefined) {
    const parsed = parseCsvAmount(at(row, columns.amount), decimal)
    if (!parsed.ok) return undefined
    return profile.debitsArePositive === true ? -parsed.minor : parsed.minor
  }
  const debit = parseCsvAmount(at(row, columns.debit), decimal)
  const credit = parseCsvAmount(at(row, columns.credit), decimal)
  if (debit.ok && debit.minor !== 0) return -Math.abs(debit.minor)
  if (credit.ok && credit.minor !== 0) return Math.abs(credit.minor)
  if (debit.ok || credit.ok) return 0
  return undefined
}

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Minor units as a plain figure. No currency symbol: the file has not been bound to an account yet. */
function money(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const magnitude = Math.abs(minor)
  return `${sign}${(Math.floor(magnitude / 100)).toLocaleString()}.${String(magnitude % 100).padStart(2, '0')}`
}
