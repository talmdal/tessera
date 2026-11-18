// Anonymising a CSV export. CSV is a family, not a format: the columns are read from the header when there is
// one and inferred from the cells when there is not, and each column is routed by its role. The file's own
// shape — delimiter, quoting, line endings, BOM, a title line or a total row — is kept, because the shape is
// what the CSV reader will be tested against.
import {
  Deriver, dateShiftDays, fakeAmountMinor, fakeMemo, fakePayee, isGenericBankingText, sameShape
} from './derive'
import type { PolicyCounts } from './ofx'

export type ColumnRole = 'date' | 'amount' | 'balance' | 'payee' | 'memo' | 'enum' | 'number' | 'account' | 'unknown'

export interface CsvAnonymized {
  output: Uint8Array
  text: string
  counts: PolicyCounts
  unrecognised: { tag: string, count: number }[]
  sensitive: Set<string>
  sensitiveTags: Map<string, string>
  /** Rows (data rows, header aside) and the fields per row, for the structure check. */
  shape: { rows: number, fields: number[] }
  columns: { name: string, role: ColumnRole }[]
  dateShiftDays: number
}

interface Cell { text: string, quoted: boolean }

const BOM = '\ufeff'

/** RFC 4180 rows, remembering which cells were quoted so they can be written back the same way. */
export function parseCsv(text: string, delimiter: string): Cell[][] {
  const rows: Cell[][] = []
  let row: Cell[] = []
  let cell = ''
  let quoted = false
  let inQuotes = false
  let at = 0
  const endCell = () => { row.push({ text: cell, quoted }); cell = ''; quoted = false }
  const endRow = () => { endCell(); rows.push(row); row = [] }
  while (at < text.length) {
    const char = text[at]
    if (inQuotes) {
      if (char === '"') {
        if (text[at + 1] === '"') { cell += '"'; at += 2; continue }
        inQuotes = false; at += 1; continue
      }
      cell += char; at += 1; continue
    }
    if (char === '"' && cell === '') { inQuotes = true; quoted = true; at += 1; continue }
    if (char === delimiter) { endCell(); at += 1; continue }
    if (char === '\r' && text[at + 1] === '\n') { endRow(); at += 2; continue }
    if (char === '\n') { endRow(); at += 1; continue }
    cell += char; at += 1
  }
  if (cell !== '' || row.length > 0 || quoted) endRow()
  return rows
}

