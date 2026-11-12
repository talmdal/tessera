// CSV files, anonymised in place. The CSV plugin's own reader and guesser (plugins/import-csv/src/shared) say where
// each cell is and what its column holds; only cells are rewritten, and every other byte (delimiters, quoting, line
// ends, the header) is kept, so the file is still the layout the bank wrote.
//
// What each cell becomes, by its column's role in the guessed layout:
// - dates: kept (moved by whole weeks if asked); the header: kept, and its words kept wherever they appear;
// - amounts (one signed column, or money out and money in): changed (see amounts.ts); a running balance worked out
//   again from the changed amounts, in date order, so it still adds up;
// - debit/credit words, status and currency: kept; cheque numbers: kept when short;
// - account numbers and bank ids: other characters of the same shape, masks kept;
// - payees, memos, categories, and every other text cell (columns the layout doesn't use, the preamble, totals
//   rows): their words replaced; numbers in them as other digits, amounts changed.
// See docs/import-formats-design.md, "What is replaced, by format".
import { guessDateOrder } from '@tessera/import-api'
import { dateIn, isAmountCell, isDateCell, pivotFor } from '../../plugins/import-csv/src/shared/cells'
import { readCsv, valuesOf, type CsvCell, type CsvRow, type Delimiter } from '../../plugins/import-csv/src/shared/csv'
import { guessLayout } from '../../plugins/import-csv/src/shared/guess'
import { problemsOf, rolesOf, type CsvLayout, type Role } from '../../plugins/import-csv/src/shared/layout'
import { balanceFit, orderOf, readLines, rowAmount } from '../../plugins/import-csv/src/shared/lines'
import { Amounts, SCALE, atScale, readAmount, rewrite, writeSigned, type WrittenAmount } from './amounts'
import type { BalanceMapping, OfxCounts } from './ofx'
import type { Scannable } from './scan'
import type { Pseudonyms, Replaced } from './words'

export interface CsvRun {
  words: Pseudonyms
  amounts: Amounts
  balances: BalanceMapping
  options: { shiftDays: number, keepAmounts: boolean }
  /** Today, for two-digit years. */
  today: Date
}

/** A CSV file read, ready to be rewritten once every file of the run has been read. */
export interface PreparedCsv {
  text: string
  delimiter: Delimiter
  rows: CsvRow[]
  values: string[][]
  layout: CsvLayout
  roles: (Role | undefined)[]
  /** The first row of data. */
  first: number
  pivot: number
  /** Each row's date (YYYY-MM-DD), when it has one. */
  dates: (string | undefined)[]
  /** The account each row belongs to, for its balances: the account column's value, or the file's header. */
  accounts: string[]
  /** How each data row's amount changes, at SCALE, in the amounts' own sign (before `reversed`). */
  changes: Map<number, number>
  /** How each account's running balance follows the amounts: 1 with them, -1 against. */
  senses: Map<string, 1 | -1>
}

/** True for a CSV file: its name, or rows that split evenly. */
export const isCsvName = (name: string) => /\.csv$/i.test(name)

/** An amount cell's 'CR' or 'DR', written before or after: kept as it is while the number changes. */
const MARKER = /^(\s*(?:CR|DR)\.?\s*)?(.*?)(\s*(?:CR|DR)\.?\s*)?$/i

/** How a cell's amount is written, with its marker apart. */
function writtenIn(text: string, layout: CsvLayout): { before: string, written: WrittenAmount, after: string } | undefined {
  const m = MARKER.exec(text)!
  const written = readAmount(m[2], layout.decimal)
  return written ? { before: m[1] ?? '', written, after: m[3] ?? '' } : undefined
}

/** A row's content, for its line's key across the run's files. */
const keyOf = (values: readonly string[], date: string | undefined) => `${date ?? ''}|${values.map(v => v.trim()).join('\u001f')}`

/**
 * The first pass over a file: reads it, guesses its layout, notes its originals (so nothing made up is one of them)
 * and its header's words (kept everywhere), and records how each row's amount changes, for the balances of every file
 * in the run.
 */
