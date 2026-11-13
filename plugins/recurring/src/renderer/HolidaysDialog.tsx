// Holidays…: the days the book treats as not business days, over and above weekends, which a business-day rule
// steps over. It saves as it goes, like everything else in the app, so there is no OK button — only Close.
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { isIsoDate } from '@tessera/accounts-api'
import {
  HOLIDAY_NAME_MAX_LENGTH, RECURRING_CHANNELS, type Holiday, type HolidaysDialogInput, type RecurringResult
} from '@tessera/recurring-api'
import {
  Alert, Box, Button, DialogActions, DialogContent, Icon, IconButton, List, ListItemButton, ListItemText, Stack,
  TextField, Tooltip, Typography
} from '@tessera/ui'
import { showDate } from './display'

export default function HolidaysDialog({ input, close }: DialogProps<HolidaysDialogInput, void>) {
  const [holidays, setHolidays] = useState<Holiday[]>(input.holidays)
  const [date, setDate] = useState(input.today)
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!isIsoDate(date)) { setProblem('Enter the holiday’s date.'); return }
    setBusy(true)
    try {
      const result = await window.api.invoke<RecurringResult<Holiday>>(RECURRING_CHANNELS.addHoliday, { date, name })
      if (!result.ok) { setProblem(result.error.message); return }
      setHolidays(was => [...was, result.value].sort((a, b) => a.date.localeCompare(b.date)))
      setName('')
      setProblem(undefined)
    } catch (err) {
      setProblem(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (holiday: Holiday) => {
    setBusy(true)
    try {
      const result = await window.api.invoke<RecurringResult<void>>(RECURRING_CHANNELS.removeHoliday, { id: holiday.id })
      if (!result.ok) { setProblem(result.error.message); return }
      setHolidays(was => was.filter(h => h.id !== holiday.id))
    } finally {
      setBusy(false)
    }
  }

  const past = holidays.filter(h => h.date < input.today).length

  return (
    <Box data-recurring-dialog="holidays">
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            A recurring transaction set to avoid weekends avoids these days too. Each book keeps its own list.
          </Typography>

          <Box component="form" onSubmit={add}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField
                label="Date" type="date" size="small" value={date} onChange={e => setDate(e.target.value)}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': 'Date' } }}
                error={problem !== undefined} helperText={problem}
              />
              <TextField
                label="Name" size="small" sx={{ flex: 1 }} value={name} onChange={e => setName(e.target.value)}
                placeholder="Holiday"
                slotProps={{ htmlInput: { 'aria-label': 'Name', maxLength: HOLIDAY_NAME_MAX_LENGTH } }}
              />
              <Button type="submit" variant="contained" disabled={busy} sx={{ mt: 0.25 }}>Add</Button>
            </Stack>
          </Box>

          {holidays.length === 0
            ? <Alert severity="info">No holidays yet. Only Saturdays and Sundays are stepped over.</Alert>
            : (
              <List dense disablePadding aria-label="Holidays">
                {holidays.map(holiday => (
                  <ListItemButton key={holiday.id} disableRipple sx={{ cursor: 'default', opacity: holiday.date < input.today ? 0.6 : 1 }}
                    data-holiday={holiday.date}>
                    <ListItemText primary={holiday.name} secondary={showDate(holiday.date)} />
                    <Tooltip title="Remove">
                      <IconButton size="small" edge="end" aria-label={`Remove ${holiday.name}`} disabled={busy} onClick={() => void remove(holiday)}>
                        <Icon name="Delete" fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </ListItemButton>
                ))}
              </List>
            )}
          {past > 0 && (
            <Typography variant="caption" color="text.secondary">
              {past === 1 ? '1 of these has passed' : `${past} of these have passed`}; they still matter for anything entered late.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close(undefined)}>Close</Button>
      </DialogActions>
    </Box>
  )
}
