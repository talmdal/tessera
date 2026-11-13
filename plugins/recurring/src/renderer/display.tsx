// How dates, amounts and due states look in the Recurring view.
import { formatAmount, type CurrencyTotals } from '@tessera/accounts-api'
import type { DueState } from '@tessera/recurring-api'
import { Box } from '@tessera/ui'

/** A date for display, in the user's locale, without any time zone shifting it. */
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** The same date, short, for a column that has to stay narrow. */
export const showShortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * How each state reads and looks. Colour is never the only signal: an overdue row also carries an icon and sorts
 * to the top, so it is still obvious to someone who can't tell the colours apart.
 */
export const DUE_STATES: Readonly<Record<DueState, { label: string, colour?: 'error.main' | 'warning.main', icon?: string }>> = {
  overdue: { label: 'Overdue', colour: 'error.main', icon: 'Warning' },
  dueToday: { label: 'Due today', colour: 'warning.main', icon: 'Warning' },
  dueSoon: { label: 'Due soon' },
  upcoming: { label: 'Upcoming' },
  paused: { label: 'Paused', icon: 'Pause' },
  ended: { label: 'Finished' }
}

/**
 * A signed amount, the Microsoft Money way: what leaves the account shows as negative, in red. One column rather
 * than the register's two, because these rows come from accounts whose column labels differ.
 */
export function Amount({ minor, currency, muted = false }: { minor: number, currency: string, muted?: boolean }) {
  return (
    <Box
      component="span"
      data-negative={minor < 0 || undefined}
      sx={{
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        color: muted ? 'text.disabled' : minor < 0 ? 'error.main' : 'text.primary'
      }}
    >
      {formatAmount(minor, currency)}
    </Box>
  )
}

/** Totals in one or more currencies: a book can hold accounts in several, so they are never added together. */
export function Totals({ totals, muted = false }: { totals: CurrencyTotals, muted?: boolean }) {
  const entries = Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return <Box component="span" sx={{ color: 'text.secondary' }}>—</Box>
  return (
    <Box component="span" sx={{ display: 'inline-flex', gap: 1 }}>
      {entries.map(([currency, minor]) => <Amount key={currency} minor={minor} currency={currency} muted={muted} />)}
    </Box>
  )
}
