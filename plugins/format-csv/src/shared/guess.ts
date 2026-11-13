// Guessing a CSV file's layout from its rows, in two passes: the header's names (dictionary.ts), then the data, which
// checks every name and fills in the columns without one. Each choice is either sure or a guess with a reason, and
// the CSV Columns dialog highlights the guesses. Pure: the anonymiser uses it too, to know which cells are payees.
// See docs/import-formats-design.md, "Guessing the layout".
import { guessDateOrder, type DateOrder, type DecimalSeparator } from '@tessera/import-api'
import { amountIn, dateIn, isAmountCell, isDateCell, signOf } from './cells'
import { isBlank, type Delimiter } from './csv'
import { CURRENCIES, directionWords, isDirection, isPending, pendingWords, roleNamed } from './dictionary'
import type { CsvColumns, CsvLayout, Role } from './layout'
import { balanceFit, rowAmount } from './lines'

/** A choice the guess isn't sure of, and why. */
export interface Uncertain {
  field: 'start' | 'dateOrder' | 'decimal' | 'reversed' | 'column'
  /** For 'column': which. */
  column?: number
  why: string
}

/** What a column holds in the first rows of data, for a headerless file's signature. */
export type Shape = 'date' | 'number' | 'text' | 'empty'

export interface LayoutGuess {
  layout: CsvLayout
  uncertain: Uncertain[]
  /** How many columns the data rows have: the dialog shows this many. */
  width: number
  /** The header's cells, when there is one. */
  header?: string[]
  /** Each column's shape in the first rows of data. */
  shapes: Shape[]
}

export interface GuessOptions {
  delimiter: Delimiter
  /** For two-digit years. */
  pivot: number
}

/** The rows looked at: enough to see a file's habits, few enough to stay quick on a long export. */
const SAMPLE_ROWS = 1000

type Kind = 'empty' | 'date' | 'number' | 'text'

interface Column {
  index: number
  values: string[]
  filled: number
  dates: number
  numbers: number
  texts: number
  distinct: number
  integers: boolean
  maxDigits: number
}

const kindOf = (value: string, pivot: number): Kind => {
  const v = value.trim()
  if (v === '') return 'empty'
  if (isDateCell(v, pivot)) return 'date'
  return isAmountCell(v) ? 'number' : 'text'
}

/** The most common value, ties to the larger. */
function mode(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | undefined
  for (const [v, n] of counts) if (best === undefined || n > counts.get(best)! || (n === counts.get(best)! && v > best)) best = v
  return best
}

