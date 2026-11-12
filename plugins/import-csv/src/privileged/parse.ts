// Reading a CSV file: its text, its rows, the layout remembered for files like it or a guess, the CSV Columns dialog
// (every file, filled in), then statements. What the dialog confirms is remembered for the file's signature, and each
// statement's key remembers which layout made it, so a reversal the user makes later (`correct`) lands on it.
// See docs/import-formats-design.md, "CSV", and "Phase F4".
import { createHash } from 'node:crypto'
import {
  ImportError,
  type FormatCorrection, type FormatMemory, type ImportFile, type ParseContext, type ParsedStatement, type ParseResult,
  type ParseWarning, type RememberedDescription, type StatementAccount
} from '@tessera/import-api'
import { pivotFor } from '../shared/cells'
import { isBlank, readCsv, valuesOf, type CsvRow, type Delimiter } from '../shared/csv'
import { LAYOUT_DIALOG, type LayoutDialogInput, type LayoutDialogResult, type LayoutStart } from '../shared/dialog'
import { dataWidth, fitOf } from '../shared/fit'
import { guessLayout, type LayoutGuess } from '../shared/guess'
import { problemsOf, ROLE_NAMES, rolesOf, signatureBasis, type CsvLayout } from '../shared/layout'
import { readLines, type CsvStatement } from '../shared/lines'

/** What is remembered for a signature. */
export interface RememberedLayout {
  layout: CsvLayout
  /** YYYY-MM-DD. */
  lastUsed: string
  /** Each column's name (the header's, or the role chosen), for Saved Import Choices. Since F6. */
  columns?: string[]
}

/** Memory keys. */
export const MEMORY = {
  layout: (signature: string) => `layout:${signature}`,
  /** Every signature remembered, to find a headerless file's layout when a column's shape changed. */
  signatures: 'signatures',
  /** Which layout made a statement key. */
  key: (key: string) => `key:${key}`
}

/** The dialog's text is cut at this many characters, at a row's end: the preview then counts that part. */
export const DIALOG_TEXT_LIMIT = 2_000_000

/** A layout's signature: SHA-256 of its basis, cut to 16 hex digits as fingerprints are. */
export const signatureOf = (guess: LayoutGuess): string =>
  createHash('sha256').update(signatureBasis(guess.layout, guess.header, guess.shapes)).digest('hex').slice(0, 16)

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/** Where the layout shown comes from, and what the dialog needs to say about it. */
async function startingPoint(rows: string[][], guess: LayoutGuess, signature: string, memory: FormatMemory, pivot: number) {
  let found = await memory.get<RememberedLayout>(MEMORY.layout(signature))
  let foundSignature = signature
  if (!found && !guess.layout.header) {
    // A headerless file whose columns' shapes changed (a month with no deposits leaves a column empty): a remembered
    // layout of the same width and separator that reads it
    const width = guess.width
    for (const other of (await memory.get<string[]>(MEMORY.signatures)) ?? []) {
      const candidate = await memory.get<RememberedLayout>(MEMORY.layout(other))
      if (!candidate || candidate.layout.header || candidate.layout.delimiter !== guess.layout.delimiter) continue
      if (dataWidth(rows, candidate.layout.skip) !== width) continue
      if (fitOf(rows, candidate.layout, pivot).fits) { found = candidate; foundSignature = other; break }
    }
  }
  if (!found) {
    const start: LayoutStart = guess.uncertain.length === 0 ? 'recognised' : 'guessed'
    return { signature: foundSignature, layout: guess.layout, start, uncertain: guess.uncertain }
  }
  const fit = fitOf(rows, found.layout, pivot)
  if (fit.fits) return { signature: foundSignature, layout: found.layout, start: 'remembered' as const, uncertain: [], lastUsed: found.lastUsed }
  if (fit.dateOrder) {
    return {
      signature: foundSignature, layout: { ...found.layout, dateOrder: fit.dateOrder }, start: 'dateOrderChanged' as const,
      uncertain: [{ field: 'dateOrder' as const, why: 'The dates no longer read in the order remembered for files like this.' }],
      lastUsed: found.lastUsed, previousDateOrder: found.layout.dateOrder
    }
  }
  return { signature: foundSignature, layout: found.layout, start: 'misfit' as const, uncertain: [], lastUsed: found.lastUsed, misfit: fit.reason }
}

/** A masked account number's last four: '4500********1234' → '1234'. */
const lastFour = (number: string) => number.replace(/[^\dA-Za-z]/g, '').slice(-4)

