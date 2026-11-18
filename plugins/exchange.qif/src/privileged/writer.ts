// The neutral model as QIF, in either flavour. Microsoft's writes names whole and dates as `M/D/YYYY`; the
// standard flavour cuts payee, memo and category at fifteen characters and writes `M/D'YY`. Both write `U`
// beside `T`, because some readers want it, and both come out as Windows-1252, which is what every program
// that reads QIF expects.
import type { ExchangeDocument, ExchangeStatement, ExchangeTransaction } from '@tessera/exchange-api'
import { qifTypeOf } from './values'

export type QifFlavour = 'standard' | 'microsoft'

export const STANDARD_LIMIT = 15

/**
 * A value as one line. A QIF record is one field per line, so a line break inside a payee or memo ended the
 * field there and the rest was read as fields of its own — `A\nT-999.00\n^` became a payee of "A", an amount
 * and the end of the record.
 */
export const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()

/** A text value as the flavour writes it: on one line, and cut to fifteen characters for the standard one. */
const cut = (text: string, flavour: QifFlavour) => {
  const flat = oneLine(text)
  return flavour === 'standard' ? flat.slice(0, STANDARD_LIMIT) : flat
}

/**
 * `M/D/YYYY` for Microsoft; `M/D'YY` for the standard, the apostrophe marking 2000 or later. The two-digit
 * forms only reach so far: a reader takes `/49` as 2049, so a year before 1950 — or after 2099 — is written in
 * full, which every QIF reader accepts.
 */
export function qifDate(iso: string, flavour: QifFlavour): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (flavour === 'microsoft') return `${m}/${d}/${y}`
  if (y >= 2000 && y <= 2099) return `${m}/${d}'${String(y).slice(2)}`
  if (y >= 1950 && y <= 1999) return `${m}/${d}/${String(y).slice(2)}`
  return `${m}/${d}/${y}`
}

/** Signed, grouped with commas, two decimals: what Quicken and Money both write. */
export function qifAmount(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const magnitude = Math.abs(minor)
  const whole = String(Math.floor(magnitude / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${whole}.${String(magnitude % 100).padStart(2, '0')}`
}

/** `Parent : Child` back to `Parent:Child`; a transfer as `[Account]`. */
function categoryLine(t: Pick<ExchangeTransaction, 'category' | 'transferAccount'>, flavour: QifFlavour): string | undefined {
  if (t.transferAccount !== undefined) return `[${cut(t.transferAccount, flavour)}]`
  if (t.category === undefined) return undefined
  return t.category.split(/\s*:\s*/).map(s => cut(s.trim(), flavour)).join(':')
}

function transactionLines(t: ExchangeTransaction, flavour: QifFlavour): string[] {
  const lines = [`D${qifDate(t.date, flavour)}`, `T${qifAmount(t.amount)}`, `U${qifAmount(t.amount)}`]
  if (t.cleared === 'cleared') lines.push('C*')
  if (t.cleared === 'reconciled') lines.push('CX')
  if (t.number !== undefined && oneLine(t.number) !== '') lines.push(`N${oneLine(t.number)}`)
  if (t.payee !== undefined && t.payee !== '') lines.push(`P${cut(t.payee, flavour)}`)
  if (t.memo !== undefined && t.memo !== '') lines.push(`M${cut(t.memo, flavour)}`)
  const category = categoryLine(t, flavour)
  if (category !== undefined) lines.push(`L${category}`)
  for (const split of t.splits ?? []) {
    lines.push(`S${categoryLine(split, flavour) ?? ''}`)
    if (split.memo !== undefined && split.memo !== '') lines.push(`E${cut(split.memo, flavour)}`)
    lines.push(`$${qifAmount(split.amount)}`)
  }
  lines.push('^')
  return lines
}

function statementLines(statement: ExchangeStatement, flavour: QifFlavour, withAccount: boolean): string[] {
  const type = qifTypeOf(statement.account.type)
  const lines: string[] = []
  if (withAccount) {
    lines.push('!Account', `N${oneLine(statement.account.name ?? 'Account')}`, `T${type}`)
    if (statement.account.number !== undefined) lines.push(`D${oneLine(statement.account.number)}`)
    lines.push('^')
  }
  lines.push(`!Type:${type}`)
  for (const t of statement.transactions) lines.push(...transactionLines(t, flavour))
  return lines
}

/**
 * The document as QIF. Several statements, or one with a name, get the whole-book form — an `!Account` block
 * before each `!Type:` list — which is what Quicken and Money read back as accounts. The category list, when
 * the document carries one, comes first, as those programs write it.
 */
export function writeQif(document: ExchangeDocument, flavour: QifFlavour = 'microsoft'): Uint8Array {
  const lines: string[] = []
  if (document.categories !== undefined && document.categories.length > 0) {
    lines.push('!Type:Cat')
    for (const category of document.categories) {
      lines.push(`N${category.path.split(/\s*:\s*/).map(s => cut(s, flavour)).join(':')}`, category.kind === 'income' ? 'I' : 'E', '^')
    }
  }
  const withAccount = document.statements.length > 1 || document.statements.some(s => s.account.name !== undefined)
  for (const statement of document.statements) lines.push(...statementLines(statement, flavour, withAccount))
  return encodeCp1252(lines.join('\r\n') + '\r\n')
}

/** Windows-1252, with a question mark for anything the code page cannot hold, as a real exporter writes. */
export function encodeCp1252(text: string): Uint8Array {
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
