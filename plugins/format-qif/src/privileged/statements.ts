// QIF records → statements. First the file's sections are sorted into accounts (`collect`): `!Account` sets the
// account for the transaction sections after it, Quicken's AutoSwitch list only names accounts, investment accounts
// and lists are left out. Then each account's records become lines (`readStatement`), once the file's date order and
// decimal separator are known: the opening-balance record Quicken and Money begin an account with becomes the
// statement's balance, `N` a cheque number or a kind, `L` a category hint or a transfer, and a split its total with the
// parts in the memo. See docs/import-formats-design.md, "Sections", "Fields" and "The account and its key".
import { MEMO_MAX_LENGTH, type AccountType } from '@tessera/accounts-api'
import {
  canonicalDecimal, fileNameStem,
  type DateOrder, type DecimalSeparator, type ParsedStatement, type ParseWarning, type StatementAccount, type StatementLine,
  type StatementLineKind
} from '@tessera/import-api'
import { qifDate } from './dates'
import { valueOf, type QifRecord, type QifSection } from './qif'

/** What an `!Account` record says. */
export interface QifAccount {
  name?: string
  /** Its `T` as written: 'Bank', 'CCard', 'Oth A', 'Invst'… */
  type?: string
  description?: string
}

/** One account's transaction records, as the file holds them. */
export interface RawStatement {
  account?: QifAccount
  /** The first transaction section's type: 'bank', 'ccard', 'cash', 'otha', 'othl'. */
  section: string
  records: QifRecord[]
  line: number
}

/** Transaction sections, by name, and the account type each suggests. */
const TRANSACTIONS: Record<string, AccountType> = {
  '!type:bank': 'chequing', '!type:ccard': 'creditCard', '!type:cash': 'cash', '!type:otha': 'otherAsset', '!type:othl': 'otherLiability'
}
/** `!Account` types, compared lower case without spaces. */
const ACCOUNT_TYPES: Record<string, AccountType> = {
  bank: 'chequing', ccard: 'creditCard', cash: 'cash', otha: 'otherAsset', othl: 'otherLiability'
}
/** `!Account` types of investment and retirement accounts, left out. */
const INVESTMENT = /^(invst|port|401\(?k\)?(\/403\(?b\)?)?|403\(?b\)?|mutual|brokerage|ira|rrsp|tfsa|rrif|resp)$/
/** Lists and settings: not transactions, left out quietly. */
const LISTS = new Set(['!type:cat', '!type:class', '!type:memorized', '!type:prices', '!type:security', '!type:bill', '!type:invoice', '!type:tag', '!type:budget'])

const compact = (text: string | undefined) => (text ?? '').toLowerCase().replace(/\s+/g, '')

/** True for an `!Account` type of an investment or retirement account. */
export const isInvestment = (type: string | undefined) => INVESTMENT.test(compact(type))

/** Sorts a file's sections into statements, with a warning for each part left out. */
export function collect(sections: readonly QifSection[]): { statements: RawStatement[], warnings: ParseWarning[] } {
  const statements: RawStatement[] = []
  const warnings: ParseWarning[] = []
  const warned = new Set<string>()
  const warnOnce = (key: string, warning: ParseWarning) => { if (!warned.has(key)) { warned.add(key); warnings.push(warning) } }
  let account: QifAccount | undefined
  let autoSwitch = false
  let current: RawStatement | undefined

  for (const section of sections) {
    const name = section.name
    if (name === '!option:autoswitch') { autoSwitch = true; continue }
    if (name === '!clear:autoswitch') { autoSwitch = false; continue }
    if (name === '!account') {
      // Within AutoSwitch, a list of the file's accounts; otherwise the account of the sections that follow
      if (autoSwitch) continue
      const record = section.records[section.records.length - 1]
      if (record) {
        account = { name: valueOf(record, 'N'), type: valueOf(record, 'T'), description: valueOf(record, 'D') }
        current = undefined
      }
      continue
    }
    if (name === '' && section.records.length > 0) {
      warnOnce('no-header', { message: 'Records before the file\'s first !Type line were left out.', line: section.line })
      continue
    }
    const isTransactions = name in TRANSACTIONS
    if (name === '!type:invst' || (isTransactions && isInvestment(account?.type))) {
      const label = account?.name ? `“${account.name}”` : 'in this file'
      warnOnce(`invst:${account?.name ?? ''}`, {
        message: `An investment account (${account?.name ? label : 'unnamed'}) was left out: Tessera doesn't import investment transactions yet.`,
        line: section.line
      })
      continue
    }
    if (LISTS.has(name) || name.startsWith('!option:') || name.startsWith('!clear:')) continue
    if (!isTransactions) {
      warnOnce(`unknown:${name}`, { message: `A section Tessera doesn't know (${section.header}) was left out.`, line: section.line })
      continue
    }
    // Sections under the same account are one statement; another account starts another
    if (!current || current.account !== account) {
      current = { ...(account && { account }), section: name.slice('!type:'.length), records: [], line: section.line }
      statements.push(current)
    }
    current.records.push(...section.records)
  }
  return { statements, warnings }
}