const writeCell = (cell: Cell, delimiter: string) =>
  cell.quoted || /["\r\n]/.test(cell.text) || cell.text.includes(delimiter) ? `"${cell.text.replace(/"/g, '""')}"` : cell.text

/**
 * The delimiter of a whole file: the candidate that appears most often on some line among the first several.
 * Not the first line alone — with a bank's preamble that is a title like `Maple Trust Bank - Savings`, which may
 * hold no delimiter at all, or a different one, and the whole file was then split wrongly.
 */
export function delimiterOf(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 10)
  let best = ','
  let most = -1
  for (const candidate of [',', ';', '\t', '|']) {
    const count = Math.max(0, ...lines.map(line => line.split(candidate).length - 1))
    if (count > most) { most = count; best = candidate }
  }
  return best
}

export function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let most = -1
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1
    if (count > most) { most = count; best = candidate }
  }
  return best
}

// ---- Dates -------------------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

type DateStyle = 'ymd' | 'dmy' | 'mdy' | 'dMy' | 'Mdy'

/** Whether a cell is a date in one of the shapes bank exports use. */
export function looksLikeDate(text: string): boolean {
  const t = text.trim()
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t) ||
    /^\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}$/i.test(t) || /^[A-Za-z]{3}[- ]\d{1,2},?[- ]\d{4}$/i.test(t)
}

/** Which order a column's slash dates use: a first part above 12 settles D/M, a second above 12 settles M/D. */
function slashOrder(values: readonly string[]): 'dmy' | 'mdy' {
  for (const value of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}$/.exec(value.trim())
    if (m === null) continue
    if (Number(m[1]) > 12) return 'dmy'
    if (Number(m[2]) > 12) return 'mdy'
  }
  return 'mdy'
}

/** The date shifted by `days`, written back in the shape it came in. */
export function shiftCsvDate(text: string, days: number, slash: 'dmy' | 'mdy'): string {
  const t = text.trim()
  const lead = text.slice(0, text.length - text.trimStart().length)
  const trail = text.slice(text.trimEnd().length)
  const pad = (n: number) => String(n).padStart(2, '0')
  const shift = (y: number, m: number, d: number) => {
    const at = new Date(Date.UTC(y, m - 1, d))
    if (isNaN(at.getTime())) return undefined
    at.setUTCDate(at.getUTCDate() + days)
    return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() }
  }
  let m: RegExpExecArray | null
  if ((m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(t)) !== null) {
    const s = shift(Number(m[1]), Number(m[3]), Number(m[4]))
    return s === undefined ? text : `${lead}${s.y}${m[2]}${pad(s.m)}${m[2]}${pad(s.d)}${trail}`
  }
  if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})$/.exec(t)) !== null) {
    const [a, b] = [Number(m[1]), Number(m[3])]
    const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4])
    const s = slash === 'dmy' ? shift(year, b, a) : shift(year, a, b)
    if (s === undefined) return text
    const y = m[4].length === 2 ? String(s.y).slice(-2) : String(s.y)
    const [first, second] = slash === 'dmy' ? [s.d, s.m] : [s.m, s.d]
    return `${lead}${pad(first)}${m[2]}${pad(second)}${m[2]}${y}${trail}`
  }
  if ((m = /^(\d{1,2})([- ])([A-Za-z]{3})\2(\d{2,4})$/.exec(t)) !== null) {
    const month = MONTHS.indexOf(m[3].toUpperCase()) + 1
    const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4])
    const s = month === 0 ? undefined : shift(year, month, Number(m[1]))
    if (s === undefined) return text
    const name = MONTHS[s.m - 1]
    const cased = m[3] === m[3].toUpperCase() ? name : name[0] + name.slice(1).toLowerCase()
    return `${lead}${pad(s.d)}${m[2]}${cased}${m[2]}${m[4].length === 2 ? String(s.y).slice(-2) : s.y}${trail}`
  }
  if ((m = /^([A-Za-z]{3})[- ](\d{1,2}),?[- ](\d{4})$/.exec(t)) !== null) {
    const month = MONTHS.indexOf(m[1].toUpperCase()) + 1
    const s = month === 0 ? undefined : shift(Number(m[3]), month, Number(m[2]))
    if (s === undefined) return text
    const name = MONTHS[s.m - 1]
    const cased = m[1] === m[1].toUpperCase() ? name : name[0] + name.slice(1).toLowerCase()
    return `${lead}${cased} ${s.d}, ${s.y}${trail}`
  }
  return text
}

// ---- Amounts -----------------------------------------------------------------------------------

/** A cell that is money: digits with an optional sign, grouping, decimal point, parentheses or currency sign. */
export function looksLikeAmount(text: string): boolean {
  const t = text.trim()
  return t !== '' && /^[-+]?[$€£]?\(?[-+]?[$€£]?\d[\d,]*(\.\d+)?\)?-?$/.test(t)
}

/** Minor units of a money cell, two decimals assumed where the cell has none. */
export function amountMinor(text: string): number | undefined {
  const t = text.trim()
  if (!looksLikeAmount(t)) return undefined
  const negative = t.startsWith('-') || t.startsWith('(') || t.endsWith('-') || /^[$€£]-/.test(t)
  const digits = t.replace(/[^\d.]/g, '')
  const [whole, fraction = ''] = digits.split('.')
  const minor = Number(`${whole === '' ? '0' : whole}${fraction.padEnd(2, '0').slice(0, 2)}`)
  if (!Number.isSafeInteger(minor)) return undefined
  return negative ? -minor : minor
}

/** Minor units written the way the original cell was: its sign style, grouping, decimals and currency sign. */
export function formatLike(original: string, minor: number): string {
  const t = original.trim()
  const lead = original.slice(0, original.length - original.trimStart().length)
  const trail = original.slice(original.trimEnd().length)
  const parentheses = t.startsWith('(') && t.endsWith(')')
  const trailingMinus = t.endsWith('-')
  const currency = /[$€£]/.exec(t)?.[0] ?? ''
  const grouped = /\d,\d{3}/.test(t)
  const decimals = /\.(\d+)/.exec(t)?.[1].length ?? 0
  const magnitude = Math.abs(minor)
  let whole = String(Math.floor(magnitude / 100))
  if (grouped) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = decimals === 0 ? '' : `.${String(magnitude % 100).padStart(2, '0').padEnd(decimals, '0').slice(0, decimals)}`
  const body = `${currency}${whole}${fraction}`
  if (minor < 0) {
    if (parentheses) return `${lead}(${body})${trail}`
    if (trailingMinus) return `${lead}${body}-${trail}`
    return `${lead}-${body}${trail}`
  }
  return `${lead}${t.startsWith('+') ? '+' : ''}${body}${trail}`
}

// ---- Columns -----------------------------------------------------------------------------------

/** A header name's role, by the words banks use. */
export function roleOfHeader(name: string): ColumnRole {
  const n = name.replace(/^﻿/, '').trim().toLowerCase()
  if (n === '') return 'unknown'
  if (/\b(date|posted|dated)\b/.test(n)) return 'date'
  if (/balance|solde|running/.test(n)) return 'balance'
  if (/amount|montant|debit|credit|withdrawal|deposit|payment|charge|\bcad\b|\busd\b|\$/.test(n)) return 'amount'
  if (/^(sub[- ]?)?(memo|notes?|details?|sub[- ]?description|additional)/.test(n)) return 'memo'
  if (/\b(type|category|status|kind|class)\b/.test(n)) return 'enum'
  if (/description|payee|name|merchant|particulars|narrative|transaction$/.test(n)) return 'payee'
  if (/account/.test(n)) return 'account'
  if (/cheque|check|ref|number|no\.?$|num$|serial/.test(n)) return 'number'
  return 'unknown'
}

/**
 * Where the table's header row is, looking past a bank's preamble: the first of the opening rows that reads as a
 * header *and* names both a date column and a money column. A preamble line ("Account Holder:,JOHN SMITH") has
 * no date or amount in it either, so `isHeaderRow` alone took it for the header and the real header became data.
 * Falls back to the first row when nothing names those columns, and to none when the first row is data.
 */
export function headerIndex(rows: readonly Cell[][]): number {
  for (const [at, row] of rows.slice(0, 10).entries()) {
    if (!isHeaderRow(row)) continue
    const roles = row.map(c => roleOfHeader(c.text))
    if (roles.includes('date') && (roles.includes('amount') || roles.includes('balance'))) return at
  }
  return rows.length > 0 && isHeaderRow(rows[0]) ? 0 : -1
}

/** Whether the first row is a header: nothing in it reads as a date or money, and at least two cells are words. */
export function isHeaderRow(row: readonly Cell[]): boolean {
  const words = row.filter(c => /[A-Za-z]{3,}/.test(c.text)).length
  const typed = row.filter(c => looksLikeDate(c.text) || looksLikeAmount(c.text)).length
  return typed === 0 && words >= 2
}

/** Column roles from the cells themselves, for a file with no header. */
function inferRoles(rows: readonly Cell[][], width: number): ColumnRole[] {
  const roles: ColumnRole[] = []
  let textSeen = 0
  const numeric: number[] = []
  for (let col = 0; col < width; col += 1) {
    const values = rows.map(r => r[col]?.text ?? '').filter(v => v.trim() !== '')
    if (values.length > 0 && values.every(looksLikeDate)) { roles.push('date'); continue }
    if (values.length > 0 && values.every(looksLikeAmount)) { roles.push('amount'); numeric.push(col); continue }
    if (values.length === 0) { roles.push('amount'); continue }   // an always-empty column beside amounts: a credit column with no credits
    roles.push(textSeen === 0 ? 'payee' : 'memo')
    textSeen += 1
  }
  // The last numeric column is the balance when it runs: each value is the one before plus or minus the row's movement
  const last = numeric[numeric.length - 1]
  if (last !== undefined && numeric.length >= 2 && columnSigns(rows, numeric.slice(0, -1), last) !== undefined) roles[last] = 'balance'
  return roles
}

/**
 * How each amount column moves the balance: +1 when its values add to it (a signed amount, a credit column), -1
 * when they are magnitudes of money leaving (a debit column). Settled by the rows themselves — the row's balance
 * less the previous one, against the column's value — so a header is not needed, and a header that lies does
 * not matter. Undefined when no column runs with the balance at all.
 */
export function columnSigns(rows: readonly Cell[][], amounts: readonly number[], balance: number): Map<number, 1 | -1> | undefined {
  const votes = new Map<number, { plus: number, minus: number }>()
  let previous: number | undefined
  for (const row of rows) {
    const b = amountMinor(row[balance]?.text ?? '')
    if (b !== undefined && previous !== undefined) {
      const delta = b - previous
      const present = amounts.filter(c => amountMinor(row[c]?.text ?? '') !== undefined)
      // Only a row with one amount says anything certain about that column's direction
      if (present.length === 1) {
        const value = amountMinor(row[present[0]].text)!
        const vote = votes.get(present[0]) ?? { plus: 0, minus: 0 }
        if (delta === value) vote.plus += 1
        else if (delta === -value) vote.minus += 1
        votes.set(present[0], vote)
      }
    }
    if (b !== undefined) previous = b
  }
  if ([...votes.values()].every(v => v.plus === 0 && v.minus === 0)) return undefined
  const signs = new Map<number, 1 | -1>()
  for (const c of amounts) {
    const vote = votes.get(c)
    signs.set(c, vote === undefined || vote.plus >= vote.minus ? 1 : -1)
  }
  return signs
}

// ---- The rewrite --------------------------------------------------------------------------------

export function anonymizeCsv(data: Uint8Array, options: { seed: Uint8Array, keepAmounts?: boolean }): CsvAnonymized {
  const derive = new Deriver(options.seed)
  const shift = dateShiftDays(derive)
  let utf8 = true
  let text: string
  // `TextDecoder` strips a BOM itself, so it is read from the bytes
  const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { utf8 = false; text = new TextDecoder('windows-1252').decode(data) }
  if (text.startsWith(BOM)) text = text.slice(1)
  const crlf = text.includes('\r\n')
  const trailingNewline = /\r?\n$/.test(text)
  const delimiter = delimiterOf(text)
  const rows = parseCsv(text, delimiter)

  const counts: PolicyCounts = { structural: 0, enum: 0, synthetic: 0, shifted: 0, drop: 0 }
  const unrecognised = new Map<string, number>()
  const sensitive = new Set<string>()
  const sensitiveTags = new Map<string, string>()
  const bump = (key: string) => unrecognised.set(key, (unrecognised.get(key) ?? 0) + 1)
  let currentColumn = ''
  const remember = (value: string) => {
    const v = value.trim()
    if (v.length < 4) return
    sensitive.add(v)
    if (!sensitiveTags.has(v)) sensitiveTags.set(v, currentColumn)
  }

  const at = headerIndex(rows)
  // The lines above the header: a bank's title, the account holder, the period. See `preambleCell`.
  const preamble = at > 0 ? rows.slice(0, at) : []
  const header = at === -1 ? undefined : rows[at]
  const body = at === -1 ? rows : rows.slice(at + 1)
  const width = Math.max(...body.map(r => r.length), header?.length ?? 0)
  // The rows with the header's width are the table; a title line or a total row is irregular
  const regular = body.filter(r => r.length === width)

  const roles: ColumnRole[] = header !== undefined
    ? header.map(c => roleOfHeader(c.text))
    : inferRoles(regular, width)
  if (header !== undefined && !roles.includes('balance')) {
    // A header that names no balance may still carry one under another word
    const numeric = roles.map((r, i) => r === 'amount' ? i : -1).filter(i => i >= 0)
    if (numeric.length >= 2) {
      const last = numeric[numeric.length - 1]
      if (columnSigns(regular, numeric.slice(0, -1), last) !== undefined) roles[last] = 'balance'
    }
  }
  const dateCols = roles.map((r, i) => r === 'date' ? i : -1).filter(i => i >= 0)
  const slash = slashOrder(regular.flatMap(r => dateCols.map(c => r[c]?.text ?? '')))
  const amountCols = roles.map((r, i) => r === 'amount' ? i : -1).filter(i => i >= 0)
  const balanceCol = roles.indexOf('balance')
  const signs = balanceCol === -1 ? undefined : columnSigns(regular, amountCols, balanceCol)

  // Everything the file says in words, so no fake can contain any of it
  const avoid = new Set<string>()
  for (const row of body) for (const cell of row) {
    const v = cell.text.trim().toLowerCase()
    if (v.length >= 4 && /[a-z]/.test(v) && !looksLikeDate(v) && !looksLikeAmount(v) && !isGenericBankingText(v)) avoid.add(v)
  }

  // Amounts first, so the balance can be rebuilt from them
  const fakeMinor = (minor: number) => options.keepAmounts === true ? minor : fakeAmountMinor(derive, minor)
  const out: Cell[][] = []
  for (const row of preamble) {
    out.push(row.map((cell, i) => {
      currentColumn = `preamble #${i + 1}`
      const result = preambleCell(cell.text, { derive, shift, slash, remember })
      if (result.personal) counts.synthetic += 1
      else if (result.shifted) counts.shifted += 1
      else counts.structural += 1
      return { ...cell, text: result.text }
    }))
  }
  if (header !== undefined) {
    // Default deny, as for every other cell. A header is only passed through when it is a column name this
    // policy recognises *and* carries no digits: a bank's preamble line ("Account Holder:,JOHN SMITH,Acct
    // 0012-3456789") has no date or amount, so it reads as a header, and copying it verbatim would commit the
    // holder's name and account number. Even a recognised name is suspect if it has digits in it ("Account
    // 0012-3456789" is the `account` role). Anything else is replaced with a neutral name and remembered.
    out.push(header.map((c, i) => {
      const name = c.text.replace(/^﻿/, '').trim()
      currentColumn = `header #${i + 1}`
      if (name === '' || (roles[i] !== 'unknown' && !/\d/.test(name)) || isGenericBankingText(name)) {
        counts.structural += 1
        return { ...c }
      }
      counts.synthetic += 1
      remember(name)
      return { ...c, text: `Column ${i + 1}` }
    }))
    for (const [i, role] of roles.entries()) if (role === 'unknown') bump(`column:#${i + 1}`)
  } else {
    for (const [i, role] of roles.entries()) if (role === 'unknown') bump(`column:#${i + 1}`)
  }

  let running: number | undefined
  let opening: number | undefined
  for (const row of body) {
    const irregular = row.length !== width
    const written: Cell[] = []
    let moved = 0
    for (const [i, cell] of row.entries()) {
      const role: ColumnRole = irregular ? (looksLikeDate(cell.text) ? 'date' : looksLikeAmount(cell.text) ? 'amount' : 'unknown') : roles[i]
      currentColumn = irregular ? 'irregular row' : (header?.[i]?.text.replace(/^\ufeff/, '').trim() || `column #${i + 1}`)
      const t = cell.text
      if (t.trim() === '') { written.push({ ...cell }); counts.structural += 1; continue }
      switch (role) {
        case 'date':
          counts.shifted += 1
          written.push({ ...cell, text: shiftCsvDate(t, shift, slash) })
          break
        case 'amount': {
          const minor = amountMinor(t)
          if (minor === undefined) { remember(t); counts.drop += 1; written.push({ ...cell, text: '' }); break }
          counts.shifted += 1
          const fake = fakeMinor(minor)
          moved += (signs?.get(i) ?? 1) * fake
          written.push({ ...cell, text: formatLike(t, fake) })
          break
        }
        case 'balance':
          // A balance that does not parse — `12,345.67 CR`, a currency suffix — cannot be rebuilt from the fake
          // amounts below, so the placeholder would be the real figure. Dropped and remembered, as an
          // unparsable amount is.
          if (amountMinor(t) === undefined) { remember(t); counts.drop += 1; written.push({ ...cell, text: '' }); break }
          counts.shifted += 1
          written.push({ ...cell, text: t })   // placeholder; rebuilt below
          break
        case 'payee':
          if (isGenericBankingText(t)) { counts.enum += 1; written.push({ ...cell }); break }
          counts.synthetic += 1; remember(t)
          written.push({ ...cell, text: fakePayee(derive, t, avoid) })
          break
        case 'memo':
          // A CSV's second text column often carries the merchant and its store number: keep that shape too
          if (isGenericBankingText(t)) { counts.enum += 1; written.push({ ...cell }); break }
          counts.synthetic += 1; remember(t)
          written.push({ ...cell, text: fakePayee(derive, t, avoid) })
          break
        case 'enum':
          if (/^[A-Za-z][A-Za-z /&.-]{0,30}$/.test(t.trim())) { counts.enum += 1; written.push({ ...cell }) }
          else { counts.synthetic += 1; remember(t); written.push({ ...cell, text: sameShape(derive, 'enum', t) }) }
          break
        case 'number':
          counts.synthetic += 1; remember(t)
          written.push({ ...cell, text: sameShape(derive, 'reference', t) })
          break
        case 'account':
          counts.synthetic += 1; remember(t)
          written.push({ ...cell, text: sameShape(derive, 'account', t) })
          break
        case 'unknown':
        default:
          // Text nobody has a rule for: replaced wholesale, kept as a column, reported. A title line's words go the same way
          counts.synthetic += 1; remember(t)
          if (irregular) bump('irregular-row text')
          written.push({ ...cell, text: fakeMemo(derive, t, avoid) })
      }
    }
    if (!irregular && balanceCol !== -1 && options.keepAmounts !== true) {
      const original = amountMinor(row[balanceCol]?.text ?? '')
      if (original !== undefined) {
        if (running === undefined) {
          // The opening figure: the real one's magnitude bucket, so the file still looks like the account it was
          opening = fakeMinor(original - moved || 1)
          running = opening
        }
        running += moved
        written[balanceCol] = { ...written[balanceCol], text: formatLike(row[balanceCol].text, running) }
      }
    }
    out.push(written)
  }

  const lines = out.map(row => row.map(c => writeCell(c, delimiter)).join(delimiter))
  const ending = crlf ? '\r\n' : '\n'
  const rendered = (bom ? BOM : '') + lines.join(ending) + (trailingNewline ? ending : '')
  const output = utf8 ? new TextEncoder().encode(rendered) : encodeCp1252(rendered)
  return {
    output,
    text: rendered,
    counts,
    unrecognised: [...unrecognised.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    sensitive,
    sensitiveTags,
    shape: { rows: body.length, fields: body.map(r => r.length) },
    columns: roles.map((role, i) => ({ name: header?.[i]?.text.replace(/^﻿/, '').trim() ?? `#${i + 1}`, role })),
    dateShiftDays: shift
  }
}