export function prepareCsv(text: string, run: CsvRun): PreparedCsv {
  const { delimiter, rows } = readCsv(text)
  const values = rows.map(valuesOf)
  if (values.every(v => v.every(c => c === ''))) throw new Error('it is empty')
  const pivot = pivotFor(run.today)
  const guess = guessLayout(values, { delimiter, pivot })
  const layout = guess.layout
  const first = layout.skip + (layout.header ? 1 : 0)
  const width = Math.max(guess.width, ...values.map(v => v.length))
  const roles = problemsOf(layout, guess.width).length === 0 ? rolesOf(layout, width) : Array.from({ length: width }, () => undefined)
  for (const v of values) for (const cell of v) run.words.note(cell)
  if (layout.header) for (const cell of values[layout.skip] ?? []) run.words.addVocabulary(cell)

  const dates = values.map((v, i) => {
    if (i < first || layout.columns.date === undefined) return undefined
    return dateIn((v[layout.columns.date] ?? '').trim(), layout.dateOrder, pivot)
  })
  const headerKey = layout.header ? (values[layout.skip] ?? []).join('|') : `${delimiter}${guess.width}`
  const accounts = values.map(v => layout.columns.account !== undefined ? `csv:${(v[layout.columns.account] ?? '').replace(/\s+/g, '')}` : `csv:${headerKey}`)

  // Each line's amount as written (signs as the file has them), and how it changes. Only rows the CSV format takes as
  // lines count: not a pending row, whose amount isn't in the balance yet
  const plain = { ...layout, reversed: false }
  const changes = new Map<number, number>()
  const lineRows = new Set(problemsOf(layout, guess.width).length === 0 ? readLines(values, plain, pivot).statements.flatMap(s => s.lines.map(l => l.row)) : [])
  const amountsAsWritten: (string | undefined)[] = values.map((v, i) => {
    if (!lineRows.has(i)) return undefined
    const a = rowAmount(v, plain)
    return a.kind === 'amount' ? a.amount : undefined
  })
  const c = layout.columns
  const seen = new Map<string, number>()
  for (let i = first; i < values.length; i++) {
    if (amountsAsWritten[i] === undefined) continue
    // The change of each amount cell: money in minus money out, or the one signed column
    let change = 0
    for (const [column, sign] of [[c.amount, 1], [c.credit, 1], [c.debit, -1]] as const) {
      if (column === undefined) continue
      const cell = writtenIn((values[i][column] ?? '').trim(), layout)
      if (!cell) continue
      const changed = run.amounts.change(cell.written.value, cell.written.decimals)
      const delta = Math.abs(changed) - Math.abs(cell.written.value)
      change += c.amount !== undefined ? Math.sign(atScale(amountsAsWritten[i]!)) * delta : sign * delta
    }
    changes.set(i, change)
    // Keyed by the row's content and its occurrence in this file, so a row in two overlapping files is one line, and
    // two identical rows in one file (two coffees) are two
    const known = run.balances[accounts[i]] ??= { offset: 0, lines: {} }
    const key = keyOf(values[i], dates[i])
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    known.lines[`${key}#${n}`] = [dates[i]!, change]
  }

  // How each account's balance follows the amounts
  const senses = new Map<string, 1 | -1>()
  if (c.balance !== undefined) {
    for (const account of new Set(accounts.slice(first))) {
      const mine = values.map((_, i) => i).filter(i => i >= first && accounts[i] === account && amountsAsWritten[i] !== undefined)
      const fit = balanceFit(mine.map(i => amountsAsWritten[i]), mine.map(i => amountIn((values[i][c.balance!] ?? '').trim(), layout)))
      senses.set(account, fit && fit.fit >= 0.5 ? fit.sign : 1)
    }
  }
  return { text, delimiter, rows, values, layout, roles, first, pivot, dates, accounts, changes, senses }
}

/** A cell's amount, canonical, as the layout reads it. */
function amountIn(text: string, layout: CsvLayout): string | undefined {
  const r = rowAmount([text], { ...layout, reversed: false, columns: { date: 0, amount: 0 } })
  return r.kind === 'amount' ? r.amount : undefined
}