/** Account numbers as files show them: digits, perhaps masked ('XXXX5678', '4500********1234'), dashes and spaces. */
const ACCOUNT = /^(?=(?:.*\d){3})[\dXx*•#\- ]{4,}$/

function columnOf(index: number, values: string[], pivot: number): Column {
  const filledValues = values.map(v => v.trim()).filter(v => v !== '')
  const kinds = filledValues.map(v => kindOf(v, pivot))
  const numbers = filledValues.filter((_, i) => kinds[i] === 'number')
  return {
    index, values,
    filled: filledValues.length,
    dates: kinds.filter(k => k === 'date').length,
    numbers: numbers.length,
    texts: kinds.filter(k => k === 'text').length,
    distinct: new Set(filledValues).size,
    integers: numbers.every(v => /^[-+(]?\$?\d+\)?-?$/.test(v)),
    maxDigits: Math.max(0, ...numbers.map(v => v.replace(/\D/g, '').length))
  }
}

/**
 * Nearly all of a column: 90%, or all but two cells (a totals row, a balance forward) in a short file, as long as that
 * is still most of it.
 */
const mostly = (count: number, of: number) => of > 0 && (count >= 0.9 * of || (count >= of - 2 && count >= 0.6 * of))
const isDates = (c: Column) => c.filled > 0 && mostly(c.dates, c.filled)
const isNumbers = (c: Column) => c.filled > 0 && mostly(c.numbers, c.filled)
/** A number column that is an amount, not an account number, a constant or a cheque number's count. */
const isAmounts = (c: Column) => isNumbers(c) && !(c.integers && (c.maxDigits >= 6 || (c.distinct <= 1 && c.filled > 2)))
const isText = (c: Column) => c.filled > 0 && c.texts >= 0.5 * c.filled
const isAccount = (c: Column) => c.filled > 0 && c.values.every(v => v.trim() === '' || ACCOUNT.test(v.trim())) && c.distinct <= 3 &&
  (c.values.some(v => /[Xx*•#]/.test(v)) || c.maxDigits >= 6 || c.values.some(v => v.replace(/\D/g, '').length >= 6))

/** A layout that reads nothing, for a file with no recognisable rows. */
const EMPTY = (delimiter: Delimiter): CsvLayout => ({ version: 1, delimiter, skip: 0, header: false, columns: {}, dateOrder: 'YMD', decimal: '.', reversed: false })

/** The layout a file's rows most likely have, with what is a guess. */
export function guessLayout(allRows: readonly (readonly string[])[], options: GuessOptions): LayoutGuess {
  const { delimiter, pivot } = options
  const rows = allRows.slice(0, SAMPLE_ROWS)
  const uncertain: Uncertain[] = []
  const kinds = rows.map(r => r.map(v => kindOf(v, pivot)))

  // Rows of data: a date and a number. Their usual width is the file's
  const dataLike = rows.map((_, i) => kinds[i].includes('date') && kinds[i].includes('number'))
  const width = mode(rows.filter((_, i) => dataLike[i]).map(r => r.length)) ?? mode(rows.filter(r => !isBlank(r)).map(r => r.length)) ?? 0
  const first = rows.findIndex((r, i) => dataLike[i] && Math.abs(r.length - width) <= 1)
  if (first === -1) {
    const start = Math.max(0, rows.findIndex(r => !isBlank(r)))
    return { layout: { ...EMPTY(delimiter), skip: start }, uncertain: [{ field: 'start', why: 'No row has both a date and an amount.' }], width, shapes: [] }
  }

  // The header: the nearest row above the first row of data that is all words, past blank lines and rows without a
  // date (a balance forward), a few rows up at most
  const wordsOnly = (i: number) => Math.abs(rows[i].length - width) <= 1 &&
    kinds[i].every(k => k === 'text' || k === 'empty') && kinds[i].filter(k => k === 'text').length >= Math.min(2, width)
  let headerRow = -1
  for (let i = first - 1; i >= Math.max(0, first - 4); i--) {
    if (isBlank(rows[i])) continue
    if (wordsOnly(i)) { headerRow = i; break }
    if (kinds[i].includes('date')) break
  }
  const hasHeader = headerRow !== -1
  const skip = hasHeader ? headerRow : first
  const header = hasHeader ? Array.from({ length: width }, (_, i) => (rows[headerRow][i] ?? '').trim()) : undefined
  const preamble = rows.slice(0, skip).some(r => !isBlank(r))

  const data = rows.slice(first).filter(r => !isBlank(r))
  const columns = Array.from({ length: width }, (_, i) => columnOf(i, data.map(r => r[i] ?? ''), pivot))
  const shapes: Shape[] = columns.map(c => {
    const firstValues = c.values.slice(0, 20).map(v => v.trim()).filter(v => v !== '')
    if (firstValues.length === 0) return 'empty'
    const k = firstValues.map(v => kindOf(v, pivot))
    return k.every(x => x === 'date') ? 'date' : k.every(x => x === 'number') ? 'number' : 'text'
  })

  // First pass: the header's names, each checked against its column's data
  const roles: (Role | undefined)[] = columns.map(c => {
    if (!header) return undefined
    const role = roleNamed(header[c.index], c.values)
    if (role === 'date' || role === 'userDate') return isDates(c) ? role : undefined
    if (role === 'amount' || role === 'debit' || role === 'credit' || role === 'balance') return c.filled === 0 || isNumbers(c) ? role : undefined
    if (role === 'account') return isAccount(c) || (c.filled > 0 && c.values.every(v => v.trim() === '' || ACCOUNT.test(v.trim()))) ? role : undefined
    return role
  })
  const recognised = roles.some(r => r !== undefined)
  const named = (role: Role) => roles.map((r, i) => r === role ? i : -1).filter(i => i !== -1)

  // One column per role (memo apart): the fullest amount column (a file's 'CAD$' beside an empty 'USD$'); extra
  // payees become memos; a transaction date alone is the date
  const fullest = (indexes: number[]) => indexes.reduce((a, b) => columns[b].filled > columns[a].filled ? b : a)
  const amounts = named('amount')
  if (amounts.length > 1) { const keep = fullest(amounts); for (const i of amounts) if (i !== keep) roles[i] = undefined }
  const payees = named('payee')
  for (const i of payees.slice(1)) roles[i] = 'memo'
  if (named('date').length === 0 && named('userDate').length > 0) roles[named('userDate')[0]] = 'date'
  for (const role of ['date', 'userDate', 'debit', 'credit', 'balance', 'number', 'id', 'status', 'currency', 'account', 'category', 'direction'] as Role[]) {
    for (const i of named(role).slice(1)) roles[i] = undefined
  }
  if (named('amount').length > 0) { for (const i of [...named('debit'), ...named('credit')]) roles[i] = undefined }
  if (named('amount').length === 0 && (named('debit').length === 0) !== (named('credit').length === 0)) {
    for (const i of [...named('debit'), ...named('credit')]) roles[i] = undefined
  }
  const free = (c: Column) => roles[c.index] === undefined
  const guessed = (column: number, why: string) => uncertain.push({ field: 'column', column, why })

  // Second pass: the data. Dates first
  if (named('date').length === 0) {
    const candidates = columns.filter(c => free(c) && isDates(c))
    if (candidates.length > 0) {
      roles[candidates[0].index] = 'date'
      if (header) guessed(candidates[0].index, 'Its name isn’t one Tessera knows, but it holds dates.')
    }
  }
  const dateOrder = guessOrder(columns, roles, pivot, uncertain)
  // A second date column: the later of the two is when the bank posted it
  if (named('userDate').length === 0) {
    const second = columns.find(c => free(c) && isDates(c))
    const date = named('date')[0]
    if (second && date !== undefined) {
      const pairs = columns[date].values.map((v, i) => [dateIn(v, dateOrder, pivot), dateIn(second.values[i], dateOrder, pivot)])
        .filter(([a, b]) => a && b) as [string, string][]
      if (pairs.some(([a, b]) => a !== b)) {
        if (pairs.every(([a, b]) => b >= a)) { roles[date] = 'userDate'; roles[second.index] = 'date' }
        else roles[second.index] = 'userDate'
        if (!header) guessed(named('date')[0], 'There are two date columns: the later of the two is taken as the date the bank posted each line.')
      }
    }
  }

  // Words that say debit or credit, currency codes, pending rows, and account numbers
  for (const c of columns) {
    if (!free(c) || c.filled === 0) continue
    if (isDirection(c.values) && c.distinct <= 6) roles[c.index] = 'direction'
    else if (c.values.every(v => v.trim() === '' || CURRENCIES.has(v.trim().toUpperCase())) && c.distinct <= 2) roles[c.index] = 'currency'
    else if (c.values.some(v => isPending(v)) && c.distinct <= 4 && named('status').length === 0) roles[c.index] = 'status'
    else if (named('account').length === 0 && isAccount(c) && c.values.every(v => v.trim() !== '')) roles[c.index] = 'account'
  }

  // Amounts: what the header named, or the number columns worked out together with a running balance
  const decimal = guessDecimalOf(columns, roles, delimiter, uncertain)
  const hasAmounts = named('amount').length > 0 || named('debit').length > 0
  const numberColumns = columns.filter(c => free(c) && isAmounts(c)).map(c => c.index)
  const base: CsvLayout = { version: 1, delimiter, skip, header: hasHeader, columns: {}, dateOrder, decimal, reversed: false }
  const amountsOf = (cols: CsvColumns) => data.map(r => {
    const a = rowAmount(r, { ...base, columns: cols })
    return a.kind === 'amount' ? a.amount : undefined
  })
  const balancesOf = (column: number) => data.map(r => amountIn((r[column] ?? '').trim(), decimal)?.amount)
  const fits = (cols: CsvColumns, balance: number) => {
    const fit = balanceFit(amountsOf(cols), balancesOf(balance))
    return fit && fit.fit >= 0.8 && fit.pairs >= Math.min(2, data.length - 1) ? fit : undefined
  }
  if (!hasAmounts) {
    const pick = amountColumns(numberColumns, columns, data.length, fits, amountsOf)
    if (pick) {
      if (pick.amount !== undefined) roles[pick.amount] = 'amount'
      if (pick.debit !== undefined) { roles[pick.debit] = 'debit'; roles[pick.credit!] = 'credit' }
      if (pick.balance !== undefined) roles[pick.balance] = 'balance'
      if (pick.debit !== undefined && !pick.named) guessed(pick.debit, 'Two columns hold amounts, never both on one row: the left one is taken as money out, as banks write them.')
      if (pick.amount !== undefined && pick.balance === undefined && numberColumns.length > 1) guessed(pick.amount, 'Several columns hold numbers: this one is taken as the amount.')
    }
  } else if (named('balance').length === 0) {
    const cols = columnsOf(roles, columns)
    const balance = numberColumns.find(i => fits(cols, i))
    if (balance !== undefined) roles[balance] = 'balance'
  }

  // The payee: the text column with the most different values; without a header, the other varied ones are memos
  if (named('payee').length === 0) {
    const texts = columns.filter(c => free(c) && isText(c)).sort((a, b) => b.distinct - a.distinct || a.index - b.index)
    if (texts.length > 0) {
      roles[texts[0].index] = 'payee'
      if (header) guessed(texts[0].index, 'No column is named as the payee: this one has the most different descriptions.')
      else if (texts.length > 1 && texts[1].distinct >= texts[0].distinct * 0.8) guessed(texts[0].index, 'Several columns hold descriptions: this one has the most different ones.')
      if (!header) for (const c of texts.slice(1)) if (c.distinct >= 2) roles[c.index] = 'memo'
    }
  }

  // A payee column that holds kinds of transaction ('pos purchase', 'deposit') beside one that names who with (a
  // bank's Description and Sub-description): the names are the payee, as the bank's OFX has them, and the kinds the memo
  const payee = named('payee')[0]
  if (payee !== undefined) {
    const names = columns.filter(c => c.index !== payee && (roles[c.index] === 'memo' || roles[c.index] === undefined) && isText(c))
      .sort((a, b) => b.distinct - a.distinct)[0]
    if (names && names.distinct >= 3 && names.distinct >= 2 * columns[payee].distinct) {
      const kinds = [...new Set(columns[payee].values.map(v => v.trim()).filter(v => v !== ''))].slice(0, 2).map(v => `“${v}”`).join(', ')
      const name = (c: number) => header?.[c] ? `“${header[c]}”` : `Column ${c + 1}`
      roles[names.index] = 'payee'
      roles[payee] = 'memo'
      guessed(names.index, `${name(payee)} holds few different values (${kinds}…), and ${name(names.index)} holds many, so it is taken as the payee and ${name(payee)} as the memo.`)
    }
  }

  const layoutColumns = columnsOf(roles, columns)
  const layout: CsvLayout = { ...base, columns: layoutColumns }

  // Signs: a signed amount column that is mostly positive is most likely money out shown as positive
  if (layoutColumns.amount !== undefined && !layoutColumns.direction) {
    const signs = amountsOf(layoutColumns).filter((a): a is string => a !== undefined).map(signOf).filter(s => s !== 0)
    const positive = signs.filter(s => s > 0).length
    if (signs.length > 0 && positive > (2 / 3) * signs.length) {
      layout.reversed = true
      uncertain.push({
        field: 'reversed',
        why: `${positive} of the ${signs.length} amounts are positive. Most lines in an account are money out, so money out is probably shown as positive here. A savings account can be mostly deposits: check the preview.`
      })
    }
  }

  if (!hasHeader && preamble) uncertain.push({ field: 'start', why: `The rows above row ${skip + 1} don’t look like transactions, so they are skipped.` })
  else if (hasHeader && !recognised) uncertain.push({ field: 'start', why: `Row ${skip + 1} is taken as the header, but Tessera doesn’t know any of its names.` })
  return { layout, uncertain, width, ...(header && { header }), shapes }
}

/** The layout's columns from each column's role. */
function columnsOf(roles: readonly (Role | undefined)[], columns: readonly Column[]): CsvColumns {
  const c: CsvColumns = {}
  roles.forEach((role, i) => {
    if (role === undefined) return
    if (role === 'memo') c.memo = [...(c.memo ?? []), i]
    else if (role === 'direction') c.direction = { column: i, ...directionWords(columns[i].values) }
    else if (role === 'status') c.status = { column: i, pending: pendingWords(columns[i].values) }
    else if (c[role] === undefined) c[role] = i
  })
  return c
}

/**
 * Which number columns are the amounts and which the running balance, when the header doesn't say: every reading
 * is tried (one signed column, or money out and money in, each with or without a balance), and the one that uses the
 * most columns and whose balance adds up wins. Money out is the left column of a pair, as banks write them.
 */
function amountColumns(
  candidates: number[], columns: Column[], rows: number,
  fits: (cols: CsvColumns, balance: number) => ReturnType<typeof balanceFit>,
  amountsOf: (cols: CsvColumns) => (string | undefined)[]
): { amount?: number, debit?: number, credit?: number, balance?: number, named?: boolean } | undefined {
  type Reading = { cols: CsvColumns, used: number, fit: number, balance?: number }
  const readings: Reading[] = []
  const exclusive = (a: number, b: number) => {
    let one = 0
    for (let r = 0; r < rows; r++) {
      const x = columns[a].values[r].trim() !== ''
      const y = columns[b].values[r].trim() !== ''
      if (x !== y) one++
    }
    return one >= 0.9 * rows
  }
  for (const balance of [undefined, ...candidates]) {
    const rest = candidates.filter(i => i !== balance)
    const structures: CsvColumns[] = []
    for (let x = 0; x < rest.length; x++) {
      for (let y = x + 1; y < rest.length; y++) if (exclusive(rest[x], rest[y])) structures.push({ debit: rest[x], credit: rest[y] })
      structures.push({ amount: rest[x] })
    }
    for (const cols of structures) {
      const used = (cols.amount !== undefined ? 1 : 2) + (balance !== undefined ? 1 : 0)
      if (balance === undefined) { readings.push({ cols, used, fit: 0 }); continue }
      const fit = fits(cols, balance)
      if (fit) readings.push({ cols, used, fit: fit.fit, balance })
    }
  }
  // Every reading reads some rows: prefer those that read the most, then use the most columns, then add up best
  const readCount = (cols: CsvColumns) => amountsOf(cols).filter(a => a !== undefined).length
  readings.sort((a, b) => readCount(b.cols) - readCount(a.cols) || b.used - a.used || b.fit - a.fit)
  const best = readings[0]
  if (!best) return undefined
  return { ...best.cols, ...(best.balance !== undefined && { balance: best.balance }) }
}

/** The date order of the date columns, with a reason when it is a guess. */
function guessOrder(columns: Column[], roles: (Role | undefined)[], pivot: number, uncertain: Uncertain[]): DateOrder {
  const dateColumns = columns.filter(c => roles[c.index] === 'date' || roles[c.index] === 'userDate' || (roles[c.index] === undefined && isDates(c)))
  const values = dateColumns.flatMap(c => c.values.map(v => v.trim()).filter(v => v !== '' && isDateCell(v, pivot)))
  if (values.length === 0) return 'YMD'
  const orders = guessDateOrder(values, { pivot, monthNames: true })
  if (orders.length === 1) return orders[0]
  if (orders.length === 0) {
    // No one order reads every date: the one that reads the most
    const counts = (['YMD', 'MDY', 'DMY'] as DateOrder[]).map(order => ({ order, n: values.filter(v => dateIn(v, order, pivot)).length }))
    const best = counts.sort((a, b) => b.n - a.n)[0].order
    uncertain.push({ field: 'dateOrder', why: 'Some dates can’t be read in the same order as the others. Check the preview.' })
    return best
  }
  // Several orders read every date: the one whose dates span the shortest time (a statement covers weeks, not years)
  const span = (order: DateOrder) => {
    const dates = values.map(v => dateIn(v, order, pivot)!).sort()
    return Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])
  }
  const best = [...orders].sort((a, b) => span(a) - span(b))[0]
  const dayMonth = orders.includes('MDY') && orders.includes('DMY')
  uncertain.push({
    field: 'dateOrder',
    why: dayMonth
      ? 'The dates could be day/month or month/day: every day in this file is 12 or less. Check the preview.'
      : 'The dates could be read in more than one order. Check the preview.'
  })
  return best
}

/** The decimal separator of the amount columns, with a reason when it is a guess. */
function guessDecimalOf(columns: Column[], roles: (Role | undefined)[], delimiter: Delimiter, uncertain: Uncertain[]): DecimalSeparator {
  const numeric = columns.filter(c => ['amount', 'debit', 'credit', 'balance'].includes(roles[c.index] ?? '') || (roles[c.index] === undefined && isNumbers(c)))
  const values = numeric.flatMap(c => c.values.map(v => v.trim()).filter(v => v !== '' && isAmountCell(v)))
  const fallback: DecimalSeparator = delimiter === ';' ? ',' : '.'
  if (values.length === 0) return fallback
  const both = (['.', ','] as const).filter(d => values.every(v => amountIn(v, d) !== undefined))
  if (both.length === 1) return both[0]
  if (both.length === 0) {
    const best = (['.', ','] as const).map(d => ({ d, n: values.filter(v => amountIn(v, d)).length })).sort((a, b) => b.n - a.n)[0].d
    uncertain.push({ field: 'decimal', why: 'Some amounts can’t be read with the same decimal separator as the others.' })
    return best
  }
  // Both read every amount: only a cell like '1,234' would read differently
  if (values.some(v => /\d[.,]\d{3}(?!\d)/.test(v))) {
    uncertain.push({ field: 'decimal', why: `Amounts like “${values.find(v => /\d[.,]\d{3}(?!\d)/.test(v))}” could be read either way. Check the preview.` })
  }
  return fallback
}
