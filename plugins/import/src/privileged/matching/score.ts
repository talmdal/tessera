// How alike a bank line and a transaction the user entered are: a score from 0 to 1 for each of the date, the amount
// and the payee, combined, and whether the pair is good enough to propose. Pure: no storage, no services. Every number
// is in tuning.ts. See docs/import-manager-design.md, "Scores".
import { formatAmount, minorDigits } from '@tessera/accounts-api'
import {
  AMOUNT_SCORES, CHEQUE_BONUS, CHEQUE_DATE_SCORE, DATE_SCORES, PAYEES_AGREE_AT, PAYEE_DIFFERS_BELOW, PROPOSE_AT, WEIGHTS, WINDOW
} from './tuning'
import { normalizePayee, normalizedSimilarity } from './payees'

/** A bank line, as matching sees it. Amounts are minor units, signed. */
export interface MatchLine {
  date: string
  userDate?: string
  amount: number
  payee?: string
  number?: string
}

/** A transaction the user entered, as matching sees it. */
export interface MatchTarget {
  id: string
  date: string
  amount: number
  payeeName?: string
  number?: string
}

/** Days since 1970 of a YYYY-MM-DD date. */
export function dayNumber(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000
}

/**
 * A line with what matching works out once, rather than for every pair: its normalised payee, the payee a saved alias
 * gives it, and its dates as day numbers.
 */
export interface PreparedLine {
  line: MatchLine
  payee: string
  /** The payee name (lower case) a saved payee alias maps the bank's text to. */
  alias?: string
  /** The posting date's day number, then the user's date's, if any. */
  days: number[]
}

export interface PreparedTarget {
  target: MatchTarget
  payee: string
  /** The payee name in lower case, for comparing with an alias. */
  name?: string
  day: number
}

/** A payee alias lookup: the bank's normalised text → the user's payee name. */
export type AliasMap = ReadonlyMap<string, string>

/** How alike two normalised payee names are. The matcher passes a remembering one: a statement repeats its payees. */
export type Similarity = (a: string, b: string) => number

export function prepareLine(line: MatchLine, aliases: AliasMap = new Map()): PreparedLine {
  const payee = line.payee ? normalizePayee(line.payee) : ''
  const alias = payee !== '' ? aliases.get(payee) : undefined
  return {
    line, payee, ...(alias !== undefined && { alias: alias.toLowerCase() }),
    days: line.userDate !== undefined ? [dayNumber(line.date), dayNumber(line.userDate)] : [dayNumber(line.date)]
  }
}

export function prepareTarget(target: MatchTarget): PreparedTarget {
  return {
    target, payee: target.payeeName ? normalizePayee(target.payeeName) : '',
    ...(target.payeeName && { name: target.payeeName.trim().toLowerCase() }),
    day: dayNumber(target.date)
  }
}

/** A `Similarity` that works each pair of names out once. */
export function rememberingSimilarity(): Similarity {
  const known = new Map<string, Map<string, number>>()
  return (a, b) => {
    let row = known.get(a)
    if (!row) { row = new Map(); known.set(a, row) }
    let value = row.get(b)
    if (value === undefined) { value = normalizedSimilarity(a, b); row.set(b, value) }
    return value
  }
}

/** A YYYY-MM-DD date `days` after `date` (before, when negative). */
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10)
}

/** The cheque number's digits, so '000104' and '104' are the same cheque. */
const chequeNumber = (number: string | undefined) => number?.trim().replace(/^0+(?=\d)/, '') || undefined

/** The line's cheque number equals the transaction's. */
export function chequeMatches(line: Pick<MatchLine, 'number'>, target: Pick<MatchTarget, 'number'>): boolean {
  const a = chequeNumber(line.number)
  return a !== undefined && a === chequeNumber(target.number)
}

/** `D` for `days` (the line's date minus the transaction's), or undefined when that is outside the window. */
export function dateScore(days: number, cheque: boolean): number | undefined {
  const score = DATE_SCORES.find(row => days >= row.from && days <= row.to)?.score
  if (cheque && days >= 4 && days <= WINDOW.chequeBefore) return Math.max(score ?? 0, CHEQUE_DATE_SCORE)
  return score
}

/** The better `D` of the line's posting date and the date the user made it, with its days. */
export function bestDate(line: Pick<MatchLine, 'date' | 'userDate'>, targetDate: string, cheque: boolean): { score: number, days: number } | undefined {
  const days = line.userDate !== undefined ? [dayNumber(line.date), dayNumber(line.userDate)] : [dayNumber(line.date)]
  return bestOf(days, dayNumber(targetDate), cheque)
}

