// QIF files, anonymised in place. The QIF plugin's own reader (plugins/import-qif/src/privileged/qif.ts) says where
// each field's value is; only values are rewritten, and every other byte (headers, codes, '^', line ends) is kept, so
// the file is still the dialect Money or Quicken wrote.
//
// What each value becomes, by its code:
// - dates (D) kept, moved by whole weeks if asked; C (cleared) and K kept; N kept when it is a cheque number (6
//   digits at most) or a word (ATM, XFER, Buy), and otherwise (a transfer's reference, 'CA12345678') given another
//   value of the same shape;
// - amounts (T, U, $, O, and an account's $ and L limit) changed (see amounts.ts); a split's total worked out again
//   from its changed parts, so it still equals them, and U written as T is;
// - payees, memos, addresses, split memos (P, M, A, E), account names and descriptions, classes and security names:
//   their words replaced. An account's name is replaced the same way wherever it appears, `[Savings]` transfers too;
// - categories (L, S): kept when Tessera's starter categories have them ('Food:Groceries'), otherwise each part's words
//   replaced, keeping the depth;
// - investment quantities and prices (Q, I), and price lists, kept: they aren't personal.
// See docs/import-formats-design.md, "What is replaced, by format".
import { guessDecimal, type DateOrder, type DecimalSeparator } from '@tessera/import-api'
import { STARTER_CATEGORIES } from '../../plugins/accounts/src/privileged/schema'
import { likeliestOrder, qifDate, qifDateOrders } from '../../plugins/import-qif/src/privileged/dates'
import { parseQif, type QifField, type QifSection } from '../../plugins/import-qif/src/privileged/qif'
import { Amounts, readAmount, rewrite, writeSigned, type WrittenAmount } from './amounts'
import type { OfxCounts } from './ofx'
import type { Scannable } from './scan'
import type { Pseudonyms, Replaced } from './words'

export interface QifRun {
  words: Pseudonyms
  amounts: Amounts
  options: { shiftDays: number, keepAmounts: boolean }
  today: Date
}

export interface PreparedQif {
  text: string
  sections: QifSection[]
  dateOrder: DateOrder
  decimal: DecimalSeparator
  pivot: number
}

/** True for a QIF file: its name, or a first line that opens a QIF section. */
export const isQif = (name: string, text: string) =>
  /\.qif$/i.test(name) || /^\s*!\s*(type\s*:|account|option\s*:)/i.test(text.replace(/^\uFEFF/, '').slice(0, 200))

/** Tessera's starter categories, as paths compared lower case without spaces: 'food:groceries', 'salary'. */
const STARTER = new Set(STARTER_CATEGORIES.flatMap(c => [c.name, ...(c.children ?? []).map(child => `${c.name}:${child}`)]).map(p => p.toLowerCase().replace(/\s+/g, '')))

/** Codes whose values are amounts, in transaction records. */
const AMOUNTS = new Set(['T', 'U', '$', 'O'])
/** Codes whose values are text to replace, in transaction records. */
const TEXT = new Set(['P', 'M', 'A', 'E', 'Y'])
/** An `N` kept as it is: a cheque number, or words (ATM, XFER, Deposit, an investment's Buy or ReinvDiv). */
const PLAIN_NUMBER = /^(\d{1,6}|[\p{L} ]{1,20})$/u

/** Codes kept as they are. */
const KEPT = new Set(['D', 'C', 'K', 'Q', 'I', '%', '^', 'F', '1', '2', '3', '4', '5', '6', '7', '8', 'B', 'G', 'R', 'X'])

/** The first pass: reads the file, notes its originals, and decides its date order (for moving dates). */
export function prepareQif(text: string, run: QifRun): PreparedQif {
  const sections = parseQif(text)
  if (!sections.some(s => s.header !== '')) throw new Error('it has no !Type or !Account line, so it is not a QIF file')
  for (const section of sections) for (const record of section.records) for (const field of record.fields) run.words.note(field.value)
  // The starter categories are kept as they are, so their words are kept everywhere: a payee using one ('Fresh
  // Groceries') mustn't have it replaced, or the scan would find the kept category giving it away
  for (const category of STARTER_CATEGORIES) for (const name of [category.name, ...(category.children ?? [])]) run.words.addVocabulary(name)
  const pivot = run.today.getFullYear() + 10
  const dates = sections.flatMap(s => s.records.flatMap(r => r.fields.filter(f => f.code === 'D').map(f => f.value)))
  const orders = qifDateOrders(dates, pivot)
  const dateOrder = orders.length === 1 ? orders[0] : orders.length > 1 ? likeliestOrder(dates, orders, pivot) : 'MDY'
  const amounts = sections.flatMap(s => s.records.flatMap(r => r.fields.filter(f => AMOUNTS.has(f.code) && f.value.trim() !== '').map(f => f.value)))
  const decimals = guessDecimal(amounts)
  return { text, sections, dateOrder, decimal: decimals.length === 1 ? decimals[0] : '.', pivot }
}

