// Money is integer minor units (cents) everywhere it is stored or computed. These helpers are the only place text
// becomes an amount and back, and they never go through floating point on the way in.

/** The largest amount, in minor units, anything stores: ten trillion major units at two digits. */
export const MAX_AMOUNT = 10 ** 15

const supported = (() => {
  try {
    return new Set((Intl as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.('currency') ?? [])
  } catch {
    return new Set<string>()
  }
})()

/** An ISO 4217 code this runtime knows ('CAD', 'JPY'…). Upper case only. */
export function isCurrencyCode(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false
  return supported.size === 0 || supported.has(code)
}

/** Every currency code this runtime knows, sorted. */
export function currencyCodes(): string[] {
  return [...supported].sort()
}

/**
 * What is built from `Intl` once and kept: building an `Intl.NumberFormat` costs about 30 times formatting with one
 * (97 µs against 3 µs, measured in docs/budget-design.md, Phase B0 results), and registers and budgets format thousands
 * of amounts. Keyed by what each was made from; a failure (an unknown currency or locale) is never kept, so it throws
 * every time, as before. Each cache is emptied if it ever holds more than `KEEP_AT_MOST`, which no real use reaches.
 */
const KEEP_AT_MOST = 500
function kept<K, V>(cache: Map<K, V>, key: K, make: () => V): V {
  let value = cache.get(key)
  if (value === undefined) {
    value = make()
    if (cache.size >= KEEP_AT_MOST) cache.clear()
    cache.set(key, value)
  }
  return value
}
const digitsByCurrency = new Map<string, number>()
const formatters = new Map<string, Intl.NumberFormat>()
const separatorsByLocale = new Map<string, { decimal: string, group: string }>()

/** How many digits follow the decimal point: 2 for CAD, 0 for JPY, 3 for BHD. */
export function minorDigits(currency: string): number {
  return kept(digitsByCurrency, currency, () =>
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2)
}

/** The locale's decimal and grouping characters. */
function separators(locale?: string) {
  return kept(separatorsByLocale, locale ?? '', () => {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5)
    return {
      decimal: parts.find(p => p.type === 'decimal')?.value ?? '.',
      group: parts.find(p => p.type === 'group')?.value ?? ','
    }
  })
}

export type ParsedAmount = { ok: true, value: number } | { ok: false, message: string }

/**
 * Reads what a person typed as an amount, in minor units: `1,234.56`, `1234.5`, `-12`, `(12.00)`, `$1,000`,
 * `1 234,56` in a French locale. Blank is an error: callers decide what an empty field means. Digits are assembled as
 * text, so `0.1 + 0.2` problems can't happen; more decimals than the currency has is an error, not rounding.
 */
export function parseAmount(text: string, currency: string, locale?: string): ParsedAmount {
  const digits = minorDigits(currency)
  const { decimal, group } = separators(locale)

  let s = String(text ?? '').replace(/[\s\u00a0\u202f]/g, '')
  if (s === '') return { ok: false, message: 'Enter an amount.' }

  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-') || s.startsWith('−')) { negative = !negative; s = s.slice(1) }
  else if (s.startsWith('+')) s = s.slice(1)
  // A currency sign or code, before or after the number
  s = s.replace(/^[A-Za-z]{3}|[A-Za-z]{3}$/, '').replace(/^[$€£¥₹]|[$€£¥₹]$/, '')
  if (s.startsWith('-') && !negative) { negative = true; s = s.slice(1) }

  if (group !== ' ' && group !== '\u00a0' && group !== '\u202f') s = s.split(group).join('')
  const at = s.lastIndexOf(decimal)
  const whole = at === -1 ? s : s.slice(0, at)
  const fraction = at === -1 ? '' : s.slice(at + decimal.length)

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || (whole === '' && fraction === '')) {
    return { ok: false, message: 'Enter a number, like 1234.56.' }
  }
  if (fraction.length > digits) {
    return { ok: false, message: digits === 0 ? `${currency} amounts have no decimal places.` : `Use at most ${digits} decimal places.` }
  }

  const minor = Number((whole.replace(/^0+(?=\d)/, '') || '0') + fraction.padEnd(digits, '0'))
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT) return { ok: false, message: 'That amount is too large.' }
  return { ok: true, value: negative && minor !== 0 ? -minor : minor }
}

export interface FormatOptions {
  locale?: string
  /** Show the currency symbol. Default true. */
  currency?: boolean
  /**
   * 'auto' shows a minus for negative amounts (balances, the Money way); 'never' shows the magnitude (amounts in a
   * register's two columns). Default 'auto'.
   */
  sign?: 'auto' | 'never'
}

/** Minor units as text, for display: `-540.00`, `$1,234.56`, `¥1,200`. */
export function formatAmount(minor: number, currency: string, options: FormatOptions = {}): string {
  const digits = minorDigits(currency)
  const value = (options.sign === 'never' ? Math.abs(minor) : minor) / 10 ** digits
  const symbol = options.currency !== false
  const formatter = kept(formatters, `${options.locale ?? ''}|${currency}|${symbol ? '$' : ''}`, () => new Intl.NumberFormat(options.locale, {
    ...(symbol ? { style: 'currency', currency } : {}),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }))
  return formatter.format(value)
}

/** Minor units as text a person can edit and `parseAmount` reads back: no grouping, no symbol. */
export function amountToInput(minor: number, currency: string, locale?: string): string {
  const digits = minorDigits(currency)
  const sign = minor < 0 ? '-' : ''
  const text = String(Math.abs(minor)).padStart(digits + 1, '0')
  if (digits === 0) return sign + text
  return `${sign}${text.slice(0, -digits)}${separators(locale).decimal}${text.slice(-digits)}`
}
