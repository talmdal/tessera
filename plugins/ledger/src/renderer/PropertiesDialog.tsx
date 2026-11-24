// File › Ledger Properties…: the open ledger's name and file, and when its year starts. Saves the year start itself,
// so a refusal is shown here and the dialog stays open. Read-only for an archive file, or a ledger open read-only.
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  LEDGER_CHANNELS, YEAR_START_MONTH_DAYS, displayDate, yearStartLabel, yearStartProblem,
  type LedgerInfo, type LedgerPropertiesDialogInput, type Result
} from '@tessera/ledger-api'
import { Alert, Button, DialogActions, DialogContent, MenuItem, Stack, TextField, Typography } from '@tessera/ui'

/** January to December, in the user's own language. */
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2001, i, 1)).toLocaleDateString([], { month: 'long', timeZone: 'UTC' }))

export default function PropertiesDialog({ input, close, setBusy }: DialogProps<LedgerPropertiesDialogInput, LedgerInfo>) {
  const [month, setMonth] = useState(input.yearStart.month)
  const [day, setDay] = useState(String(input.yearStart.day))
  const [serverError, setServerError] = useState<{ message: string, field?: string }>()
  const [saving, setSaving] = useState(false)

  const yearStart = { month, day: Number(day) }
  const problem = day.trim() === '' ? 'Enter the day the year starts.' : yearStartProblem(yearStart)
  const dayError = serverError?.field === 'yearStart' ? serverError.message : problem
  const unchanged = month === input.yearStart.month && Number(day) === input.yearStart.day

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (input.readOnly || unchanged) { close(); return }
    if (problem || saving) return

    setSaving(true)
    setBusy(true)
    try {
      const result = await window.api.invoke<Result<LedgerInfo>>(LEDGER_CHANNELS.setYearStart, { yearStart })
      if (result.ok) { close(result.value); return }
      setServerError(result.error)
    } catch (err) {
      setServerError({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  const changeMonth = (next: number) => {
    setMonth(next)
    setServerError(undefined)
    // 31 January becomes 30 April rather than a day the new month hasn't
    const last = YEAR_START_MONTH_DAYS[next - 1]
    if (Number(day) > last) setDay(String(last))
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <div>
            <Typography variant="subtitle1">{input.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{input.path}</Typography>
          </div>
          {input.archive && (
            <Alert severity="info">
              An archive of “{input.archive.ledgerName}”: what was in it before {displayDate(input.archive.before)}. It can’t be changed.
            </Alert>
          )}
          {input.readOnly && !input.archive && <Alert severity="info">This ledger is open read-only, so its properties can’t be changed.</Alert>}
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <TextField
              select
              size="small"
              label="Year starts in"
              value={month}
              onChange={event => changeMonth(Number(event.target.value))}
              disabled={input.readOnly || saving}
              sx={{ minWidth: 180 }}
            >
              {MONTHS.map((name, i) => <MenuItem key={name} value={i + 1}>{name}</MenuItem>)}
            </TextField>
            <TextField
              size="small"
              label="On day"
              type="number"
              value={day}
              onChange={event => { setDay(event.target.value); setServerError(undefined) }}
              disabled={input.readOnly || saving}
              error={!input.readOnly && dayError !== undefined}
              helperText={!input.readOnly && dayError !== undefined ? dayError : ' '}
              slotProps={{ htmlInput: { min: 1, max: YEAR_START_MONTH_DAYS[month - 1], step: 1 } }}
              sx={{ width: 120 }}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {problem === undefined ? `The ledger’s year starts on ${yearStartLabel(yearStart)}. ` : ''}
            Reports’ years and quarters, the date Archive Ledger… suggests and the month New Budget… suggests all follow it.
            For a UK tax year, choose 6 April; for a year from July, 1 July.
          </Typography>
          {serverError && serverError.field !== 'yearStart' && <Alert severity="error">{serverError.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {input.readOnly
          ? <Button type="submit" variant="contained">Close</Button>
          : <>
              <Button onClick={() => close()} disabled={saving}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={saving || (problem !== undefined && !unchanged)}>OK</Button>
            </>}
      </DialogActions>
    </form>
  )
}