/** A cell's new text, written as the original was: in quotes if it was, with doubled quotes inside. */
function written(cell: CsvCell, source: string, value: string, delimiter: Delimiter): string {
  const raw = source.slice(cell.start, cell.end)
  if (!cell.quoted && !value.includes(delimiter) && !/["\r\n]/.test(value)) {
    const at = cell.text === '' ? raw.length - raw.trimStart().length : raw.indexOf(cell.text)
    if (at >= 0) return raw.slice(0, at) + value + raw.slice(at + cell.text.length)
  }
  const inner = raw.indexOf('"')
  const prefix = inner > 0 ? raw.slice(0, inner) : ''
  const lastQuote = raw.lastIndexOf('"')
  const suffix = cell.quoted && lastQuote > inner ? raw.slice(lastQuote + 1) : ''
  return `${prefix}"${value.replace(/"/g, '""')}"${suffix}`
}

const made = (text: string): Replaced => ({ text, original: new Uint8Array(text.length) })

/**
 * A date moved by whole days, written as it was: the same order, separators, year digits and month style. Days and
 * months are padded to two digits as `pad` says (from the rest of the column: '02' or '2'); when it doesn't say, as
 * the date itself shows, and otherwise padded when written with numbers and not when the month has its name.
 */
export function shiftCsvDate(text: string, order: CsvLayout['dateOrder'], days: number, pivot: number, pad?: boolean): string | undefined {
  if (days === 0) return text
  const iso = dateIn(text, order, pivot)
  if (!iso) return undefined
  const moved = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days))
  const [y, m, d] = [moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate()]
  const compact = /^(\d{4})(\d{2})(\d{2})(.*)$/.exec(text.trim())
  if (compact && order === 'YMD') return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${compact[4]}`
  const numeric = /^(\s*)(\d{1,4})(\D)(\d{1,4})(\D)(\d{1,4})(.*)$/.exec(text)
  if (numeric) {
    const [, lead, a, s1, b, s2, c, rest] = numeric
    const parts = order === 'YMD' ? [[a, y], [b, m], [c, d]] : order === 'MDY' ? [[a, m], [b, d], [c, y]] : [[a, d], [b, m], [c, y]]
    const out = parts.map(([part, value], k) => {
      const p = String(part)
      const isYear = order === 'YMD' ? k === 0 : k === 2
      if (isYear) return p.length === 2 ? String(y % 100).padStart(2, '0') : String(y)
      const padded = p.startsWith('0') || (p.length === 2 && pad !== false) || pad === true
      return padded ? String(value).padStart(2, '0') : String(value)
    })
    return `${lead}${out[0]}${s1}${out[1]}${s2}${out[2]}${rest}`
  }
  // Month names, in English: the same length of name, in the same case
  const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const named = /[A-Za-z]{3,9}\.?/.exec(text)
  const word = named?.[0].replace(/\.$/, '')
  const month = word ? NAMES.findIndex(n => n.toLowerCase().startsWith(word.toLowerCase()) && (word.length === 3 || n.length === word.length)) : -1
  if (!named || month === -1) return undefined
  const name = word!.length === 3 ? NAMES[m - 1].slice(0, 3) : NAMES[m - 1]
  const cased = word === word!.toUpperCase() ? name.toUpperCase() : word === word!.toLowerCase() ? name.toLowerCase() : name
  const numbers = text.replace(named[0], '\u0000').split(/(\d+)/)
  const oldDay = Number(iso.slice(8, 10))
  const oldYear = iso.slice(0, 4)
  const rebuilt = numbers.map(part => {
    if (!/^\d+$/.test(part)) return part
    if (part.length === 4 && part === oldYear) return String(y)
    if (part.length === 2 && `20${part}` === oldYear) return String(y % 100).padStart(2, '0')
    if (Number(part) === oldDay) return part.startsWith('0') || pad === true ? String(d).padStart(2, '0') : String(d)
    return part
  }).join('')
  return rebuilt.replace('\u0000', cased + (named[0].endsWith('.') ? '.' : ''))
}

/** The second pass: the file with its cells replaced, and what the scan needs to know about each character. */
export function rewriteCsv(prepared: PreparedCsv, run: CsvRun, counts: OfxCounts, notes: string[] = []): Scannable {
  const { text, rows, values, layout, roles, first, pivot, delimiter } = prepared
  const { words, amounts, options } = run
  const edits: { start: number, end: number, text: string, original: Uint8Array, hidden: boolean }[] = []
  const keepCell = (cell: CsvCell, hidden: boolean) => edits.push({ start: cell.start, end: cell.end, text: text.slice(cell.start, cell.end), original: new Uint8Array(cell.end - cell.start).fill(hidden ? 0 : 1), hidden })
  const replaceCell = (cell: CsvCell, replaced: Replaced, hidden = false) => {
    const out = written(cell, text, replaced.text, delimiter)
    // The replaced value's marks, placed where it lands in the cell's new text
    const at = out.indexOf(replaced.text)
    const original = new Uint8Array(out.length)
    if (at >= 0) original.set(replaced.original, at)
    edits.push({ start: cell.start, end: cell.end, text: out, original, hidden })
  }
  const changeAmount = (cell: CsvCell): boolean => {
    const amount = writtenIn(cell.text, layout)
    if (!amount) return false
    if (options.keepAmounts) { keepCell(cell, true); return true }
    const changed = amounts.change(amount.written.value, amount.written.decimals)
    replaceCell(cell, made(`${amount.before}${rewrite(amount.written, changed)}${amount.after}`))
    counts.amounts++
    return true
  }
  const asText = (cell: CsvCell, count: 'payees' | 'memos' | 'otherText') => {
    if (cell.text === '') return
    replaceCell(cell, words.text(cell.text))
    counts[count]++
  }

  // Running balances, worked out again: the original plus the account's offset plus every change up to the row
  const balanceColumn = layout.columns.balance
  const newBalances = new Map<number, string>()
  if (balanceColumn !== undefined && !options.keepAmounts) {
    const order = orderOf(prepared.dates.filter((d): d is string => d !== undefined)) ?? 'oldestFirst'
    const indexes = values.map((_, i) => i).filter(i => i >= first)
    const chronological = order === 'oldestFirst' ? indexes : [...indexes].reverse()
    const sameDay = new Map<string, number>()              // this file's changes so far on each day, per account
    // A balance row without a date (a balance forward) is the balance before the next dated row
    const nextDate = new Map<number, string>()
    let upcoming: string | undefined
    for (const i of [...chronological].reverse()) {
      if (prepared.dates[i]) upcoming = prepared.dates[i]
      else if (upcoming) nextDate.set(i, upcoming)
    }
    for (const i of chronological) {
      const account = prepared.accounts[i]
      const dated = prepared.dates[i]
      const date = dated ?? nextDate.get(i)
      const sense = prepared.senses.get(account) ?? 1
      if (date && prepared.changes.has(i)) {
        const dayKey = `${account}|${date}`
        sameDay.set(dayKey, (sameDay.get(dayKey) ?? 0) + prepared.changes.get(i)!)
      }
      const cell = rows[i].cells[balanceColumn]
      const balance = cell ? writtenIn(cell.text, layout) : undefined
      if (!cell || !balance || !date) continue
      const known = run.balances[account] ??= { offset: 0, lines: {} }
      if (known.offset === 0) known.offset = amounts.change(balance.written.value, balance.written.decimals) - balance.written.value || 10 ** (SCALE - balance.written.decimals)
      const before = Object.values(known.lines).filter(([d]) => d < date).reduce((sum, [, change]) => sum + change, 0)
      const value = balance.written.value + known.offset + sense * (before + (dated ? sameDay.get(`${account}|${date}`) ?? 0 : 0))
      const signSame = Math.sign(value) === Math.sign(balance.written.value) || value === 0
      newBalances.set(i, `${balance.before}${signSame ? rewrite(balance.written, value) : writeSigned(value, balance.written)}${balance.after}`)
    }
  }

  // Whether the date columns pad days and months ('02/10' or '2/10'), for dates moved to a one-digit day
  const padOf = (column: number): boolean | undefined => {
    const dates = values.slice(first).map(v => (v[column] ?? '').trim()).filter(v => isDateCell(v, pivot))
    if (dates.some(v => /(^|\D)0\d/.test(v.replace(/^\d{4}/, '')))) return true
    if (dates.some(v => /(^|\D)\d(\D|$)/.test(v))) return false
    return undefined
  }
  const pads = new Map<number, boolean | undefined>()

  rows.forEach((row, i) => {
    const isHeader = layout.header && i === layout.skip
    row.cells.forEach((cell, column) => {
      if (cell.text === '') { keepCell(cell, true); return }
      if (isHeader) { keepCell(cell, false); return }
      if (i < first) {                                   // the preamble: dates kept, everything else replaced
        if (isDateCell(cell.text, pivot)) keepCell(cell, true)
        else asText(cell, 'otherText')
        return
      }
      const role = roles[column]
      if ((role === 'date' || role === 'userDate') && isDateCell(cell.text, pivot)) {
        if (options.shiftDays === 0) { keepCell(cell, true); return }
        if (!pads.has(column)) pads.set(column, padOf(column))
        const moved = shiftCsvDate(cell.text, layout.dateOrder, options.shiftDays, pivot, pads.get(column))
        if (moved === undefined) throw new Error(`its date “${cell.text}” can't be moved`)
        replaceCell(cell, made(moved), true)
        counts.dates++
        return
      }
      if (role === 'amount' || role === 'debit' || role === 'credit') { if (!changeAmount(cell)) asText(cell, 'otherText'); return }
      if (role === 'balance') {
        const balance = newBalances.get(i)
        if (balance !== undefined) { replaceCell(cell, made(balance)); counts.balances++ }
        else if (!changeAmount(cell)) asText(cell, 'otherText')
        return
      }
      if (role === 'direction' || role === 'status' || role === 'currency') { keepCell(cell, false); return }
      if (role === 'number' && /^\d{1,6}$/.test(cell.text)) { keepCell(cell, false); return }
      if (role === 'account') { replaceCell(cell, made(words.shape(cell.text, { masks: true }))); counts.accountNumbers++; return }
      if (role === 'id') { replaceCell(cell, made(words.shape(cell.text))); counts.ids++; return }
      if (role === 'payee') { asText(cell, 'payees'); return }
      if (role === 'memo') { asText(cell, 'memos'); return }
      // A column the layout doesn't use, or a cell that isn't what its column holds
      if (isDateCell(cell.text, pivot)) { keepCell(cell, true); return }
      if (/^[-+]?\d{1,4}$/.test(cell.text) || cell.text === '-') { keepCell(cell, false); return }
      if (isAmountCell(cell.text) && /[.,]\d{1,2}\b/.test(cell.text) && changeAmount(cell)) return
      asText(cell, 'otherText')
    })
  })
  // Moved dates may read in more orders than before (no day past 12 left) or fewer: the file then tests something else
  if (options.shiftDays !== 0 && layout.columns.date !== undefined) {
    const column = layout.columns.date
    const before = values.slice(first).map(v => (v[column] ?? '').trim()).filter(v => isDateCell(v, pivot))
    const after = before.map(v => shiftCsvDate(v, layout.dateOrder, options.shiftDays, pivot, pads.get(column)) ?? v)
    const orders = (dates: string[]) => guessDateOrder(dates, { pivot, monthNames: true }).length
    if (orders(before) !== orders(after)) {
      notes.push(orders(after) > orders(before)
        ? 'Moved, its dates could be read in more than one order, as they couldn\'t before: choose another number of weeks to keep that.'
        : 'Moved, its dates can be read in only one order, as they couldn\'t before: choose another number of weeks to keep them ambiguous.')
    }
  }
  return build(text, edits)
}

