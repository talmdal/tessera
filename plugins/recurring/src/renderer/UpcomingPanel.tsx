// The Upcoming panel (right bar): what falls due over the next few weeks, across every account, grouped by day.
// It is the forecast made visible — every occurrence in the window, not just the first of each series — so the
// user can see a lean week coming while the register is in front.
import { useEffect, useState } from 'react'
import {
  DEFAULT_HORIZON_DAYS, RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_EVENTS, addIsoDays,
  type ForecastEntry, type RecurringSnapshot
} from '@tessera/recurring-api'
import type { CurrencyTotals } from '@tessera/accounts-api'
import {
  Alert, Box, CircularProgress, Icon, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'
import { Amount, showDate, Totals } from './display'

export const HORIZONS = [7, DEFAULT_HORIZON_DAYS, 90] as const

/** Entries grouped by the day they fall on, in order. */
export function byDay(entries: readonly ForecastEntry[]): { date: string, entries: ForecastEntry[] }[] {
  const days: { date: string, entries: ForecastEntry[] }[] = []
  for (const entry of entries) {
    const last = days[days.length - 1]
    if (last && last.date === entry.date) last.entries.push(entry)
    else days.push({ date: entry.date, entries: [entry] })
  }
  return days
}

/** What the window adds up to, per currency. A transfer is a wash across the book, so it is left out. */
export function netOf(entries: readonly ForecastEntry[]): CurrencyTotals {
  const totals: CurrencyTotals = {}
  for (const entry of entries) {
    if (entry.transferAccountId !== undefined) continue
    totals[entry.currency] = (totals[entry.currency] ?? 0) + entry.amount
  }
  return totals
}

export default function UpcomingPanel() {
  const snapshot = useFollowed<RecurringSnapshot | null>(RECURRING_CHANNELS.snapshot, RECURRING_EVENTS.snapshot)
  const [horizon, setHorizon] = useState<number>(DEFAULT_HORIZON_DAYS)
  const [entries, setEntries] = useState<ForecastEntry[]>()

  // Re-asked whenever the snapshot moves: an entry, a skip, a new series, the date rolling over
  useEffect(() => {
    if (!snapshot) { setEntries(undefined); return }
    let live = true
    window.api.invoke<ForecastEntry[]>(RECURRING_CHANNELS.forecast, { from: snapshot.today, to: addIsoDays(snapshot.today, horizon) })
      .then(found => { if (live) setEntries(found ?? []) }, () => { if (live) setEntries([]) })
    return () => { live = false }
  }, [snapshot, horizon])

  const open = () => void runCommand(C.open).catch(() => undefined)

  if (snapshot === undefined || (snapshot && entries === undefined)) {
    return <Stack sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} aria-label="Loading what is upcoming" /></Stack>
  }
  if (snapshot === null) {
    return <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>Open a book to see what is coming.</Typography>
  }

  const overdue = snapshot.summary.overdueCount
  const days = byDay(entries ?? [])

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} data-recurring-page="upcoming">
      <Stack direction="row" sx={{ px: 1.5, pt: 1, pb: 0.5, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2" component="h2">Upcoming</Typography>
        <ToggleButtonGroup size="small" exclusive value={horizon} onChange={(_e, value) => { if (typeof value === 'number') setHorizon(value) }}
          aria-label="How far ahead">
          {HORIZONS.map(h => <ToggleButton key={h} value={h} sx={{ px: 1, py: 0.25 }}>{h}d</ToggleButton>)}
        </ToggleButtonGroup>
      </Stack>

      <Box sx={{ px: 1.5, pb: 1 }}>
        <Typography variant="caption" color="text.secondary" component="div">Net over {horizon} days</Typography>
        <Typography variant="subtitle1" component="div" data-upcoming="net"><Totals totals={netOf(entries ?? [])} /></Typography>
      </Box>

      {overdue > 0 && (
        <Alert severity="warning" sx={{ mx: 1.5, mb: 1, py: 0 }} data-note="overdue"
          onClick={open} role="button" style={{ cursor: 'pointer' }}>
          {overdue === 1 ? '1 transaction is overdue' : `${overdue} transactions are overdue`}
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1 }} role="list" aria-label="Upcoming transactions">
        {days.length === 0 && (
          <Typography variant="body2" color="text.secondary">Nothing falls due in the next {horizon} days.</Typography>
        )}
        {days.map(day => (
          <Box key={day.date} sx={{ mb: 1 }} data-upcoming-day={day.date}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ borderBottom: 1, borderColor: 'divider', mb: 0.25 }}>
              {showDate(day.date)}
            </Typography>
            {day.entries.map((entry, index) => (
              <Stack key={`${entry.seriesId}-${index}`} direction="row" role="listitem" spacing={1} onClick={open}
                sx={{ alignItems: 'baseline', py: 0.25, cursor: 'default', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
                data-upcoming-entry={entry.seriesId}>
                {entry.transferAccountId !== undefined && <Icon name="Repeat" fontSize="inherit" titleAccess="Transfer" />}
                <Tooltip title={entry.estimated ? 'The amount varies; this is an estimate' : ''}>
                  <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                    {entry.name}{entry.estimated && <Box component="span" sx={{ color: 'text.secondary', ml: 0.5, fontSize: '0.75em' }}>est.</Box>}
                  </Typography>
                </Tooltip>
                <Typography variant="body2"><Amount minor={entry.amount} currency={entry.currency} /></Typography>
              </Stack>
            ))}
          </Box>
        ))}
      </Box>
    </Stack>
  )
}
