// How the import dialogs write amounts and dates: as the register does (negatives in the theme's error colour, never a
// literal), and dates in the user's locale.
import { formatAmount } from '@tessera/accounts-api'
import { Box } from '@tessera/ui'

/** A signed amount, red when negative, as balances are shown everywhere in Tessera. */
export function Amount({ minor, currency }: { minor: number, currency: string }) {
  return (
    <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', ...(minor < 0 && { color: 'error.main' }) }}>
      {formatAmount(minor, currency, { currency: false })}
    </Box>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const parse = (date: string) => new Date(`${date}T00:00:00Z`)

/** 'Oct 1, 2026'. */
export const showDate = (date: string) => dateFormat.format(parse(date))

/** 'Oct 1 – Oct 31, 2026', or as much of it as is known. */
export function showPeriod(period: { from?: string, to?: string } | undefined): string | undefined {
  if (!period?.from && !period?.to) return undefined
  if (period.from && period.to) return dateFormat.formatRange(parse(period.from), parse(period.to))
  return period.from ? `from ${showDate(period.from)}` : `to ${showDate(period.to!)}`
}

/** '1 transaction', '42 transactions'. */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
