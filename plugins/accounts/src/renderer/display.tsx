// How accounts and amounts look, everywhere the accounts plugin shows them.
import type { AccountType, CurrencyTotals } from '@tessera/accounts-api'
import { formatAmount } from '@tessera/accounts-api'
import { Box } from '@tessera/ui'

/** A date for display, in the user's locale, without any time zone shifting it. */
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** An icon per type, from the shell's standard set. */
export const TYPE_ICONS: Readonly<Record<AccountType, string>> = {
  chequing: 'AccountBalance',
  savings: 'Savings',
  cash: 'Savings',
  creditCard: 'CreditCard',
  lineOfCredit: 'CreditCard',
  loan: 'List',
  mortgage: 'Home',
  investment: 'ShowChart',
  retirement: 'ShowChart',
  otherAsset: 'Circle',
  otherLiability: 'Circle'
}

/**
 * A signed balance, the Microsoft Money way: what is owed shows as negative, in red. The colour comes from the
 * theme's error token, so it reads in light and dark themes.
 */
export function Balance({ minor, currency, muted = false }: { minor: number, currency: string, muted?: boolean }) {
  return (
    <Box
      component="span"
      data-negative={minor < 0 || undefined}
      sx={{
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        color: minor < 0 ? 'error.main' : muted ? 'text.secondary' : 'text.primary'
      }}
    >
      {formatAmount(minor, currency)}
    </Box>
  )
}

/** Totals in one or more currencies, each signed and coloured like a balance. */
export function Totals({ totals, muted = false }: { totals: CurrencyTotals, muted?: boolean }) {
  const entries = Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return null
  return (
    <Box component="span" sx={{ display: 'inline-flex', gap: 1 }}>
      {entries.map(([currency, minor]) => <Balance key={currency} minor={minor} currency={currency} muted={muted} />)}
    </Box>
  )
}