function encodeCp1252(text: string): Uint8Array {
  const decoder = new TextDecoder('windows-1252')
  const table = new Map<string, number>()
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(new Uint8Array([byte]))
    if (!table.has(char)) table.set(char, byte)
  }
  const out = new Uint8Array(text.length)
  let at = 0
  for (const char of text) out[at++] = table.get(char) ?? 0x3f
  return out.subarray(0, at)
}

/** The structure of a CSV, for the check after writing: rows and the fields in each. */
export function csvShape(data: Uint8Array): { rows: number, fields: number[], header: boolean } {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { text = new TextDecoder('windows-1252').decode(data) }
  if (text.startsWith(BOM)) text = text.slice(1)
  const rows = parseCsv(text, delimiterOf(text))
  // The same header detection as the anonymiser, so a preamble is not compared as though it were data.
  const at = headerIndex(rows)
  const body = at === -1 ? rows : rows.slice(at + 1)
  return { rows: body.length, fields: body.map(r => r.length), header: at !== -1 }
}

/**
 * Words a preamble line uses to label what it says — "Account Holder:", "Statement Period", "Page 1 of 2" — on
 * top of the generic banking words. Neither kind identifies anyone; anything else might be a name, and is not
 * kept.
 */
const PREAMBLE_WORDS = new Set((
  'holder holders name names period periods page pages of number no acct account accounts transit institution ' +
  'customer client summary details detail history activity report generated as at for between ending ended ' +
  'starting start end through thru date dates currency type types statement statements from to and or on by'
).split(/\s+/))

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december']
const MONTH_PATTERN = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/**
 * A date written with a month name — `October 2026`, `Oct 1, 2026`, `1 October 2026`, or a bare `October` —
 * shifted by the same number of days as every other date, and written back in the same form and case. A
 * preamble's `Statement Period: October 2026` kept as written gave the real month away beside rows that had
 * all been moved to another one.
 */
