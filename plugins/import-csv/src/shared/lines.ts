// Rows and a layout → statements: what will be imported, and which rows are left out and why. The CSV Columns
// dialog's preview runs this same code, so what it shows is what is imported.
// See docs/import-formats-design.md, "From rows to statements".
import type { StatementLine } from '@tessera/import-api'
import { amountIn, dateIn, magnitude, negate, same, signOf, subtract } from './cells'
import { isBlank } from './csv'
import type { CsvLayout } from './layout'

/** Why a row isn't a line. `quiet` rows (blank, or with no amount: a balance forward or totals row) aren't warned about. */
export interface LeftOut {
  /** The row's index in the file's rows, from 0. */
  row: number
  reason: string
  quiet: boolean
  pending?: boolean
}

/** A row that is a line. */
export interface RowLine {
  row: number
  line: StatementLine
  /** The account column's value, when the layout has one. */
  account?: string
  currency?: string
  /** The balance column's value, canonical as written, when there is one. */
  balance?: string
}

/** One statement's worth of lines: all of them, or one account's. */
export interface CsvStatement {
  /** The account column's value, or undefined without one. */
  account?: string
  lines: RowLine[]
  /** Every row agrees on it. */
  currency?: string
  /** More than one currency: the statement can't be imported. */
  currencies?: string[]
  /** The chronologically last row's balance, signed the Tessera way, and its date. */
  balance?: { amount: string, asOf: string }
  /** The rows' order, worked out from their dates (and the balances when the dates don't say). */
  order: 'oldestFirst' | 'newestFirst'
  /** Bank ids repeat within the file, so they can't be trusted. */
  repeatedIds: boolean
}

export interface ReadResult {
  statements: CsvStatement[]
  leftOut: LeftOut[]
  /** The first row of data: after the skipped rows and the header. */
  firstRow: number
}

