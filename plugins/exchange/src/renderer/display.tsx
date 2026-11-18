// How dates, amounts and dispositions look in the review.
import { DISPOSITION_LABELS, type Disposition } from '@tessera/exchange-api'
import { formatAmount } from '@tessera/accounts-api'
import { Box } from '@tessera/ui'

/** A date for display, in the user's locale, without any time zone shifting it. */
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * The day a moment fell on, where the user is, in the same style as `showDate`. For timestamps — when an import
 * was made, when a source was last read — which are instants rather than calendar dates: slicing the first ten
 * characters off one gives the day in UTC, which near midnight is not the user's day at all.
 */
export const showTimestamp = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))

/** The same date, short, for a column that has to stay narrow. */
export const showShortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/**
 * How each disposition reads and looks. Colour is never the only signal: a duplicate is also struck through
 * and says so in words, so the row is still obvious to someone who cannot tell the colours apart.
 */
export const DISPOSITIONS: Readonly<Record<Disposition, { label: string, colour?: string, icon?: string }>> = {
  new: { label: DISPOSITION_LABELS.new },
  merge: { label: DISPOSITION_LABELS.merge, icon: 'Link' },
  conflict: { label: DISPOSITION_LABELS.conflict, colour: 'warning.main', icon: 'Warning' },
  duplicate: { label: DISPOSITION_LABELS.duplicate, colour: 'text.disabled' }
}

/** Whole days from `a` to `b`: positive when `b` is later. */
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** '2 days earlier', 'the day after', for the register's date against the statement's. */
export function driftOf(statementDate: string, registerDate: string): string | undefined {
  const days = daysBetween(statementDate, registerDate)
  if (days === 0) return undefined
  const n = Math.abs(days)
  return `${n} day${n === 1 ? '' : 's'} ${days < 0 ? 'earlier' : 'later'}`
}

/** Whether two payee names are the same as far as a person is concerned: case and spacing aside. */
export const samePayee = (a: string | undefined, b: string | undefined) =>
  (a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === (b ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** A clearing status in words, for the register's side of a match. */
export const STATUS_WORDS = { uncleared: 'Uncleared', electronic: 'Imported (E)', cleared: 'Cleared (C)', reconciled: 'Reconciled (R)' } as const

/** A signed amount, the Microsoft Money way: what leaves the account shows as negative, in red. */
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

/** `•••• 6789` for the account a statement came from, so the whole number is not on screen. */
export const maskNumber = (number: string | undefined) => {
  if (number === undefined || number === '') return ''
  const key = number.replace(/[^0-9A-Za-z]/g, '')
  return key.length <= 4 ? number : `•••• ${key.slice(-4)}`
}