function shiftMonthDate(match: string, before: string | undefined, month: string, after: string | undefined, year: string | undefined, days: number): string {
  const dayText = before ?? after
  const m = MONTH_NAMES.findIndex(name => name.startsWith(month.toLowerCase().slice(0, 3)))
  // A missing part is filled only to do the arithmetic: the 15th, so a shift of a few days keeps the month
  // honest, and a year that is not a leap year's edge.
  const at = new Date(Date.UTC(year === undefined ? 2001 : Number(year), m, dayText === undefined ? 15 : Number(dayText)))
  at.setUTCDate(at.getUTCDate() + days)
  const full = MONTH_NAMES[at.getUTCMonth()]
  let name = month.length > 3 && !/^sept$/i.test(month) ? full : full.slice(0, 3)
  if (month === month.toUpperCase()) name = name.toUpperCase()
  else if (month[0] === month[0].toUpperCase()) name = name[0].toUpperCase() + name.slice(1)
  const day = String(at.getUTCDate())
  const dot = /\./.test(match.slice(match.indexOf(month) + month.length, match.indexOf(month) + month.length + 1)) ? '.' : ''
  const comma = /,/.test(match) ? ',' : ''
  const y = year === undefined ? '' : ` ${at.getUTCFullYear()}`
  if (before !== undefined) return `${day} ${name}${dot}${comma}${y}`
  if (after !== undefined) return `${name}${dot} ${day}${comma}${y}`
  return `${name}${dot}${comma}${y}`
}