/** Words of a totals or balance row, which has amounts but no date. */
const SUMMARY = /^(?:sub-?totals?|totals?|grand total|sous-total|balance forward|opening balance|closing balance|previous balance|beginning balance|ending balance|solde (?:d'ouverture|de cl[oô]ture|report[eé]|pr[eé]c[eé]dent|initial|final))\b/i

/** A row's cell, '' when the row is short. */
const cell = (values: readonly string[], column: number | undefined) => column === undefined ? '' : (values[column] ?? '').trim()

/** What a row's amount is, as the layout reads it. */
export type RowAmount = { kind: 'amount', amount: string } | { kind: 'none' } | { kind: 'error', reason: string }

/** A row's amount: signed the Tessera way, with `reversed` applied. */
export function rowAmount(values: readonly string[], layout: CsvLayout): RowAmount {
  const c = layout.columns
  const read = (column: number | undefined) => {
    const text = cell(values, column)
    return { text, amount: text === '' ? undefined : amountIn(text, layout.decimal) }
  }
  let amount: string
  if (c.amount !== undefined) {
    const a = read(c.amount)
    if (a.text === '') return { kind: 'none' }
    if (!a.amount) return { kind: 'error', reason: `“${a.text}” isn't an amount` }
    amount = a.amount.amount
    if (c.direction) {
      const word = cell(values, c.direction.column).toUpperCase()
      const debit = c.direction.debit.some(w => w.trim().toUpperCase() === word)
      const credit = c.direction.credit.some(w => w.trim().toUpperCase() === word)
      if (debit === credit) return { kind: 'error', reason: `“${cell(values, c.direction.column)}” doesn't say debit or credit` }
      amount = debit ? negate(magnitude(amount)) : magnitude(amount)
    }
  } else if (c.debit !== undefined || c.credit !== undefined) {
    const out = read(c.debit)
    const into = read(c.credit)
    if (out.text === '' && into.text === '') return { kind: 'none' }
    if (out.text !== '' && !out.amount) return { kind: 'error', reason: `“${out.text}” isn't an amount` }
    if (into.text !== '' && !into.amount) return { kind: 'error', reason: `“${into.text}” isn't an amount` }
    amount = subtract(magnitude(into.amount?.amount ?? '0'), magnitude(out.amount?.amount ?? '0'))
  } else {
    return { kind: 'none' }
  }
  return { kind: 'amount', amount: layout.reversed ? negate(amount) : amount }
}

/** A short description of a row for a reason: its first non-empty cells. */
const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`

/**
 * The order rows are in, from their dates: oldest first unless the dates mostly fall. Undefined when they don't say
 * (every row on one day).
 */
export function orderOf(dates: readonly string[]): 'oldestFirst' | 'newestFirst' | undefined {
  let rising = 0
  let falling = 0
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > dates[i - 1]) rising++
    else if (dates[i] < dates[i - 1]) falling++
  }
  return rising === 0 && falling === 0 ? undefined : falling > rising ? 'newestFirst' : 'oldestFirst'
}

/**
 * How a running balance follows the amounts, rows in file order: for each pair of neighbouring rows, whether the
 * balance changed by the later row's amount (oldest first) or by the earlier row's, the other way (newest first); and
 * whether it rose with the amounts (`sign` 1) or against them (-1, a card's balance owed rising with charges written
 * as negatives). `fit` is the share of pairs that agree with the best reading; undefined with fewer than one pair.
 */
export function balanceFit(amounts: readonly (string | undefined)[], balances: readonly (string | undefined)[]):
  { order: 'oldestFirst' | 'newestFirst', sign: 1 | -1, fit: number, pairs: number } | undefined {
  const tally = { oldestFirst: { 1: 0, [-1]: 0 }, newestFirst: { 1: 0, [-1]: 0 } } as Record<'oldestFirst' | 'newestFirst', Record<1 | -1, number>>
  let pairs = 0
  for (let i = 1; i < balances.length; i++) {
    const before = balances[i - 1]
    const after = balances[i]
    if (before === undefined || after === undefined) continue
    const change = subtract(after, before)
    pairs++
    const later = amounts[i]
    const earlier = amounts[i - 1]
    if (later !== undefined && same(change, later)) tally.oldestFirst[1]++
    if (later !== undefined && same(change, negate(later))) tally.oldestFirst[-1]++
    if (earlier !== undefined && same(negate(change), earlier)) tally.newestFirst[1]++
    if (earlier !== undefined && same(change, earlier)) tally.newestFirst[-1]++
  }
  if (pairs === 0) return undefined
  let best: { order: 'oldestFirst' | 'newestFirst', sign: 1 | -1, count: number } = { order: 'oldestFirst', sign: 1, count: -1 }
  for (const order of ['oldestFirst', 'newestFirst'] as const) {
    for (const sign of [1, -1] as const) if (tally[order][sign] > best.count) best = { order, sign, count: tally[order][sign] }
  }
  return { order: best.order, sign: best.sign, fit: best.count / pairs, pairs }
}

/** The rows of a file as the layout reads them. `pivot` reads two-digit years. */
export function readLines(rows: readonly (readonly string[])[], layout: CsvLayout, pivot: number): ReadResult {
  const c = layout.columns
  const firstRow = Math.max(0, layout.skip) + (layout.header ? 1 : 0)
  const leftOut: LeftOut[] = []
  const lines: RowLine[] = []
  const pendingWords = c.status?.pending.map(w => w.trim().toLowerCase()) ?? []

  for (let row = firstRow; row < rows.length; row++) {
    const values = rows[row]
    if (isBlank(values)) { leftOut.push({ row, reason: 'It is blank.', quiet: true }); continue }
    if (c.status && pendingWords.includes(cell(values, c.status.column).toLowerCase())) {
      leftOut.push({ row, reason: 'It is pending: it will come with a later export, once the bank posts it.', quiet: false, pending: true })
      continue
    }
    const amount = rowAmount(values, layout)
    const dateText = cell(values, c.date)
    const date = dateText === '' ? undefined : dateIn(dateText, layout.dateOrder, pivot)
    if (amount.kind === 'none') {
      leftOut.push({ row, reason: 'It has no amount: a balance forward or totals row.', quiet: true })
      continue
    }
    if (!date && dateText === '' && values.some(v => SUMMARY.test(v.trim()))) {
      leftOut.push({ row, reason: 'It is a totals or balance row.', quiet: true })
      continue
    }
    if (!date) {
      const first = values.find(v => v.trim() !== '') ?? ''
      leftOut.push({ row, reason: dateText === '' ? `${quote(first)}: it has no date.` : `${quote(dateText)} isn't a date.`, quiet: false })
      continue
    }
    if (amount.kind === 'error') { leftOut.push({ row, reason: `${amount.reason}.`, quiet: false }); continue }

    const line: StatementLine = { date, amount: amount.amount }
    const userDateText = cell(values, c.userDate)
    const userDate = userDateText === '' ? undefined : dateIn(userDateText, layout.dateOrder, pivot)
    if (userDate && userDate !== date) line.userDate = userDate
    const payee = cell(values, c.payee)
    if (payee !== '') line.payee = payee
    const memo = (c.memo ?? []).map(m => cell(values, m)).filter(m => m !== '' && m !== payee).join(' · ')
    if (memo !== '') line.memo = memo
    const number = cell(values, c.number)
    if (number !== '') line.number = number
    const category = cell(values, c.category)
    if (category !== '') line.category = category
    const id = cell(values, c.id)
    if (id !== '') line.externalId = id
    const balanceText = cell(values, c.balance)
    const balance = balanceText === '' ? undefined : amountIn(balanceText, layout.decimal)?.amount
    lines.push({
      row, line,
      ...(c.account !== undefined && { account: cell(values, c.account).replace(/\s+/g, '') }),
      ...(c.currency !== undefined && cell(values, c.currency) !== '' && { currency: cell(values, c.currency).toUpperCase() }),
      ...(balance !== undefined && { balance })
    })
  }

  // One statement, or one per account
  const groups = new Map<string | undefined, RowLine[]>()
  for (const line of lines) {
    const key = c.account !== undefined ? line.account ?? '' : undefined
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  const statements = [...groups.entries()].map(([account, group]) => statementOf(account, group))
  return { statements, leftOut, firstRow }
}

