// How accounts and amounts look, everywhere the accounts plugin shows them.
import type { Account, AccountType, CurrencyTotals } from '@tessera/accounts-api'
import { formatAmount, isLiability, periodStart } from '@tessera/accounts-api'
import { Box } from '@tessera/ui'

/** A date for display, in the user's locale, without any time zone shifting it. */
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * A width designed for 13 px text, in em of the table's text. Tables are drawn in the Tables and registers font role,
 * whose size the user and themes can change; in em, a column grows with its text, so an amount is never cut short
 * because the text got bigger. (The shell gives a table the same size as its cells, which is what em is measured by.)
 * Rounded up, so at 13 px the width is never a fraction of a pixel short of `px`: layout would round that down, and every
 * column after it would move.
 */
/**
 * What an archived account's opening balance is, for the register's first row and the account dialog: undefined for an
 * account never archived, whose opening balance is simply what it opened with.
 */
export function openingBalanceNote(account: Pick<Account, 'type' | 'currency' | 'openingDate' | 'lastArchiveDate' | 'archived'>): string | undefined {
  if (account.lastArchiveDate === undefined || account.archived === undefined) return undefined
  const { count, originalOpeningBalance } = account.archived
  const opened = isLiability(account.type)
    ? `owing ${formatAmount(-originalOpeningBalance, account.currency)}`
    : `with ${formatAmount(originalOpeningBalance, account.currency)}`
  return `The opening balance on ${showDate(periodStart(account))}, the last archival date. ` +
    `${count.toLocaleString()} earlier ${count === 1 ? 'transaction is' : 'transactions are'} in the archive file. ` +
    `The account opened on ${showDate(account.openingDate)} ${opened}.`
}

/** The account dialog's line under the opening balance, once the account has been archived: that balance is the
 *  current period's, so the line says when the period starts and what the account opened with. */
export function openingFieldNote(account: Pick<Account, 'type' | 'currency' | 'openingDate' | 'lastArchiveDate' | 'archived'>): string | undefined {
  if (account.lastArchiveDate === undefined || account.archived === undefined) return undefined
  const original = account.archived.originalOpeningBalance
  const opened = isLiability(account.type)
    ? `owing ${formatAmount(-original, account.currency)}`
    : `with ${formatAmount(original, account.currency)}`
  return `On ${showDate(periodStart(account))}, the last archival date. The account opened ${opened}.`
}

export const em = (px: number) => `${Math.ceil(px / 13 * 1e4) / 1e4}em`

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
        typography: 'numeric', whiteSpace: 'nowrap',
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
