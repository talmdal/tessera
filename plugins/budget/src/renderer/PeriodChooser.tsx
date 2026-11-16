// The period the budget view shows: ◀ and ▶ step a month (a year, in Year), the month is a picker, and the select
// chooses one month, the budget year to date, or the whole budget year month by month.
import { addMonths, isMonth, type BudgetPeriod } from '@tessera/budget-api'
import { Icon, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from '@tessera/ui'
import { periodName } from './display'

export interface PeriodChooserProps {
  month: string
  period: BudgetPeriod
  yearStartMonth: number
  onChange(month: string, period: BudgetPeriod): void
}

/** How far ◀ ▶ and Page Up and Page Down step: a year in Year, else a month. */
export const stepOf = (period: BudgetPeriod) => period === 'year' ? 12 : 1

export function PeriodChooser({ month, period, yearStartMonth, onChange }: PeriodChooserProps) {
  const unit = period === 'year' ? 'year' : 'month'
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Tooltip title={`Previous ${unit} (Page Up)`}>
        <IconButton size="small" aria-label={`Previous ${unit}`} onClick={() => onChange(addMonths(month, -stepOf(period)), period)}><Icon name="ChevronLeft" /></IconButton>
      </Tooltip>
      <TextField size="small" type="month" value={month} margin="none"
        onChange={event => { if (isMonth(event.target.value)) onChange(event.target.value, period) }}
        slotProps={{ htmlInput: { 'aria-label': 'Month shown' } }} sx={{ width: '11em' }} />
      <Tooltip title={`Next ${unit} (Page Down)`}>
        <IconButton size="small" aria-label={`Next ${unit}`} onClick={() => onChange(addMonths(month, stepOf(period)), period)}><Icon name="ChevronRight" /></IconButton>
      </Tooltip>
      <TextField select size="small" margin="none" value={period} onChange={event => onChange(month, event.target.value as BudgetPeriod)}
        slotProps={{ htmlInput: { 'aria-label': 'Period' } }} sx={{ minWidth: '10em' }}>
        <MenuItem value="month">Month</MenuItem>
        <MenuItem value="yearToDate">Year to date</MenuItem>
        <MenuItem value="year">Year</MenuItem>
      </TextField>
      <Typography variant="body2" color="text.secondary" sx={{ pl: 1 }} data-period-label>{periodName(period, month, yearStartMonth)}</Typography>
    </Stack>
  )
}
