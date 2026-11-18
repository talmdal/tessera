// QIF blocks as the neutral model: one statement per account for the whole-book form, one for a bare
// statement, the category list, and an honest count of what the file carries that Tessera has nowhere to put.
import type { Json } from '@tessera/types'
import {
  ExchangeError,
  type ExchangeDocument, type ExchangeQuestion, type ExchangeSplit, type ExchangeStatement,
  type ExchangeTransaction, type ExchangeWarning, type UnsupportedRecords
} from '@tessera/exchange-api'
import { decodeQif, field, splitQif, type QifBlock, type QifRecord } from './lines'
import {
  accountTypeOf, clearedOf, inferDateOrder, isSlashDate, parseQifAmount, parseQifDate, type DateOrder
} from './values'

/** The question the reader raises when the file's dates could be read either way. */
export const DATE_ORDER_QUESTION = 'exchange-qif.dateOrder'

export interface ReadQifOptions {
  formatId: string
  /** Settled by an option or a saved answer; absent means infer from the file, and ask if that fails. */
  dateOrder?: DateOrder
  /** Asks the user what the reader cannot infer. Without it an ambiguous file reads as M/D. */
  request?(question: ExchangeQuestion): Promise<Json>
  progress?(done: number, total: number): void
}

/** Names that may have been cut short by the exporting program: fifteen characters, the standard dialect's limit. */
export const STANDARD_TRUNCATION = 15

const TRANSACTION_BLOCK = /^!Type:(Bank|Cash|CCard|Oth A|Oth L)$/i
const UNSUPPORTED_BLOCK: Record<string, string> = {
  '!TYPE:INVST': 'investment', '!TYPE:PORT': 'investment', '!TYPE:MEMORIZED': 'memorised', '!TYPE:MEMORISED': 'memorised',
  '!TYPE:PRICES': 'prices', '!TYPE:BUDGET': 'budget', '!TYPE:SECURITY': 'security', '!TYPE:TAG': 'tag', '!TYPE:CLASS': 'class'
}

class Unsupported {
  private readonly counts = new Map<string, { count: number, detail?: string }>()
  add(kind: string, detail?: string, by = 1) {
    const found = this.counts.get(kind)
    if (found === undefined) this.counts.set(kind, { count: by, ...(detail !== undefined && { detail }) })
    else found.count += by
  }
  list(): UnsupportedRecords[] {
    return [...this.counts.entries()].map(([kind, { count, detail }]) => ({ kind, count, ...(detail !== undefined && { detail }) }))
  }
}

/** An account as the `!Account` list described it, before any transactions arrive for it. */
interface FileAccount {
  name: string
  rawType?: string
  statement: ExchangeStatement
  opening?: { amount: number, date: string }
}