/** A QIF date moved by whole days, written as it was: apostrophe years, padding spaces, separators, digits. */
export function shiftQifDate(text: string, order: DateOrder, days: number, pivot: number): string | undefined {
  if (days === 0) return text
  const iso = qifDate(text, order, pivot)
  if (!iso) return undefined
  const moved = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days))
  const [y, m, d] = [moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate()]
  if (/^\s*\d{4}-\d{1,2}-\d{1,2}\s*$/.test(text)) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const m1 = /^(\s*)(\s*\d{1,2})([/.-])(\s*\d{1,2})(['/.-])(\s*\d{1,4})(\s*)$/.exec(text)
  if (!m1) return undefined
  const [, lead, a, s1, b, s2, c, trail] = m1
  const quicken = s2 === "'"
  // Quicken's style: the first number as it comes, the second padded to two with a space ('9/ 2'26'), the year two
  // digits (or four). Otherwise each number two digits wide if it was, with zeros
  const write = (part: string, value: number, second: boolean) => {
    if (quicken) return second ? String(value).padStart(2, ' ') : String(value)
    return part.trim().length === 2 ? String(value).padStart(2, '0') : String(value)
  }
  const year = c.trim().length === 4 ? String(y) : c.trim().length === 1 ? String(y % 10) : String(y % 100).padStart(2, '0')
  const [first, second] = order === 'DMY' ? [d, m] : [m, d]
  return `${lead}${write(a, first, false)}${s1}${write(b, second, true)}${s2}${year}${trail}`
}

/** A category path with the parts Tessera doesn't start with replaced, keeping its depth and its class's shape. */
function category(value: string, words: Pseudonyms): Replaced {
  const [path, ...classes] = value.split('/')
  const transfer = /^\[(.*)\]$/.exec(path.trim())
  const parts: Replaced[] = []
  if (transfer) parts.push(made('['), words.text(transfer[1]), made(']'))
  else if (path !== '') {
    const names = path.split(':')
    names.forEach((name, i) => {
      if (i > 0) parts.push(made(':'))
      const prefix = names.slice(0, i + 1).join(':').toLowerCase().replace(/\s+/g, '')
      parts.push(STARTER.has(prefix) ? made(name) : words.text(name))
    })
  }
  for (const cls of classes) parts.push(made('/'), words.text(cls))
  return join(parts)
}

const made = (text: string): Replaced => ({ text, original: new Uint8Array(text.length) })
const join = (parts: Replaced[]): Replaced => {
  const text = parts.map(p => p.text).join('')
  const original = new Uint8Array(text.length)
  let at = 0
  for (const p of parts) { original.set(p.original, at); at += p.text.length }
  return { text, original }
}

/** The second pass: the file with its values replaced, and what the scan needs to know about each character. */
export function rewriteQif(prepared: PreparedQif, run: QifRun, counts: OfxCounts): Scannable {
  const { text, sections, dateOrder, decimal, pivot } = prepared
  const { words, amounts, options } = run
  const edits: { start: number, end: number, text: string, original: Uint8Array, hidden: boolean }[] = []
  const keep = (f: QifField, hidden: boolean) => edits.push({ start: f.start, end: f.end, text: f.value, original: new Uint8Array(f.value.length).fill(hidden ? 0 : 1), hidden })
  const replace = (f: QifField, replaced: Replaced, hidden = false) => edits.push({ start: f.start, end: f.end, text: replaced.text, original: replaced.original, hidden })
  /** An amount changed, in its own style; undefined when the value isn't one. */
  const changed = (value: string): { written: WrittenAmount, value: number } | undefined => {
    const written = readAmount(value.trim(), decimal)
    if (!written) return undefined
    return { written, value: options.keepAmounts ? written.value : amounts.change(written.value, written.decimals) }
  }
  const amount = (f: QifField) => {
    const c = changed(f.value)
    if (!c || options.keepAmounts) { keep(f, c !== undefined); return }
    replace(f, made(rewrite(c.written, c.value)))
    counts.amounts++
  }

  for (const section of sections) {
    const kind = section.name
    for (const record of section.records) {
      // A split's total is its changed parts added up, written as the total was
      const parts = record.fields.filter(f => f.code === '$').map(f => changed(f.value))
      const totalField = record.fields.find(f => f.code === 'T')
      const total = totalField ? changed(totalField.value) : undefined
      const splitsAddUp = parts.length > 0 && parts.every(p => p !== undefined) && total !== undefined &&
        parts.reduce((s, p) => s + p!.written.value, 0) === total.written.value
      const splitTotal = splitsAddUp ? parts.reduce((s, p) => s + p!.value, 0) : undefined

      for (const field of record.fields) {
        const { code, value } = field
        if (value === '') { keep(field, true); continue }
        if (kind === '!account') {
          if (code === 'N' || code === 'D') { replace(field, words.text(value)); counts.otherText++ }
          else if (code === '$' || code === 'L') amount(field)
          else if (code === '/') keep(field, true)
          else keep(field, false)
          continue
        }
        if (kind === '!type:cat') {
          if (code === 'N') { replace(field, category(value, words)); counts.otherText++ }
          else if (code === 'D') { replace(field, words.text(value)); counts.otherText++ }
          else keep(field, false)
          continue
        }
        if (kind === '!type:class' || kind === '!type:security') {
          if (code === 'N' || code === 'D') { replace(field, words.text(value)); counts.otherText++ }
          else keep(field, false)
          continue
        }
        if (kind === '!type:prices') { keep(field, true); continue }
        if (code === 'D') {
          if (options.shiftDays === 0) { keep(field, true); continue }
          const moved = shiftQifDate(value, dateOrder, options.shiftDays, pivot)
          if (moved === undefined) throw new Error(`its date “${value}” can't be moved`)
          replace(field, made(moved), true)
          counts.dates++
          continue
        }
        if (code === 'N') {
          if (PLAIN_NUMBER.test(value.trim())) keep(field, false)
          else { replace(field, made(words.shape(value))); counts.ids++ }
          continue
        }
        if ((code === 'T' || code === 'U') && splitTotal !== undefined && !options.keepAmounts) {
          const c = changed(value)!
          replace(field, made(Math.sign(splitTotal) === Math.sign(c.written.value) ? rewrite(c.written, splitTotal) : writeSigned(splitTotal, c.written)))
          counts.amounts++
          continue
        }
        if (AMOUNTS.has(code)) { amount(field); continue }
        if (code === 'L' || code === 'S') { replace(field, category(value, words)); counts.otherText++; continue }
        if (TEXT.has(code)) {
          replace(field, words.text(value))
          if (code === 'P') counts.payees++
          else if (code === 'M' || code === 'E') counts.memos++
          else counts.otherText++
          continue
        }
        if (KEPT.has(code)) { keep(field, code === 'D' || code === 'Q' || code === 'I'); continue }
        // A code this doesn't know: its words replaced, to be safe
        replace(field, words.text(value))
        counts.otherText++
      }
    }
  }
  return build(text, edits)
}

/** Applies the edits, keeping every other character (headers, codes, '^', line ends: structure), and marks them. */
function build(source: string, edits: { start: number, end: number, text: string, original: Uint8Array, hidden: boolean }[]): Scannable {
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  const original: number[] = []
  const hidden: number[] = []
  let at = 0
  const structure = (from: number, to: number) => {
    for (let i = from; i < to; i++) { text += source[i]; original.push(1); hidden.push(1) }
  }
  for (const edit of edits) {
    if (edit.start < at) continue
    structure(at, edit.start)
    text += edit.text
    for (let i = 0; i < edit.text.length; i++) { original.push(edit.original[i] ?? 0); hidden.push(edit.hidden ? 1 : 0) }
    at = edit.end
  }
  structure(at, source.length)
  return { text, original: Uint8Array.from(original), hidden: Uint8Array.from(hidden) }
}

/**
 * A QIF file as the scan sees it when checking, not anonymising (`--check`, the fixtures' privacy test): dates and
 * amounts hidden. For the anonymiser's own output ('*.anon.*'), the values it makes up are hidden too (payees, memos,
 * addresses, account names, categories, references in N), and only what it keeps as it was is looked at: cheque
 * numbers and words in N, C, and unknown codes.
 */
export function checkableQif(text: string, options: { anonymised?: boolean } = {}): Scannable {
  const edits = parseQif(text).flatMap(section => section.records.flatMap(record => record.fields.map(field => {
    const harmless = field.code === 'D' || AMOUNTS.has(field.code) || field.code === 'Q' || field.code === 'I' || section.name === '!type:prices'
    const madeUp = TEXT.has(field.code) || field.code === 'L' || field.code === 'S' || section.name === '!account' ||
      section.name === '!type:cat' || section.name === '!type:class' || section.name === '!type:security' ||
      (field.code === 'N' && !PLAIN_NUMBER.test(field.value.trim()))
    return { start: field.start, end: field.end, text: field.value, original: new Uint8Array(field.value.length).fill(1), hidden: harmless || (options.anonymised === true && madeUp) }
  })))
  return build(text, edits)
}
