// A delimited file as the neutral model, against a profile the user confirmed once and the book remembers.
//
// The reader asks at most one question — what the columns mean — and does so through `request`, so a file
// shape seen before is read without a dialog. Everything after that answer is a pure function of (bytes,
// profile), which is what makes the mapping dialog's live preview and this reader agree by construction.
import {
  csvProfileQuestionId, validateCsvProfile,
  type ExchangeDocument, type ExchangeQuestion, type ExchangeTransaction, type ExchangeWarning, type CsvProfile
} from '@tessera/exchange-api'
import type { Json } from '@tessera/types'
import { cellAt, decodeCsv, parseDelimited } from './delimited'
import { undefuseText } from './writer'
import { guessProfile, SAMPLE_ROWS } from './profile'
import { parseCsvAmount, parseCsvDate } from './values'

export interface CsvReadContext {
  formatId: string
  fileName: string
  /** Answers already settled — a saved profile arrives here, keyed by the question's id. */
  answers?: Readonly<Record<string, Json>>
  /** The one question this reader raises is `kind: 'csvProfile'`: what the columns mean. */
  request(question: ExchangeQuestion): Promise<Json>
  progress?(done: number, total: number): void
}

/**
 * The file, read. The profile comes from the caller's answers when a saved one matches this file's
 * fingerprint, and from the mapping dialog when none does.
 */
export async function readCsv(data: Uint8Array, context: CsvReadContext): Promise<ExchangeDocument> {
  const warnings: ExchangeWarning[] = []
  const { text, encoding } = decodeCsv(data)
  if (text.trim() === '') {
    return { formatId: context.formatId, statements: [], unsupported: [], warnings }
  }

  const guess = guessProfile(text, encoding, nameFor(context.fileName))
  const questionId = csvProfileQuestionId(guess.fingerprint)
  const saved = context.answers?.[questionId]

  let profile: CsvProfile
  if (saved !== undefined && validateCsvProfile(saved) === undefined) {
    // A shape seen before: read it without asking. The saved profile's encoding is not trusted over the
    // bytes in front of us — a bank that switched to UTF-8 should not be read as Windows-1252 forever.
    profile = { ...(saved as unknown as CsvProfile), encoding }
  } else {
    const answer = await context.request({
      kind: 'csvProfile',
      id: questionId,
      title: 'Match the columns',
      detail: `Tessera needs to know what each column of ${context.fileName} holds.`,
      sample: guess.sample,
      suggested: guess.profile as unknown as Json
    })
    const problem = validateCsvProfile(answer)
    if (problem !== undefined) throw new Error(problem)
    profile = { ...(answer as unknown as CsvProfile), encoding }
  }

  const { transactions, closingBalance } = readRows(text, profile, warnings, context.progress)
  const period = periodOf(transactions)

  return {
    formatId: context.formatId,
    dialect: profile.name,
    statements: [{
      account: {},
      ...(period !== undefined && { period }),
      ...(closingBalance !== undefined && period !== undefined && {
        balances: { ledger: { amount: closingBalance, asOf: period.to } }
      }),
      transactions
    }],
    unsupported: [],
    warnings
  }
}

export interface CsvRows {
  transactions: ExchangeTransaction[]
  /**
   * The balance column of the last row that had one, which is the statement's closing balance. Worth keeping:
   * it is what lets a first import of a new account set an opening balance that reconciles, and what the
   * review view's statement-difference line checks against.
   */
  closingBalance?: number
}

/** Every data row of the file as a transaction, with a warning for each row that could not be read. */
export function readRows(
  text: string,
  profile: CsvProfile,
  warnings: ExchangeWarning[],
  progress?: (done: number, total: number) => void
): CsvRows {
  const all = parseDelimited(text, profile.delimiter, profile.quote || '"')
  const body = all.slice(Math.max(0, profile.skip))
  const header = profile.header ? (body[0] ?? []) : []
  const rows = profile.header ? body.slice(1) : body

  const transactions: ExchangeTransaction[] = []
  const skipRows = profile.skipRows?.trim().toLowerCase()
  // 1-based, and counting the rows the profile skipped, so a warning names the line the user sees in Excel.
  const lineOf = (index: number) => Math.max(0, profile.skip) + (profile.header ? 1 : 0) + index + 1
  // The closing balance. A summary line (`Closing balance`) states it outright and wins. Otherwise it is the
  // balance on the *latest* row — by date, not by position: a bank that lists newest first puts its closing
  // balance on the first line, and taking the last line's reported the opening one against the closing date.
  let stated: number | undefined
  const running: { date: string, balance: number, index: number }[] = []
  const balanceIn = (row: string[]) => {
    const parsed = parseCsvAmount(cellAt(row, header, profile.columns.balance), profile.decimal)
    return parsed.ok ? parsed.minor : undefined
  }

  for (const [index, row] of rows.entries()) {
    progress?.(index + 1, rows.length)
    const line = lineOf(index)
    if (row.every(cell => cell.trim() === '')) continue
    // A `Closing balance` line is not a transaction, but it does carry the balance, which is worth having.
    if (skipRows !== undefined && skipRows !== '' && (row[0] ?? '').trim().toLowerCase().startsWith(skipRows)) {
      stated = balanceIn(row) ?? stated
      continue
    }

    const transaction = readRow(row, header, profile, line, warnings)
    if (transaction !== undefined) {
      transactions.push(transaction)
      const balance = balanceIn(row)
      if (balance !== undefined) running.push({ date: transaction.date, balance, index: running.length })
    }
  }
  const closingBalance = stated ?? latestBalance(running)
  return { transactions, ...(closingBalance !== undefined && { closingBalance }) }
}