export async function readQif(data: Uint8Array, options: ReadQifOptions): Promise<ExchangeDocument> {
  const warnings: ExchangeWarning[] = []
  const { text } = decodeQif(data)
  const blocks = splitQif(text, warnings)
  if (blocks.length === 0 || blocks.every(b => b.records.length === 0)) {
    throw new ExchangeError('UNREADABLE', 'This file holds no QIF records.')
  }

  const order = await settleDateOrder(blocks, options)
  const unsupported = new Unsupported()
  const accounts = new Map<string, FileAccount>()
  const categories: NonNullable<ExchangeDocument['categories']> = []
  const inOrder: FileAccount[] = []
  let current: FileAccount | undefined
  let defining = false   // between !Option:AutoSwitch and !Clear:AutoSwitch, !Account records define, not switch
  let anonymous: FileAccount | undefined
  const total = blocks.reduce((n, b) => n + b.records.length, 0)
  let done = 0

  const accountNamed = (name: string, rawType?: string): FileAccount => {
    const key = name.trim().toLowerCase()
    let found = accounts.get(key)
    if (found === undefined) {
      found = {
        name: name.trim(),
        statement: {
          account: { name: name.trim(), ...(accountTypeOf(rawType) !== undefined && { type: accountTypeOf(rawType)! }), ...(rawType !== undefined && { rawType }) },
          transactions: []
        }
      }
      accounts.set(key, found)
      inOrder.push(found)
    }
    if (rawType !== undefined) {
      found.rawType = rawType
      found.statement.account.rawType = rawType
      const type = accountTypeOf(rawType)
      if (type !== undefined) found.statement.account.type = type
    }
    return found
  }

  for (const block of blocks) {
    const control = block.control.toUpperCase()

    if (control === '!OPTION:AUTOSWITCH') { defining = true; continue }
    if (control === '!CLEAR:AUTOSWITCH') { defining = false; continue }

    if (control === '!ACCOUNT') {
      for (const record of block.records) {
        done += 1
        const name = field(record, 'N')
        if (name === undefined || name.trim() === '') {
          warnings.push({ code: 'record.malformed', message: 'An account record has no name and was skipped.', source: { line: record.line } })
          continue
        }
        const account = accountNamed(name, field(record, 'T'))
        // A statement balance and its date, when the list carries them, stand in for a closing balance
        const balance = parseQifAmount(field(record, '$'))
        const asOf = parseQifDate(field(record, '/'), order)
        if (balance.ok && asOf !== undefined) account.statement.balances = { ledger: { amount: balance.minor, asOf } }
        if (!defining) current = account
      }
      continue
    }

    if (control === '!TYPE:CAT') {
      for (const record of block.records) {
        done += 1
        const name = field(record, 'N')
        if (name === undefined || name.trim() === '') continue
        const kind = field(record, 'I') !== undefined ? 'income' : 'expense'
        categories.push({ path: categoryPath(name), kind })
      }
      continue
    }

    const unsupportedKind = UNSUPPORTED_BLOCK[control]
    if (unsupportedKind !== undefined) {
      unsupported.add(unsupportedKind, detailFor(unsupportedKind), block.records.length)
      done += block.records.length
      continue
    }

    if (control !== '' && !TRANSACTION_BLOCK.test(block.control)) {
      warnings.push({ code: 'record.malformed', message: `The section “${block.control}” is not one Tessera knows; its ${block.records.length} records were skipped.`, source: { line: block.line } })
      done += block.records.length
      continue
    }

    // Transactions, for the current account — or for an unnamed one when the file names none
    const typeWord = control === '' ? undefined : block.control.slice('!Type:'.length)
    const target = current ?? (anonymous ??= (() => {
      const made: FileAccount = { name: '', statement: { account: {}, transactions: [] } }
      inOrder.push(made)
      return made
    })())
    if (typeWord !== undefined && target.statement.account.type === undefined) {
      const type = accountTypeOf(typeWord)
      target.statement.account.rawType = typeWord
      if (type !== undefined) target.statement.account.type = type
    }

    for (const record of block.records) {
      done += 1
      options.progress?.(done, total)
      const read = readTransaction(record, order, target, warnings, unsupported)
      if (read !== undefined) target.statement.transactions.push(read)
    }
  }

  for (const account of inOrder) finish(account)

  const statements = inOrder.map(a => a.statement).filter(s => s.transactions.length > 0 || s.balances !== undefined)
  if (statements.length === 0) {
    throw new ExchangeError('EMPTY', 'This file holds no transactions.')
  }

  return {
    formatId: options.formatId,
    dialect: dialectOf(statements),
    statements,
    ...(categories.length > 0 && { categories }),
    ...(truncatedAt(statements) !== undefined && { truncatedAt: truncatedAt(statements) }),
    unsupported: unsupported.list(),
    warnings
  }
}

/**
 * The order of the file's slash dates: the caller's answer, else what the file itself settles, else the user
 * — shown two real dates from the file so they are choosing between "5 March" and "3 May", not patterns.
 */