/** Payees of the record Quicken and Money begin an exported account with. */
const OPENING = /^(opening balance|solde d'ouverture|solde initial|solde d'ouverture du compte)$/i

/** The opening-balance record, when the statement starts with one: its payee says so, and its `L` names an account. */
export function openingRecord(raw: RawStatement): QifRecord | undefined {
  const first = raw.records[0]
  if (!first) return undefined
  const payee = valueOf(first, 'P')?.trim() ?? ''
  const category = valueOf(first, 'L')?.trim() ?? ''
  return OPENING.test(payee) && /^\[.+\]/.test(category) ? first : undefined
}

/** The account's name: its `!Account` `N`, or the account its opening-balance record names. */
export function accountName(raw: RawStatement): string | undefined {
  const named = raw.account?.name?.trim()
  if (named) return named
  const opening = openingRecord(raw)
  return opening ? /^\[(.+?)\]/.exec(valueOf(opening, 'L')!.trim())?.[1].trim() : undefined
}

/**
 * How the statement is known: by its account's name (`qif:account:<name>`), or, without one, by its file's name
 * (`qif:file:<stem>`). Weak either way: a name suggests an account, and QIF has no account number.
 */
export function identify(raw: RawStatement, fileName: string): StatementAccount & { key: string } {
  const name = accountName(raw)
  const fromAccount = raw.account?.type ? ACCOUNT_TYPES[compact(raw.account.type)] : undefined
  let type: AccountType = fromAccount ?? TRANSACTIONS[`!type:${raw.section}`] ?? 'chequing'
  if (type === 'chequing' && name && /sav(ings?)?\b|épargne|epargne/i.test(name)) type = 'savings'
  if (name) {
    return { key: `qif:account:${name.toLowerCase().replace(/\s+/g, ' ')}`, keyStrength: 'weak', name, label: name, type }
  }
  return { key: `qif:file:${fileNameStem(fileName) || 'statement'}`, keyStrength: 'weak', label: `${fileName} (no account name)`, type }
}

export interface ReadOptions {
  dateOrder: DateOrder
  decimal: DecimalSeparator
  pivot: number
  /** Negate every amount. */
  reversed: boolean
}

const negate = (canonical: string) => canonical.startsWith('-') ? canonical.slice(1) : /^0(\.0+)?$/.test(canonical) ? canonical : `-${canonical}`

/** An amount field as canonical, signed as the options say, or undefined. */
function amountOf(text: string | undefined, options: ReadOptions): string | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const canonical = canonicalDecimal(text.trim(), { decimal: options.decimal })
  return canonical === undefined ? undefined : options.reversed ? negate(canonical) : canonical
}

/** Sums canonical decimals exactly. */
function sum(amounts: readonly string[]): string {
  const decimals = Math.max(0, ...amounts.map(a => a.split('.')[1]?.length ?? 0))
  const units = amounts.reduce((total, a) => {
    const negative = a.startsWith('-')
    const [whole, fraction = ''] = a.replace(/^-/, '').split('.')
    const value = BigInt(whole + fraction.padEnd(decimals, '0'))
    return total + (negative ? -value : value)
  }, 0n)
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const text = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
  return negative ? `-${text}` : text
}

/** What `N` says: a cheque number, or a kind of line. */
function numberOf(n: string | undefined): { number?: string, kind?: StatementLineKind } {
  const value = n?.trim() ?? ''
  if (/^\d+$/.test(value)) return { number: value, kind: 'cheque' }
  const word = value.toLowerCase()
  if (word === 'atm') return { kind: 'atm' }
  if (word === 'dep' || word === 'deposit') return { kind: 'deposit' }
  if (['eft', 'xfer', 'txfr', 'transfer'].includes(word)) return { kind: 'transfer' }
  return {}
}

