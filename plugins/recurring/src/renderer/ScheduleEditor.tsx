// How often it repeats: the ten choices Money offered, mapped onto a frequency and an interval, with the extra
// controls each one needs. The preview beneath it is computed here in the renderer — which is why the schedule
// engine lives in @tessera/recurring-api rather than in the plugin's privileged half.
import {
  FREQUENCY_CHOICES, MAX_INTERVAL, MAX_REMIND_DAYS, describeSchedule, firstIndexOnOrAfter, occurrencesFrom,
  validateSchedule,
  type BusinessCalendar, type Frequency, type MonthDay, type Schedule, type ScheduleEnd, type WeekendRule
} from '@tessera/recurring-api'
import {
  Alert, Box, MenuItem, Stack, TextField, Typography
} from '@tessera/ui'
import { showDate } from './display'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKS: { value: 1 | 2 | 3 | 4 | -1, label: string }[] = [
  { value: 1, label: 'first' }, { value: 2, label: 'second' }, { value: 3, label: 'third' },
  { value: 4, label: 'fourth' }, { value: -1, label: 'last' }
]
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** The dialog's own choice of frequency: one of the ten, or `custom` for any other interval. */
const CUSTOM = 'custom'

export const choiceOf = (schedule: Schedule): string => {
  const index = FREQUENCY_CHOICES.findIndex(c => c.frequency === schedule.frequency && c.interval === schedule.interval)
  return index === -1 ? CUSTOM : String(index)
}

const DAY_CHOICES: MonthDay[] = [...Array.from({ length: 31 }, (_, i) => i + 1), 'last']

const dayValue = (day: MonthDay) => day === 'last' ? 'last' : String(day)
const dayFrom = (value: string): MonthDay => value === 'last' ? 'last' : Number(value)