function bestOf(lineDays: number[], targetDay: number, cheque: boolean): { score: number, days: number } | undefined {
  let best: { score: number, days: number } | undefined
  for (const day of lineDays) {
    const days = day - targetDay
    const score = dateScore(days, cheque)
    if (score !== undefined && (!best || score > best.score || (score === best.score && Math.abs(days) < Math.abs(best.days)))) best = { score, days }
  }
  return best
}

/** One major unit (a dollar) in minor units, by currency: asking Intl each time would be most of matching's time. */
const majorUnits = new Map<string, number>()
function majorUnit(currency: string): number {
  let unit = majorUnits.get(currency)
  if (unit === undefined) { unit = 10 ** minorDigits(currency); majorUnits.set(currency, unit) }
  return unit
}

/** `A`, or undefined when the signs differ (money in can't be money out) or the amounts are too far apart. */
export function amountScore(line: number, target: number, currency: string): number | undefined {
  if (line === 0 || Math.sign(line) !== Math.sign(target)) return undefined
  const delta = Math.abs(line - target)
  if (delta === 0) return AMOUNT_SCORES.exact
  const ratio = delta / Math.abs(line)
  const { close, near, far } = AMOUNT_SCORES
  if (ratio <= close.ratio || delta <= close.majorUnits * majorUnit(currency)) return close.score
  if (ratio <= near.ratio) return near.score
  if (ratio <= far.ratio) return far.score
  return undefined
}

/** `P`: 1 when a saved alias names the transaction's payee; else the names' similarity. Undefined without both. */
export function payeeScore(line: PreparedLine, target: PreparedTarget, similarity: Similarity = normalizedSimilarity): number | undefined {
  if (line.payee === '' || target.payee === '') return undefined
  if (line.alias !== undefined && line.alias === target.name) return 1
  return similarity(line.payee, target.payee)
}

export interface PairScore {
  /** 0 to 1, rounded to 6 places so equal pairs compare equal. */
  score: number
  amount: number
  date: number
  payee?: number
  /** The line's date (or the user's date, if that scored better) minus the transaction's. */
  days: number
  cheque: boolean
  /** Good enough to propose: the score is high enough, and the amount is exact or the payees agree. */
  proposed: boolean
}

/** How alike a line and a transaction are, or undefined when the transaction isn't a candidate at all. */
export function scorePair(line: PreparedLine, target: PreparedTarget, currency: string, similarity?: Similarity): PairScore | undefined {
  const amount = amountScore(line.line.amount, target.target.amount, currency)
  if (amount === undefined) return undefined
  const cheque = chequeMatches(line.line, target.target)
  const date = bestOf(line.days, target.day, cheque)
  if (date === undefined) return undefined
  const payee = payeeScore(line, target, similarity)
  let score = payee === undefined
    ? WEIGHTS.withoutPayee.amount * amount + WEIGHTS.withoutPayee.date * date.score
    : WEIGHTS.withPayee.amount * amount + WEIGHTS.withPayee.date * date.score + WEIGHTS.withPayee.payee * payee
  if (cheque) score = Math.min(1, score + CHEQUE_BONUS)
  score = Math.round(score * 1e6) / 1e6
  const proposed = score >= PROPOSE_AT && (amount === AMOUNT_SCORES.exact || (payee !== undefined && payee >= PAYEES_AGREE_AT))
  return { score, amount, date: date.score, ...(payee !== undefined && { payee }), days: date.days, cheque, proposed }
}

/** A pair's score for the Change Match dialog, which lists transactions outside the window too: 0 for those. */
export function looseScore(line: PreparedLine, target: PreparedTarget, currency: string): number {
  return scorePair(line, target, currency)?.score ?? 0
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What differs between the transaction and the bank line, in words, from the transaction's side:
 * ['1 day earlier', '0.12 less', 'payee', 'number'].
 */
export function differences(line: PreparedLine, target: PreparedTarget, currency: string): string[] {
  const words: string[] = []
  const days = dayNumber(line.line.date) - dayNumber(target.target.date)
  if (days > 0) words.push(`${plural(days, 'day', 'days')} earlier`)
  if (days < 0) words.push(`${plural(-days, 'day', 'days')} later`)
  const delta = Math.abs(target.target.amount) - Math.abs(line.line.amount)
  if (Math.sign(target.target.amount) !== Math.sign(line.line.amount)) words.push('the other way')
  else if (delta !== 0) words.push(`${formatAmount(Math.abs(delta), currency, { currency: false })} ${delta < 0 ? 'less' : 'more'}`)
  const payee = payeeScore(line, target)
  if (payee !== undefined && payee < PAYEE_DIFFERS_BELOW) words.push('payee')
  const a = chequeNumber(line.line.number)
  const b = chequeNumber(target.target.number)
  if (a !== undefined && b !== undefined && a !== b) words.push('number')
  return words
}