/** A statement's account: by its number when the file has an account column, otherwise by the file's layout. */
function accountOf(statement: CsvStatement, signature: string, layout: CsvLayout, header: readonly string[] | undefined, width: number): StatementAccount {
  if (statement.account !== undefined && statement.account !== '') {
    const number = statement.account
    return {
      key: `csv:account:${number}`, keyStrength: 'strong', accountNumber: number,
      ...(/[Xx*•#]/.test(number) && { numberIsPartial: true }),
      label: `Account •••• ${lastFour(number)} (CSV)`
    }
  }
  const roles = rolesOf(layout, width)
  const names = header && layout.header
    ? header.map(h => h.trim()).filter(h => h !== '')
    : roles.map(r => r ? ROLE_NAMES[r] : '(ignored)')
  return {
    key: `csv:layout:${signature}`, keyStrength: 'weak',
    label: header && layout.header ? `CSV file with columns ${names.join(', ')}` : `CSV file with ${width} columns: ${names.join(', ')}`
  }
}

/** The text the dialog is given: all of it, or its start, cut at a row's end. */
function dialogText(text: string, rows: CsvRow[]): { text: string, truncated: boolean } {
  if (text.length <= DIALOG_TEXT_LIMIT) return { text, truncated: false }
  const lastRow = [...rows].reverse().find(r => r.cells.length > 0 && r.cells[r.cells.length - 1].end <= DIALOG_TEXT_LIMIT)
  const end = lastRow ? lastRow.cells[lastRow.cells.length - 1].end : DIALOG_TEXT_LIMIT
  return { text: text.slice(0, end), truncated: true }
}

export interface CsvOptions {
  /** Today, for two-digit years and when a layout was last used. */
  now?: () => Date
}

/** Reads a CSV file, asking the user to confirm its layout. */
export async function parseCsvFile(file: ImportFile, context: ParseContext, options: CsvOptions = {}): Promise<ParseResult | undefined> {
  const now = options.now ?? (() => new Date())
  const text = file.text('auto')
  const { delimiter, rows: records } = readCsv(text)
  const rows = records.map(valuesOf)
  if (rows.every(isBlank)) throw new ImportError('UNREADABLE', `${file.name} is empty.`)
  const pivot = pivotFor(now())
  const guess = guessLayout(rows, { delimiter, pivot })
  const signature = signatureOf(guess)
  const start = await startingPoint(rows, guess, signature, context.memory, pivot)

  const shown = dialogText(text, records)
  const input: LayoutDialogInput = {
    fileName: file.name, text: shown.text, truncated: shown.truncated,
    layout: start.layout, start: start.start, uncertain: start.uncertain, pivot,
    ...(start.lastUsed && { lastUsed: start.lastUsed }),
    ...('misfit' in start && start.misfit && { misfit: start.misfit }),
    ...('previousDateOrder' in start && start.previousDateOrder && { previousDateOrder: start.previousDateOrder })
  }
  const answer = await context.prompt<LayoutDialogResult, LayoutDialogInput>(LAYOUT_DIALOG, input, { title: `CSV Columns: ${file.name}` })
  if (answer?.kind === 'skip') return undefined
  if (answer?.kind !== 'layout' || typeof answer.layout !== 'object' || answer.layout === null) {
    throw new ImportError('CANCELLED', 'The import was cancelled in the CSV Columns dialog.')
  }
  const layout = answer.layout

  // The layout confirmed may split the file on another separator
  const confirmedRows = layout.delimiter === delimiter ? records : readCsv(text, layout.delimiter as Delimiter).rows
  const values = layout.delimiter === delimiter ? rows : confirmedRows.map(valuesOf)
  const width = dataWidth(values, layout.skip + (layout.header ? 1 : 0))
  const problems = problemsOf(layout, width)
  if (problems.length > 0) throw new ImportError('UNREADABLE', `${file.name} can't be read with those columns: ${problems[0]}`)
  const read = readLines(values, layout, pivot)

  const statements: ParsedStatement[] = []
  const header = layout.header ? values[layout.skip]?.map(v => v.trim()) : undefined
  for (const statement of read.statements) {
    if (statement.currencies) {
      throw new ImportError('UNREADABLE', `${file.name} has ${statement.account ? `account ${statement.account}'s ` : ''}rows in more than one currency (${statement.currencies.join(', ')}). Export each currency separately.`)
    }
    const account = accountOf(statement, start.signature, layout, header, width)
    statements.push({
      account,
      ...(statement.currency && { currency: statement.currency }),
      ...(statement.balance && { balance: statement.balance }),
      ...(statement.repeatedIds && { stableIds: false }),
      lines: statement.lines.map(l => l.line)
    })
  }

  const warnings: ParseWarning[] = []
  for (const left of read.leftOut) {
    if (!left.quiet && !left.pending) warnings.push({ message: `Left out: ${left.reason}`, line: confirmedRows[left.row]?.line ?? left.row + 1 })
  }
  const pending = read.leftOut.filter(l => l.pending).length
  if (pending > 0) {
    warnings.push({ message: `${pending} pending ${pending === 1 ? 'transaction was' : 'transactions were'} left out; ${pending === 1 ? 'it' : 'they'}'ll come with a later export, once the bank posts ${pending === 1 ? 'it' : 'them'}.` })
  }
  if (read.statements.some(s => s.repeatedIds)) {
    warnings.push({ message: 'The bank ids in its id column repeat, so lines are recognised by their date, amount and payee instead.' })
  }

  // Remembered before returning: the layout for files like this one, and which layout made each statement's key
  const columns = header ? header.slice(0, width) : rolesOf(layout, width).map(r => r ? ROLE_NAMES[r] : '(ignored)')
  await context.memory.set(MEMORY.layout(start.signature), { layout, lastUsed: isoDay(now()), columns } satisfies RememberedLayout)
  const known = (await context.memory.get<string[]>(MEMORY.signatures)) ?? []
  if (!known.includes(start.signature)) await context.memory.set(MEMORY.signatures, [...known, start.signature])
  for (const statement of statements) await context.memory.set(MEMORY.key(statement.account.key!), start.signature)

  return { statements, warnings }
}

const ORDER_WORDS = { YMD: 'year first', MDY: 'month first', DMY: 'day first' } as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * What the format remembers, as Saved Import Choices lists it: each layout, by its columns. The signatures' list and
 * the statement keys' pointers are the format's own index, and aren't listed.
 */
export function describeCsvMemory(key: string, value: unknown): RememberedDescription | undefined {
  if (!key.startsWith('layout:')) return undefined
  const remembered = value as Partial<RememberedLayout> | undefined
  const layout = remembered?.layout
  if (!remembered || !layout?.columns) return undefined
  const columns = remembered.columns ?? rolesOf(layout, widthOf(layout)).map(r => r ? ROLE_NAMES[r] : '(ignored)')
  const day = remembered.lastUsed
  const used = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `last imported ${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}` : undefined
  const detail = [
    `dates ${ORDER_WORDS[layout.dateOrder] ?? layout.dateOrder}`,
    layout.decimal === ',' ? 'a comma for decimals' : undefined,
    layout.reversed ? 'amounts reversed' : undefined,
    layout.header ? undefined : 'no header',
    used
  ].filter(Boolean).join(' · ')
  return { what: 'CSV columns', source: columns.filter(c => c !== '').join(', '), detail: detail[0].toUpperCase() + detail.slice(1) }
}

/** How many columns a layout uses: one past the last it names. */
function widthOf(layout: CsvLayout): number {
  const c = layout.columns
  const used = [c.date, c.userDate, c.amount, c.debit, c.credit, c.direction?.column, c.payee, ...(c.memo ?? []), c.number, c.id,
    c.balance, c.status?.column, c.currency, c.account, c.category].filter((i): i is number => typeof i === 'number')
  return used.length === 0 ? 0 : Math.max(...used) + 1
}

/**
 * The sign cross-check reversed a statement's amounts, and the user asked for that to be remembered: the layout that
 * made the statement's key gets `reversed` flipped, so the next CSV Columns dialog shows it.
 */
export async function correctCsv(correction: FormatCorrection, memory: FormatMemory): Promise<boolean> {
  if (correction.kind !== 'signsReversed') return false
  const signature = correction.key.startsWith('csv:layout:')
    ? correction.key.slice('csv:layout:'.length)
    : await memory.get<string>(MEMORY.key(correction.key))
  if (!signature) return false
  const remembered = await memory.get<RememberedLayout>(MEMORY.layout(signature))
  if (!remembered) return false
  await memory.set(MEMORY.layout(signature), { ...remembered, layout: { ...remembered.layout, reversed: !remembered.layout.reversed } })
  return true
}
