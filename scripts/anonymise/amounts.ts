// Amounts changed, in the file's own style. Each distinct amount is scaled by a factor between 0.8 and 1.25, chosen
// once for that amount (so equal amounts stay equal, and a transfer's two sides still mirror each other), rounded to
// the original's decimals, and written as the original was: its sign, grouping, decimal separator, parentheses and
// currency sign. Balances are then worked out again from the changed lines (see the format handlers), so a file still
// adds up. Everything is done in whole units of the smallest decimal, never in floating point money.
import { canonicalDecimal, type DecimalSeparator } from '@tessera/import-api'
import type { Random } from './random'

/** The scale all sums are done at: millionths, more decimals than any statement writes. */
export const SCALE = 6

/** An amount as written: what surrounds the number, the number's style, and its value. */
export interface WrittenAmount {
  /** Everything before the number ('-', '$', '(', 'CAD '). */
  prefix: string
  /** Everything after it ('-', ')', ' CR'). */
  suffix: string
  decimal: DecimalSeparator
  /** The grouping character used, if any. */
  group?: string
  /** How many decimals are written. */
  decimals: number
  /** The value, signed, at `SCALE`. */
  value: number
}

/** A canonical decimal ('-84.12') at `SCALE`: -84120000. */
export function atScale(canonical: string): number {
  const negative = canonical.startsWith('-')
  const [whole, fraction = ''] = canonical.replace(/^-/, '').split('.')
  const digits = Number(whole) * 10 ** SCALE + Number((fraction + '0'.repeat(SCALE)).slice(0, SCALE))
  return negative ? -digits : digits
}

/**
 * Reads how an amount is written, or undefined when it isn't one. `decimal` is the file's separator when known;
 * otherwise '.' is tried first, then ','.
 */
export function readAmount(text: string, decimal?: DecimalSeparator): WrittenAmount | undefined {
  const core = /\d(?:[\d.,'\s\u00a0\u202f]*\d)?/.exec(text)
  if (!core) return undefined
  const separators: DecimalSeparator[] = decimal ? [decimal] : ['.', ',']
  for (const sep of separators) {
    const canonical = canonicalDecimal(text, { decimal: sep })
    if (canonical === undefined) continue
    const number = core[0]
    const at = number.lastIndexOf(sep)
    const decimals = at === -1 ? 0 : number.length - at - 1
    const wholePart = at === -1 ? number : number.slice(0, at)
    const group = /[^\d]/.exec(wholePart)?.[0]
    return {
      prefix: text.slice(0, core.index), suffix: text.slice(core.index + number.length),
      decimal: sep, ...(group !== undefined && { group }), decimals, value: atScale(canonical)
    }
  }
  return undefined
}

/** A magnitude at `SCALE` written with `decimals` decimals, grouped as given: 123456780000, 2, ',' → '123,456.78'. */
export function formatNumber(magnitude: number, decimals: number, decimal: DecimalSeparator, group?: string): string {
  const units = Math.round(Math.abs(magnitude) / 10 ** (SCALE - decimals))
  const digits = String(units).padStart(decimals + 1, '0')
  let whole = decimals === 0 ? digits : digits.slice(0, -decimals)
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return decimals === 0 ? whole : `${whole}${decimal}${digits.slice(-decimals)}`
}

/** `written` with another value of the same sign: the number replaced, its surroundings (and so its sign) kept. */
export function rewrite(written: WrittenAmount, value: number): string {
  return `${written.prefix}${formatNumber(value, written.decimals, written.decimal, written.group)}${written.suffix}`
}

/**
 * A value of either sign, in the style of `like` but with its own sign: '-' before the number, as OFX writes them.
 * For balances, which may change sign once their lines have changed.
 */
export function writeSigned(value: number, like: WrittenAmount): string {
  const prefix = like.prefix.replace(/[-−+]/g, '')
  const suffix = like.suffix.replace(/[-−]/g, '')
  return `${value < 0 ? '-' : ''}${prefix}${formatNumber(value, like.decimals, like.decimal, like.group)}${suffix}`
}

/** The run's factors, one per distinct magnitude. Holds the originals' magnitudes: never commit it. */
export type Factors = Record<string, number>

export class Amounts {
  constructor(private readonly random: Random, readonly factors: Factors = {}, private readonly keep = false) {}

  /**
   * A magnitude changed by the factor its original has in this run, at `decimals` decimals: never zero unless it was
   * zero, and the same for the same original every time.
   */
  change(value: number, decimals: number): number {
    if (this.keep || value === 0) return value
    const magnitude = Math.abs(value)
    const key = String(magnitude)
    let factor = this.factors[key]
    if (factor === undefined) {
      factor = Math.round((0.8 + this.random.next() * 0.45) * 1e6) / 1e6
      this.factors[key] = factor
    }
    const unit = 10 ** (SCALE - decimals)
    const changed = Math.max(1, Math.round(magnitude * factor / unit)) * unit
    return value < 0 ? -changed : changed
  }
}