/** Dates in a preamble, in the shapes `looksLikeDate` knows: these are shifted, never kept. */
const PREAMBLE_PIECES = new RegExp(
  // A month-name date first, so its month word and its numbers are taken together as a date
  `(?:(\\d{1,2})\\s+)?\\b${MONTH_PATTERN}\\b\\.?(?:\\s+(\\d{1,2})(?!\\d))?,?(?:\\s+(\\d{4}))?` +
  '|(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4})' +
  "|(\\d(?:[\\d -]*\\d)?)|([A-Za-z][A-Za-z']*)", 'gi')

/**
 * One cell of a preamble line, kept as the bank wrote it unless it carries personal information.
 *
 * A preamble is mostly a title — `Maple Trust Bank - Savings - 2026-10-01 to 2026-10-31` — and anonymising it
 * wholesale turned a useful fixture into noise. So it is read a piece at a time: dates are shifted (real dates
 * are something this tool hides, wherever they appear); a run of three or more digits that is not a date or a
 * year is an account, transit or card number and is replaced; and a word that is neither a banking word nor a
 * preamble label might be a name and is replaced. Everything else stays, so `Account Holder: JOHN SMITH`
 * keeps its label. A replaced piece is remembered, so verification would catch it surviving anywhere else.
 */
export function preambleCell(
  text: string,
  context: { derive: Deriver, shift: number, slash: 'dmy' | 'mdy', remember: (value: string) => void }
): { text: string, personal: boolean, shifted: boolean } {
  let personal = false
  let shifted = false
  const out = text.replace(PREAMBLE_PIECES, (
    piece: string, before?: string, month?: string, after?: string, year?: string,
    date?: string, digits?: string, word?: string
  ) => {
    if (month !== undefined) { shifted = true; return shiftMonthDate(piece, before, month, after, year, context.shift) }
    if (date !== undefined) { shifted = true; return shiftCsvDate(date, context.shift, context.slash) }
    if (digits !== undefined) {
      const bare = digits.replace(/[ -]/g, '')
      if (bare.length < 3 || /^(19|20)\d{2}$/.test(bare)) return piece
      personal = true
      context.remember(digits)
      return sameShape(context.derive, 'account', digits)
    }
    if (word !== undefined) {
      if (PREAMBLE_WORDS.has(word.toLowerCase()) || isGenericBankingText(word)) return piece
      personal = true
      context.remember(word)
      return sameShape(context.derive, 'name', word)
    }
    return piece
  })
  if (personal) context.remember(text)
  return { text: out, personal, shifted }
}