/** A category as written, without its class ('Food:Groceries/Business' → 'Food:Groceries'); undefined for none. */
const withoutClass = (text: string) => text.replace(/\/.*$/, '').trim()

/** A split's parts in words: 'Split: Food:Groceries 64.12 · Household 20.00'. */
function splitText(record: QifRecord, options: ReadOptions): string | undefined {
  const parts: { category: string, amount?: string }[] = []
  for (const field of record.fields) {
    if (field.code === 'S') parts.push({ category: withoutClass(field.value) || '(no category)' })
    else if (field.code === '$' && parts.length > 0) parts[parts.length - 1].amount = amountOf(field.value, options)
  }
  if (parts.length === 0) return undefined
  return `Split: ${parts.map(p => `${p.category}${p.amount !== undefined ? ` ${p.amount.replace(/^-/, '')}` : ''}`).join(' · ')}`
}

/** A statement's records as lines, with its key, its balance from the opening record, and what was left out. */
export function readStatement(raw: RawStatement, fileName: string, options: ReadOptions): { statement: ParsedStatement, warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  const account = identify(raw, fileName)
  const opening = openingRecord(raw)
  const lines: StatementLine[] = []
  for (const record of raw.records) {
    if (record === opening) continue
    const dateText = valueOf(record, 'D')
    const date = dateText === undefined ? undefined : qifDate(dateText, options.dateOrder, options.pivot)
    const amountText = valueOf(record, 'T') ?? valueOf(record, 'U')
    const amount = amountOf(amountText, options)
    if (!date) {
      warnings.push({ message: dateText === undefined ? 'Left out: a transaction without a date.' : `Left out: its date “${dateText}” can't be read.`, line: record.line })
      continue
    }
    if (amount === undefined) {
      warnings.push({ message: amountText === undefined ? 'Left out: a transaction without an amount.' : `Left out: its amount “${amountText}” can't be read.`, line: record.line })
      continue
    }
    const line: StatementLine = { date, amount }
    const payee = valueOf(record, 'P')?.trim()
    if (payee) line.payee = payee
    const { number, kind } = numberOf(valueOf(record, 'N'))
    if (number) line.number = number
    const category = valueOf(record, 'L')?.trim() ?? ''
    const split = splitText(record, options)
    const transfer = /^\[.+\]/.test(category)
    if (kind) line.kind = kind
    else if (transfer) line.kind = 'transfer'
    // A category hint, unless the line is a transfer or a split (whose total has no one category)
    if (!transfer && !split && withoutClass(category) !== '' && !/^--split--$/i.test(category)) line.category = withoutClass(category)
    const memo = [valueOf(record, 'M')?.trim(), split].filter(Boolean).join(' · ')
    if (memo) line.memo = memo.length > MEMO_MAX_LENGTH ? `${memo.slice(0, MEMO_MAX_LENGTH - 1)}…` : memo
    lines.push(line)
  }

  const statement: ParsedStatement = { account, lines }
  const openingAmount = opening ? amountOf(valueOf(opening, 'T') ?? valueOf(opening, 'U'), options) : undefined
  if (openingAmount !== undefined) {
    const openingDate = qifDate(valueOf(opening!, 'D') ?? '', options.dateOrder, options.pivot)
    const dates = lines.map(l => l.date).sort()
    const asOf = dates[dates.length - 1] ?? openingDate
    if (asOf) statement.balance = { amount: sum([openingAmount, ...lines.map(l => l.amount)]), asOf }
  }
  return { statement, warnings }
}

/** Every date and every amount a file's statements hold, to decide its date order and decimal separator. */
export function samplesOf(raws: readonly RawStatement[]): { dates: string[], amounts: string[] } {
  const dates: string[] = []
  const amounts: string[] = []
  for (const raw of raws) {
    for (const record of raw.records) {
      for (const field of record.fields) {
        if (field.code === 'D') dates.push(field.value)
        else if (field.code === 'T' || field.code === 'U' || field.code === '$') amounts.push(field.value)
      }
    }
  }
  return { dates, amounts }
}