async function settleDateOrder(blocks: QifBlock[], options: ReadQifOptions): Promise<DateOrder> {
  if (options.dateOrder !== undefined) return options.dateOrder
  const dates = blocks.flatMap(b => b.records.flatMap(r => r.fields.filter(f => f.code === 'D' || f.code === '/').map(f => f.value)))
  if (!dates.some(isSlashDate)) return 'mdy'   // ISO throughout: nothing to decide
  const inferred = inferDateOrder(dates)
  if (inferred !== undefined) return inferred
  if (options.request === undefined) return 'mdy'

  const examples = [...new Set(dates.filter(isSlashDate).map(d => d.trim()))].slice(0, 2)
  const show = (raw: string, order: DateOrder) => {
    const iso = parseQifDate(raw, order)
    return iso === undefined ? raw : new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  }
  const answer = await options.request({
    kind: 'choice',
    id: DATE_ORDER_QUESTION,
    title: 'How are the dates in this file written?',
    detail: `Every date in this file could be read either way; for example “${examples[0]}”.`,
    options: [
      { value: 'mdy', label: 'Month first (M/D/Y)', detail: examples.map(e => `${e} → ${show(e, 'mdy')}`).join('; ') },
      { value: 'dmy', label: 'Day first (D/M/Y)', detail: examples.map(e => `${e} → ${show(e, 'dmy')}`).join('; ') }
    ],
    suggested: 'mdy'
  })
  return answer === 'dmy' ? 'dmy' : 'mdy'
}

/** `Parent:Child` → `Parent : Child`, with any `/Class` dropped: classes have no home here yet. */
export function categoryPath(raw: string): string {
  const withoutClass = raw.replace(/\/.*$/, '')
  return withoutClass.split(':').map(s => s.trim()).filter(s => s !== '').join(' : ')
}

function readTransaction(
  record: QifRecord, order: DateOrder, account: FileAccount, warnings: ExchangeWarning[], unsupported: Unsupported
): ExchangeTransaction | undefined {
  const source = { line: record.line }
  const rawDate = field(record, 'D')
  const date = parseQifDate(rawDate, order)
  if (date === undefined) {
    warnings.push({ code: 'date.unparsable', message: `A transaction has no readable date (“${rawDate ?? 'none'}”) and was skipped.`, source })
    return undefined
  }
  // `T` is the amount; `U` repeats it in Quicken's files and stands in when `T` is missing
  const amount = parseQifAmount(field(record, 'T') ?? field(record, 'U'))
  if (!amount.ok) {
    warnings.push({ code: 'amount.unparsable', message: `The transaction of ${date} has no readable amount (“${field(record, 'T') ?? 'none'}”) and was skipped.`, source })
    return undefined
  }

  const payee = clean(field(record, 'P'))
  const memo = clean(field(record, 'M'))
  const number = clean(field(record, 'N'))
  const category = field(record, 'L')
  const target = categoryOrTransfer(category)
  const cleared = clearedOf(field(record, 'C'))
  const addresses = record.fields.filter(f => f.code === 'A').length
  if (addresses > 0) unsupported.add('address', 'Payee addresses are not stored.', addresses)

  // The opening balance, by convention: a payee of "Opening Balance" and a transfer to the account itself. It
  // is the account's starting figure, not a transaction — importing it would double every balance
  if (payee !== undefined && /^opening balance$/i.test(payee) && target?.transfer !== undefined &&
    (account.name === '' || target.transfer.toLowerCase() === account.name.toLowerCase())) {
    account.opening = { amount: amount.minor, date }
    return undefined
  }

  const splits = readSplits(record)
  return {
    date,
    amount: amount.minor,
    ...(payee !== undefined && { payee }),
    ...(memo !== undefined && { memo }),
    ...(number !== undefined && { number }),
    ...(target?.category !== undefined && { category: target.category }),
    ...(target?.transfer !== undefined && { transferAccount: target.transfer }),
    ...(splits.length > 0 && { splits }),
    ...(cleared !== undefined && { cleared }),
    source
  }
}

