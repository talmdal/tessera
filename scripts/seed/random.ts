// A small deterministic random source, so the same seed always builds the same book. Nothing here is
// cryptographic; it only has to be stable across runs and platforms, which `Math.random` is not.

/** mulberry32: 32 bits of state, good enough for plausible-looking money. */
export function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    /** A whole number in [min, max]. */
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    /** An amount in minor units between two major-unit bounds, to the cent. */
    money: (minMajor: number, maxMajor: number) => Math.round((minMajor + next() * (maxMajor - minMajor)) * 100),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    /** True with probability `chance`. */
    chance: (chance: number) => next() < chance
  }
}

export type Random = ReturnType<typeof random>

// ---- Dates ------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

export const iso = (date: Date): string => date.toISOString().slice(0, 10)

export const parse = (date: string): Date => new Date(`${date}T00:00:00Z`)

export const addDays = (date: string, days: number): string => iso(new Date(parse(date).getTime() + days * DAY_MS))

/** Every date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  for (let at = from; at <= to; at = addDays(at, 1)) dates.push(at)
  return dates
}

/** 0 = Sunday … 6 = Saturday, in UTC so it never depends on where the script runs. */
export const weekday = (date: string): number => parse(date).getUTCDay()

export const dayOfMonth = (date: string): number => Number(date.slice(8, 10))

export const monthOf = (date: string): string => date.slice(0, 7)

export const yearOf = (date: string): number => Number(date.slice(0, 4))

/** The last day of the month a date falls in. */
export function endOfMonth(date: string): string {
  const at = parse(date)
  return iso(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)))
}

/** The given day of the month, clamped to the last day in short months (so the 31st works in February). */
export function dayIn(month: string, day: number): string {
  const last = Number(endOfMonth(`${month}-01`).slice(8, 10))
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** Every month from `from` to `to`, inclusive, as YYYY-MM. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = []
  let [year, month] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]
  const [lastYear, lastMonth] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))]
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return months
}

/** Moves a date off Saturday and Sunday, as a bank's posting does: forward to the Monday. */
export function onBusinessDay(date: string): string {
  const day = weekday(date)
  if (day === 6) return addDays(date, 2)
  if (day === 0) return addDays(date, 1)
  return date
}