/** Applies the edits, keeping every other character (delimiters, quotes, line ends: structure), and marks them. */
function build(source: string, edits: { start: number, end: number, text: string, original: Uint8Array, hidden: boolean }[]): Scannable {
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  const original: number[] = []
  const hidden: number[] = []
  let at = 0
  for (const edit of edits) {
    if (edit.start < at) continue
    for (let i = at; i < edit.start; i++) { text += source[i]; original.push(1); hidden.push(1) }
    text += edit.text
    for (let i = 0; i < edit.text.length; i++) { original.push(edit.original[i] ?? 0); hidden.push(edit.hidden ? 1 : 0) }
    at = edit.end
  }
  for (let i = at; i < source.length; i++) { text += source[i]; original.push(1); hidden.push(1) }
  return { text, original: Uint8Array.from(original), hidden: Uint8Array.from(hidden) }
}

/**
 * A CSV file as the scan sees it when checking, not anonymising (`--check`, the fixtures' privacy test): dates and
 * amounts hidden. For the anonymiser's own output ('*.anon.*'), everything it makes up is hidden too (payees, memos,
 * account numbers, ids), and only what it keeps as it was is looked at: the header, the codes, cheque numbers.
 */
export function checkableCsv(text: string, options: { anonymised?: boolean, today?: Date } = {}): Scannable {
  const { delimiter, rows } = readCsv(text)
  const values = rows.map(valuesOf)
  const pivot = pivotFor(options.today)
  const guess = guessLayout(values, { delimiter, pivot })
  const layout = guess.layout
  const first = layout.skip + (layout.header ? 1 : 0)
  const width = Math.max(guess.width, ...values.map(v => v.length))
  const roles = problemsOf(layout, guess.width).length === 0 ? rolesOf(layout, width) : Array.from({ length: width }, () => undefined)
  const made = new Set<Role | undefined>(['payee', 'memo', 'account', 'id', 'category', 'amount', 'debit', 'credit', 'balance', undefined])
  const edits = rows.flatMap((row, i) => row.cells.map((cell, column) => {
    const raw = text.slice(cell.start, cell.end)
    const harmless = cell.text === '' || isDateCell(cell.text, pivot) || (i >= first && ['amount', 'debit', 'credit', 'balance'].includes(roles[column] ?? '') && isAmountCell(cell.text))
    const isHeader = layout.header && i === layout.skip
    const hidden = harmless || (options.anonymised === true && !isHeader && (i < first || made.has(roles[column])))
    return { start: cell.start, end: cell.end, text: raw, original: new Uint8Array(raw.length).fill(1), hidden }
  }))
  return build(text, edits)
}