const clean = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** `[Savings]` is a transfer to that account; anything else is a category path, class dropped. */
function categoryOrTransfer(raw: string | undefined): { category?: string, transfer?: string } | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '') return undefined
  const transfer = /^\[(.+)\]$/.exec(value.replace(/\/.*$/, ''))
  if (transfer !== null) return { transfer: transfer[1].trim() }
  return { category: categoryPath(value) }
}

/** `S`, `E`, `$` repeating, in that order: each `S` starts a split, `E` and `$` fill the one started. */
function readSplits(record: QifRecord): ExchangeSplit[] {
  const splits: ExchangeSplit[] = []
  let open: ExchangeSplit | undefined
  for (const f of record.fields) {
    if (f.code === 'S') {
      open = { amount: 0 }
      const target = categoryOrTransfer(f.value)
      if (target?.category !== undefined) open.category = target.category
      if (target?.transfer !== undefined) open.transferAccount = target.transfer
      splits.push(open)
    } else if (f.code === 'E' && open !== undefined) {
      const memo = clean(f.value)
      if (memo !== undefined) open.memo = memo
    } else if (f.code === '$' && open !== undefined) {
      const amount = parseQifAmount(f.value)
      if (amount.ok) open.amount = amount.minor
    }
  }
  return splits
}

/** The period from the rows, and the closing balance from the opening record plus everything after it. */
function finish(account: FileAccount) {
  const statement = account.statement
  const dates = statement.transactions.map(t => t.date).sort()
  if (dates.length > 0) statement.period = { from: dates[0], to: dates[dates.length - 1] }
  if (account.opening !== undefined) {
    const sum = statement.transactions.reduce((n, t) => n + t.amount, 0)
    statement.balances = {
      ledger: { amount: account.opening.amount + sum, asOf: dates[dates.length - 1] ?? account.opening.date },
      ...(statement.balances?.available !== undefined && { available: statement.balances.available })
    }
  }
}

/**
 * What the file's names say about the dialect. The standard dialect cuts payees, memos and categories at
 * fifteen characters; Money's "strict" export cuts only the category segments and leaves payees whole. So the
 * dialect is read per field, and the one that matters to matching — payees — is what `truncatedAt` reports.
 */
export function dialectOf(statements: readonly ExchangeStatement[]): string {
  const payees = statements.flatMap(s => s.transactions.map(t => t.payee ?? ''))
  const categories = statements.flatMap(s => s.transactions.flatMap(t => (t.category ?? '').split(' : ')))
  const cut = (values: string[]) => values.length > 0 && values.every(v => v.length <= STANDARD_TRUNCATION) && values.some(v => v.length === STANDARD_TRUNCATION)
  const payeesCut = cut(payees)
  const categoriesCut = cut(categories)
  if (payeesCut) return 'QIF (standard dialect: names cut at 15 characters)'
  if (categoriesCut) return 'QIF (Microsoft dialect, categories cut at 15 characters)'
  return 'QIF (Microsoft dialect)'
}

/** Fifteen when the payees look truncated, so the matcher compares them by prefix; else nothing. */
export function truncatedAt(statements: readonly ExchangeStatement[]): number | undefined {
  const payees = statements.flatMap(s => s.transactions.map(t => t.payee ?? ''))
  const cut = payees.length > 0 && payees.every(p => p.length <= STANDARD_TRUNCATION) && payees.some(p => p.length === STANDARD_TRUNCATION)
  return cut ? STANDARD_TRUNCATION : undefined
}

const detailFor = (kind: string): string => {
  switch (kind) {
    case 'investment': return 'Tessera has no investment accounts yet.'
    case 'memorised': return 'Memorised transactions are Quicken’s own; the recurring plugin is the equivalent.'
    case 'class': return 'Classes have no home in Tessera yet.'
    case 'budget': return 'Budgets are not imported.'
    default: return 'Not representable in Tessera.'
  }
}
