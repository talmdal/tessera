// The neutral model as CSV, in a fixed column set.
//
// Fixed rather than profile-driven: an export is read by a spreadsheet or another finance program, neither of
// which has an opinion the user needs to express, and a writer that could emit any shape is a writer no
// reader can round-trip. RFC 4180 quoting, CRLF endings, and a UTF-8 BOM by default — without one, Excel reads
// a BOM-less UTF-8 file as the local code page and mangles every non-ASCII payee.
import { CSV_WRITE_COLUMNS, ExchangeError, type ExchangeDocument, type ExchangeTransaction } from '@tessera/exchange-api'

export interface CsvWriteOptions {
  delimiter: string
  /** Default true. */
  bom: boolean
}

export const CSV_WRITE_DEFAULTS: CsvWriteOptions = { delimiter: ',', bom: true }

/** Signed, plain, two decimals and no grouping: a figure another program can parse without a locale. */
export function csvAmount(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const magnitude = Math.abs(minor)
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`
}

/**
 * RFC 4180: a cell is quoted when it holds the delimiter, a quote, or a newline, and a quote inside one is
 * doubled. Quoting is about the file's structure only — it does not stop a spreadsheet running a formula, since
 * the quotes are gone by the time the cell is evaluated. That is `defuseText`'s job.
 */
export function csvCell(value: string | undefined, delimiter: string): string {
  const text = value ?? ''
  if (!text.includes(delimiter) && !text.includes('"') && !/[\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** A text cell a spreadsheet would evaluate: one starting `=`, `+`, `-`, `@`, a tab or a carriage return. */
export const FORMULA_START = /^[=+\-@\t\r]/

/**
 * A text value made safe to open in a spreadsheet. `=HYPERLINK(...)` as a payee is run as a formula by Excel,
 * quoted or not; a leading apostrophe makes it text, which is the defence spreadsheets themselves recognise.
 * Only for text columns — a negative amount is a number and must stay one. Tessera's own reader removes the
 * apostrophe again (`undefuseText`), so its exports still read back exactly.
 */
export const defuseText = (value: string | undefined) =>
  value !== undefined && FORMULA_START.test(value) ? `'${value}` : value

/** What a transaction's `Status` column says. Blank for an uncleared row, as the register shows it. */
const statusOf = (t: ExchangeTransaction) => t.cleared === 'reconciled' ? 'Reconciled' : t.cleared === 'cleared' ? 'Cleared' : ''

/** A transfer is written in its category column as `[Account]`, the one convention every program understands. */
const categoryOf = (t: ExchangeTransaction) => t.transferAccount !== undefined ? `[${t.transferAccount}]` : t.category

/**
 * The document as CSV: one account. The `Account` column names it, for anyone reading the file in a
 * spreadsheet; it does not let several accounts share a file, which the descriptor does not claim and which is
 * refused here too, for a caller that writes without going through the export service.
 *
 * The `Balance` column is a running total per account, recomputed here rather than carried: the model holds no
 * per-row balance, and a column that was blank for every row would be worse than no column at all.
 */
export function writeCsv(document: ExchangeDocument, options: Partial<CsvWriteOptions> = {}): Uint8Array {
  if (document.statements.length > 1) {
    throw new ExchangeError('NOT_WRITABLE',
      `A CSV file holds one account, and this would export ${document.statements.length}. Export them one at a time, or as QIF.`)
  }
  const { delimiter, bom } = { ...CSV_WRITE_DEFAULTS, ...options }
  const lines: string[] = [CSV_WRITE_COLUMNS.join(delimiter)]

  for (const statement of document.statements) {
    const account = statement.account.name ?? statement.account.number ?? ''
    // From the opening balance, so the last row's figure is the statement's closing one.
    const ledger = statement.balances?.ledger?.amount
    const total = statement.transactions.reduce((sum, t) => sum + t.amount, 0)
    let running = ledger === undefined ? 0 : ledger - total

    for (const t of statement.transactions) {
      running += t.amount
      lines.push([
        t.date,
        defuseText(t.number),
        defuseText(t.payee),
        defuseText(categoryOf(t)),
        defuseText(t.memo),
        csvAmount(t.amount),
        ledger === undefined ? '' : csvAmount(running),
        statusOf(t),
        defuseText(account)
      ].map(cell => csvCell(cell, delimiter)).join(delimiter))
    }
  }

  const text = `${lines.join('\r\n')}\r\n`
  return new TextEncoder().encode(bom ? `﻿${text}` : text)
}

/** `defuseText` undone: the apostrophe before a formula-like start, as Tessera's own export writes it. */
export const undefuseText = (value: string | undefined) =>
  value !== undefined && value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value