export function ScheduleEditor({ schedule, onChange, remindDays, onRemindDays, previewFrom, calendar }: {
  schedule: Schedule
  onChange(next: Schedule): void
  remindDays: number
  onRemindDays(value: number): void
  /** Preview from the first occurrence on or after this date, rather than from the first of all. */
  previewFrom?: string
  /** The book's holidays, so the preview moves dates the way the plugin will. */
  calendar?: BusinessCalendar
}) {
  const choice = choiceOf(schedule)
  const set = (patch: Partial<Schedule>) => onChange({ ...schedule, ...patch })

  const monthly = schedule.frequency === 'monthly' || schedule.frequency === 'yearly'
  const rule = schedule.monthlyRule ?? { kind: 'dayOfMonth' as const, day: Number(schedule.startDate.slice(8, 10)) || 1 }
  const semiMonthlyDays = schedule.semiMonthlyDays ?? [1, 'last']

  const problem = validateSchedule(schedule)
  const fromIndex = previewFrom === undefined ? 0 : firstIndexOnOrAfter(schedule, previewFrom, calendar)
  const preview = problem || fromIndex === undefined ? [] : occurrencesFrom(schedule, { fromIndex, limit: 3, calendar })

  const pickChoice = (value: string) => {
    if (value === CUSTOM) { set({}); return }
    const { frequency, interval } = FREQUENCY_CHOICES[Number(value)]
    // Controls that mean nothing for the new frequency are dropped, rather than kept and refused
    const next: Schedule = { ...schedule, frequency, interval }
    if (frequency !== 'monthly' && frequency !== 'yearly') delete next.monthlyRule
    if (frequency !== 'semiMonthly') delete next.semiMonthlyDays
    if (frequency !== 'yearly') delete next.month
    onChange(next)
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2}>
        <TextField
          select label="How often" size="small" sx={{ flex: 1 }} value={choice}
          onChange={e => pickChoice(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': 'How often' } }}
        >
          {FREQUENCY_CHOICES.map((c, index) => <MenuItem key={c.label} value={String(index)}>{c.label}</MenuItem>)}
          <MenuItem value={CUSTOM}>Custom…</MenuItem>
        </TextField>

        <TextField
          label="Starting" type="date" size="small" sx={{ width: 190 }} value={schedule.startDate}
          onChange={e => set({ startDate: e.target.value })}
                    slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': 'Starting' } }}
        />
      </Stack>

      {choice === CUSTOM && (
        <Stack direction="row" spacing={2}>
          <TextField
            label="Every" type="number" size="small" sx={{ width: 110 }} value={schedule.interval}
            onChange={e => set({ interval: Math.max(1, Math.min(MAX_INTERVAL, Number(e.target.value) || 1)) })}
            slotProps={{ htmlInput: { min: 1, max: MAX_INTERVAL, 'aria-label': 'Every' } }}
          />
          <TextField
            select label="Unit" size="small" sx={{ width: 170 }} value={schedule.frequency}
            onChange={e => set({ frequency: e.target.value as Frequency })}
            slotProps={{ htmlInput: { 'aria-label': 'Unit' } }}
          >
            <MenuItem value="daily">days</MenuItem>
            <MenuItem value="weekly">weeks</MenuItem>
            <MenuItem value="monthly">months</MenuItem>
            <MenuItem value="yearly">years</MenuItem>
            <MenuItem value="semiMonthly">twice a month</MenuItem>
          </TextField>
        </Stack>
      )}

      {monthly && (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <TextField
            select label="On" size="small" sx={{ width: 170 }} value={rule.kind}
            onChange={e => set({
              monthlyRule: e.target.value === 'dayOfMonth'
                ? { kind: 'dayOfMonth', day: Number(schedule.startDate.slice(8, 10)) || 1 }
                : { kind: 'nthWeekday', week: 1, weekday: 1 }
            })}
            slotProps={{ htmlInput: { 'aria-label': 'On' } }}
          >
            <MenuItem value="dayOfMonth">a day of the month</MenuItem>
            <MenuItem value="nthWeekday">a weekday</MenuItem>
          </TextField>

          {rule.kind === 'dayOfMonth' ? (
            <TextField
              select label="Day" size="small" sx={{ width: 140 }} value={dayValue(rule.day)}
              onChange={e => set({ monthlyRule: { kind: 'dayOfMonth', day: dayFrom(e.target.value) } })}
              slotProps={{ htmlInput: { 'aria-label': 'Day' } }}
            >
              {DAY_CHOICES.map(day => (
                <MenuItem key={dayValue(day)} value={dayValue(day)}>{day === 'last' ? 'the last day' : day}</MenuItem>
              ))}
            </TextField>
          ) : (
            <>
              <TextField
                select label="Week" size="small" sx={{ width: 120 }} value={String(rule.week)}
                onChange={e => set({ monthlyRule: { ...rule, week: Number(e.target.value) as 1 | 2 | 3 | 4 | -1 } })}
                slotProps={{ htmlInput: { 'aria-label': 'Week' } }}
              >
                {WEEKS.map(w => <MenuItem key={w.value} value={String(w.value)}>{w.label}</MenuItem>)}
              </TextField>
              <TextField
                select label="Weekday" size="small" sx={{ width: 150 }} value={String(rule.weekday)}
                onChange={e => set({ monthlyRule: { ...rule, weekday: Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6 } })}
                slotProps={{ htmlInput: { 'aria-label': 'Weekday' } }}
              >
                {WEEKDAYS.map((name, index) => <MenuItem key={name} value={String(index)}>{name}</MenuItem>)}
              </TextField>
            </>
          )}

          {schedule.frequency === 'yearly' && (
            <TextField
              select label="Month" size="small" sx={{ width: 150 }}
              value={String(schedule.month ?? (Number(schedule.startDate.slice(5, 7)) || 1))}
              onChange={e => set({ month: Number(e.target.value) })}
              slotProps={{ htmlInput: { 'aria-label': 'Month' } }}
            >
              {MONTHS.map((name, index) => <MenuItem key={name} value={String(index + 1)}>{name}</MenuItem>)}
            </TextField>
          )}
        </Stack>
      )}

      {schedule.frequency === 'semiMonthly' && (
        <Stack direction="row" spacing={2}>
          {[0, 1].map(which => (
            <TextField
              key={which} select size="small" sx={{ width: 150 }}
              label={which === 0 ? 'First day' : 'Second day'}
              value={dayValue(semiMonthlyDays[which])}
              onChange={e => {
                const next: [MonthDay, MonthDay] = [...semiMonthlyDays] as [MonthDay, MonthDay]
                next[which] = dayFrom(e.target.value)
                set({ semiMonthlyDays: next })
              }}
              slotProps={{ htmlInput: { 'aria-label': which === 0 ? 'First day' : 'Second day' } }}
            >
              {DAY_CHOICES.map(day => (
                <MenuItem key={dayValue(day)} value={dayValue(day)}>{day === 'last' ? 'the last day' : day}</MenuItem>
              ))}
            </TextField>
          ))}
        </Stack>
      )}

      <Stack direction="row" spacing={2}>
        <TextField
          select label="At a weekend or holiday" size="small" sx={{ flex: 1 }} value={schedule.weekendRule ?? 'none'}
          onChange={e => set({ weekendRule: e.target.value as WeekendRule })}
          slotProps={{ htmlInput: { 'aria-label': 'At a weekend or holiday' } }}
        >
          <MenuItem value="none">leave the date alone</MenuItem>
          <MenuItem value="before">move to the business day before</MenuItem>
          <MenuItem value="after">move to the next business day</MenuItem>
        </TextField>

        <TextField
          label="Remind me, days ahead" type="number" size="small" sx={{ width: 200 }} value={remindDays}
          onChange={e => onRemindDays(Math.max(0, Math.min(MAX_REMIND_DAYS, Number(e.target.value) || 0)))}
          slotProps={{ htmlInput: { min: 0, max: MAX_REMIND_DAYS, 'aria-label': 'Remind me, days ahead' } }}
        />
      </Stack>

      <EndEditor end={schedule.end ?? { kind: 'never' }} startDate={schedule.startDate} onChange={end => set({ end })} />

      <Box data-preview="schedule">
        {problem
          ? <Alert severity="warning">{problem}</Alert>
          : (
            <Typography variant="body2" color="text.secondary">
              {describeSchedule(schedule)}
              {preview.length > 0 && `. Next: ${preview.map(o => showDate(o.date)).join(', ')}`}
            </Typography>
          )}
      </Box>
    </Stack>
  )
}

function EndEditor({ end, startDate, onChange }: { end: ScheduleEnd, startDate: string, onChange(end: ScheduleEnd): void }) {
  return (
    <Stack direction="row" spacing={2}>
      <TextField
        select label="Ends" size="small" sx={{ width: 190 }} value={end.kind}
        onChange={e => {
          const kind = e.target.value as ScheduleEnd['kind']
          onChange(kind === 'never' ? { kind } : kind === 'onDate' ? { kind, date: startDate } : { kind, count: 12 })
        }}
        slotProps={{ htmlInput: { 'aria-label': 'Ends' } }}
      >
        <MenuItem value="never">never</MenuItem>
        <MenuItem value="onDate">on a date</MenuItem>
        <MenuItem value="afterCount">after a number of times</MenuItem>
      </TextField>

      {end.kind === 'onDate' && (
        <TextField
          label="Ending" type="date" size="small" sx={{ width: 190 }} value={end.date}
          onChange={e => onChange({ kind: 'onDate', date: e.target.value })}
                    slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': 'Ending' } }}
        />
      )}
      {end.kind === 'afterCount' && (
        <TextField
          label="Times" type="number" size="small" sx={{ width: 120 }} value={end.count}
          onChange={e => onChange({ kind: 'afterCount', count: Math.max(1, Number(e.target.value) || 1) })}
          slotProps={{ htmlInput: { min: 1, 'aria-label': 'Times' } }}
        />
      )}
    </Stack>
  )
}