function statementOf(account: string | undefined, lines: RowLine[]): CsvStatement {
  const currencies = [...new Set(lines.map(l => l.currency).filter((x): x is string => x !== undefined))]
  const withBalance = lines.filter(l => l.balance !== undefined)
  const fit = balanceFit(lines.map(l => l.line.amount), lines.map(l => l.balance))
  const order = orderOf(lines.map(l => l.line.date)) ?? (fit && fit.fit >= 0.5 ? fit.order : 'oldestFirst')
  let balance: CsvStatement['balance']
  if (withBalance.length > 0) {
    // The chronologically last row with a balance: the latest date; on that day, the last row in the rows' order
    const latest = withBalance.reduce((a, b) => b.line.date > a.line.date ? b : a).line.date
    const onThatDay = withBalance.filter(l => l.line.date === latest)
    const last = order === 'oldestFirst' ? onThatDay[onThatDay.length - 1] : onThatDay[0]
    const sign = fit && fit.fit >= 0.5 ? fit.sign : senseOf(withBalance, order)
    balance = { amount: sign === 1 ? last.balance! : negate(last.balance!), asOf: latest }
  }
  const ids = lines.map(l => l.line.externalId).filter((x): x is string => x !== undefined)
  return {
    ...(account !== undefined && { account }),
    lines,
    ...(currencies.length === 1 && { currency: currencies[0] }),
    ...(currencies.length > 1 && { currencies }),
    ...(balance && { balance }),
    order,
    repeatedIds: new Set(ids).size !== ids.length
  }
}

/** Whether a balance rises with the amounts (1) or against them (-1), from the rows that have one, in order. */
function senseOf(lines: RowLine[], order: 'oldestFirst' | 'newestFirst'): 1 | -1 {
  const chronological = order === 'oldestFirst' ? lines : [...lines].reverse()
  let with_ = 0
  let against = 0
  for (let i = 1; i < chronological.length; i++) {
    const change = signOf(subtract(chronological[i].balance!, chronological[i - 1].balance!))
    const amount = signOf(chronological[i].line.amount)
    if (change === 0 || amount === 0) continue
    if (change === amount) with_++
    else against++
  }
  return against > with_ ? -1 : 1
}