/**
 * The balance on the latest-dated row. Rows on the same day are told apart by the file's own direction: in an
 * oldest-first file the last of them is the latest, in a newest-first file the first is.
 */
function latestBalance(rows: readonly { date: string, balance: number, index: number }[]): number | undefined {
  if (rows.length === 0) return undefined
  const newestFirst = rows[0].date > rows[rows.length - 1].date
  let best = rows[0]
  for (const row of rows.slice(1)) {
    if (row.date > best.date || (row.date === best.date && !newestFirst)) best = row
  }
  return best.balance
}

function readRow(
  row: string[],
  header: string[],
  profile: CsvProfile,
  line: number,
  warnings: ExchangeWarning[]
): ExchangeTransaction | undefined {
  const at = (column: string | number | undefined) => cellAt(row, header, column)
  const { columns } = profile
  // A text cell, with the apostrophe a spreadsheet-safe export puts before `=`, `+`, `-` or `@` taken off again.
  const text = (column: string | number | undefined) => undefuseText(at(column))

  const date = parseCsvDate(at(columns.date), profile.dateFormat)
  if (date === undefined) {
    warnings.push({
      code: 'date.unparsable',
      message: `Row ${line} was skipped: “${at(columns.date) ?? ''}” is not a date Tessera could read.`,
      source: { line }
    })
    return undefined
  }

  const amount = amountOf(row, header, profile)
  if (amount === undefined) {
    warnings.push({
      code: 'amount.unparsable',
      message: `Row ${line} was skipped: its amount could not be read.`,
      source: { line }
    })
    return undefined
  }

  return {
    date,
    amount,
    ...(text(columns.payee) !== undefined && { payee: text(columns.payee)! }),
    ...(text(columns.memo) !== undefined && { memo: text(columns.memo)! }),
    ...(text(columns.number) !== undefined && { number: text(columns.number)! }),
    ...(text(columns.category) !== undefined && { category: text(columns.category)!.split(/\s*:\s*/).join(' : ') }),
    ...(at(columns.externalId) !== undefined && { externalId: at(columns.externalId)! }),
    source: { line }
  }
}

/**
 * The row's amount, from one signed column or from a debit/credit pair. A debit lowers the balance, so it is
 * negative whatever sign the file wrote it with — a file that writes withdrawals as `25.00` in a Debit column
 * and one that writes `-25.00` must come out the same.
 */
function amountOf(row: string[], header: string[], profile: CsvProfile): number | undefined {
  const at = (column: string | number | undefined) => cellAt(row, header, column)
  const { columns, decimal } = profile

  if (columns.amount !== undefined) {
    const parsed = parseCsvAmount(at(columns.amount), decimal)
    if (!parsed.ok) return undefined
    return profile.debitsArePositive === true ? -parsed.minor : parsed.minor
  }

  const debit = parseCsvAmount(at(columns.debit), decimal)
  const credit = parseCsvAmount(at(columns.credit), decimal)
  // Exactly one of the pair is filled in on a given row; a row with neither is not a transaction.
  if (debit.ok && debit.minor !== 0) return -Math.abs(debit.minor)
  if (credit.ok && credit.minor !== 0) return Math.abs(credit.minor)
  if (debit.ok || credit.ok) return 0
  return undefined
}

/** The span the rows cover, which is the nearest thing a CSV has to a statement period. */
function periodOf(transactions: ExchangeTransaction[]): { from: string, to: string } | undefined {
  if (transactions.length === 0) return undefined
  const dates = transactions.map(t => t.date).sort()
  return { from: dates[0], to: dates[dates.length - 1] }
}

/** A readable default profile name from the file: `personal-savings-2026-10.csv` → `personal savings 2026 10`. */
function nameFor(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return base === '' ? 'Imported CSV' : base
}

export { SAMPLE_ROWS }
