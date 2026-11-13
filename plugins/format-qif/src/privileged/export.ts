// Writing QIF: standard QIF, as Quicken defined it and every QIF reader takes, not Microsoft Money's looser dialect
// (which leaves out `!Account` and writes dates however Windows is set). One account, or a whole ledger with Quicken's
// account list (`!Option:AutoSwitch`) and category list (`!Type:Cat`). Each account starts with its opening balance as
// Quicken and Money write it (`POpening Balance`, `L[<the account>]`), which this plugin's own reader takes as the
// statement's balance. Dates have four-digit years. Standard QIF keeps the first 15 characters of a category's or an
// account's name, and 32 of a payee's: a cut payee's whole text is kept at the start of the memo, but cut names read
// back cut. Two accounts whose names would be one once cut can't be exported together. An account with nothing in the
// range isn't written. Pure: data in, bytes out. See docs/export-design.md, "QIF".
import type { AccountType } from '@tessera/accounts-api'
import {
  encodeText,
  type ExportAccount, type ExportCheck, type ExportData, type ExportFormat, type ExportFormatContribution, type ExportOptions,
  type ExportOutput, type ExportTransaction, type TextEncoding
} from '@tessera/export-api'

export const QIF_EXPORT_SERVICE = 'format-qif.export'

/** Lengths standard QIF keeps to. */
export const QIF_LIMITS = {
  /** A payee: a longer one is cut, and kept whole at the start of the memo. */
  payee: 32,
  /**
   * A category's name (each level of its path) or an account's: a longer one is cut. Microsoft Money's standard
   * ("strict") QIF: "Only the first 15 characters of category names and other names will be exported."
   */
  name: 15
} as const

export const QIF_EXPORT: ExportFormatContribution = {
  id: 'format-qif.qif',
  label: 'QIF file (Quicken, Microsoft Money, GnuCash)',
  extension: 'qif',
  service: QIF_EXPORT_SERVICE,
  description: 'Moves whole accounts, or a whole ledger, to Quicken, Money, GnuCash or another Tessera ledger: categories, transfers, statuses and opening balances.',
  order: 20,
  accounts: 'many',
  options: [
    {
      kind: 'choice', key: 'dates', label: 'Date format', default: 'mdy',
      options: [
        { value: 'mdy', label: 'Month/day/year (10/05/2026)', description: 'As Quicken and Money write them in North America.' },
        { value: 'dmy', label: 'Day/month/year (05/10/2026)', description: 'For a program set to read dates day first.' }
      ]
    },
    {
      kind: 'choice', key: 'encoding', label: 'Characters', default: 'windows-1252',
      options: [
        { value: 'windows-1252', label: 'Windows (Quicken, Money)', description: 'What Quicken and Money expect. Characters Windows can’t hold are replaced.' },
        { value: 'utf-8', label: 'UTF-8 (GnuCash, Tessera)', description: 'Every character kept, for programs that read UTF-8.' }
      ]
    },
    {
      kind: 'boolean', key: 'opening', label: 'Start each account with its opening balance', default: true,
      description: 'The balance on the first day exported, as Quicken and Money begin an account. Leave it out when adding to an account the other program already has.'
    },
    {
      kind: 'boolean', key: 'categories', label: 'Include the category list', default: true,
      description: 'Every category, marked income or expense, so the other program can create them.'
    }
  ]
}

/** Each account type as QIF names it: its `!Account` type and its `!Type:` section. */
export const QIF_TYPES: Readonly<Record<AccountType, string>> = {
  chequing: 'Bank', savings: 'Bank', cash: 'Cash', creditCard: 'CCard',
  lineOfCredit: 'Oth L', loan: 'Oth L', mortgage: 'Oth L', otherLiability: 'Oth L',
  // Tessera's investment accounts hold cash lines only: Invst would need investment actions, and is left out on import
  investment: 'Oth A', retirement: 'Oth A', otherAsset: 'Oth A'
}

interface QifExportOptions {
  dates: 'mdy' | 'dmy'
  encoding: TextEncoding
  opening: boolean
  categories: boolean
}

const optionsOf = (options: ExportOptions): QifExportOptions => ({
  dates: options.dates === 'dmy' ? 'dmy' : 'mdy',
  encoding: options.encoding === 'utf-8' ? 'utf-8' : 'windows-1252',
  opening: options.opening !== false,
  categories: options.categories !== false
})

/** Text on one line: QIF is a field per line. (The test first: most values have no line break, and this runs a lot.) */
const flat = (text: string) => /[\r\n]/.test(text) ? text.replace(/\s*[\r\n]+\s*/g, ' ').trim() : text.trim()

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

interface Built {
  text: string
  transactions: number
  /** Accounts with nothing to write, by id: not in the file. */
  leftOut: string[]
  problems: string[]
  warnings: string[]
}

/** “A”, “B” and “C”. */
const listNames = (names: readonly string[]) => {
  const quoted = names.map(n => `“${n}”`)
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/** A few names as examples, and how many more. */
function examples(pairs: readonly [string, string][]): string {
  const shown = pairs.slice(0, 3).map(([from, to]) => `“${from}” is “${to}”`).join(', ')
  return pairs.length > 3 ? `${shown}, and ${pairs.length - 3} more` : shown
}

function build(data: ExportData, o: QifExportOptions): Built {
  const out: string[] = []
  const renamed = new Set<string>()
  const cutNames = new Map<string, string>()
  let cutPayees = 0
  let voided = 0
  let transactions = 0
  const days: number[] = []

  /**
   * A name as standard QIF has it: without QIF's syntax (':' between category levels, '/' before a class, '[ ]' around
   * a transfer's account), and its first 15 characters. Each name once: the same few names come back on every line.
   */
  const names = new Map<string, string>()
  const name = (text: string) => {
    let clean = names.get(text)
    if (clean === undefined) {
      const one = flat(text)
      const plain = one.replace(/[:/[\]]/g, '-')
      if (plain !== one) renamed.add(one)
      clean = plain.length > QIF_LIMITS.name ? plain.slice(0, QIF_LIMITS.name).trimEnd() : plain
      if (clean !== plain) cutNames.set(one, clean)
      names.set(text, clean)
    }
    return clean
  }
  const categoryPath = (path: readonly string[]) => path.map(name).join(':')
  const date = (iso: string) => {
    days.push(Number(iso.slice(8, 10)))
    const [y, m, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)]
    return o.dates === 'mdy' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`
  }
  /** A record: a line per field given, then its end. */
  const record = (fields: [string, string | undefined][]) => {
    for (const [code, value] of fields) {
      if (value === undefined) continue
      const one = flat(value)
      if (one !== '') out.push(code + one)
    }
    out.push('^')
  }
  const accountRecord = (account: ExportAccount) => {
    out.push('!Account')
    record([['N', name(account.name)], ['T', QIF_TYPES[account.type]]])
  }
  /** A payee within standard QIF's length; a longer one's whole text goes at the start of the memo. */
  const payeeAndMemo = (t: ExportTransaction): [string | undefined, string | undefined] => {
    const payee = t.payee === undefined ? undefined : flat(t.payee)
    const memo = t.memo === undefined ? undefined : flat(t.memo)
    if (payee === undefined || payee.length <= QIF_LIMITS.payee) return [payee, memo]
    cutPayees++
    return [payee.slice(0, QIF_LIMITS.payee).trimEnd(), [payee, memo].filter(Boolean).join(' · ')]
  }

  // Only accounts with a transaction to write are in the file. An account with nothing in the range would be its
  // opening balance alone, which Tessera's QIF import leaves out as an account with no transactions
  const accounts = data.accounts.filter(a => a.transactions.some(t => !t.voided))
  const leftOut = data.accounts.filter(a => !accounts.includes(a))
  for (const a of leftOut) voided += a.transactions.filter(t => t.voided).length

  // Names that would be one once cut: two accounts a reader would take for one (a problem: one account's lines would
  // go into the other's), and two categories it would make one (a warning)
  const clash = (all: readonly string[], key: (text: string) => string) => {
    const groups = new Map<string, Set<string>>()
    for (const text of all) {
      const k = key(text).toLocaleLowerCase()
      groups.set(k, new Set([...(groups.get(k) ?? []), flat(text)]))
    }
    return [...groups.values()].filter(g => g.size > 1).map(g => [...g])
  }
  const accountNames = [...accounts.map(a => a.name), ...accounts.flatMap(a => a.transactions.flatMap(t => t.transfer && !t.voided ? [t.transfer.account] : []))]
  const accountClashes = clash(accountNames, name)
  const usedCategories = [
    ...(o.categories ? data.categories.map(c => c.path) : []),
    ...accounts.flatMap(a => a.transactions.flatMap(t => t.category && !t.voided ? [t.category] : []))
  ].map(path => path.join(':'))
  const categoryClashes = clash(usedCategories, path => categoryPath(path.split(':')))

  const several = accounts.length > 1
  if (o.categories && data.categories.length > 0) {
    // Each category: its path, then a bare I (income) or E (expense), then the end of the record
    out.push('!Type:Cat')
    for (const category of data.categories) out.push(`N${categoryPath(category.path)}`, category.kind === 'income' ? 'I' : 'E', '^')
  }
  if (several) {
    // Quicken's list of the file's accounts, before their transactions
    out.push('!Option:AutoSwitch')
    for (const account of accounts) accountRecord(account)
    out.push('!Clear:AutoSwitch')
  }
  for (const account of accounts) {
    accountRecord(account)
    out.push(`!Type:${QIF_TYPES[account.type]}`)
    if (o.opening) {
      record([['D', date(account.opening.date)], ['T', account.opening.balance], ['C', 'X'], ['P', 'Opening Balance'], ['L', `[${name(account.name)}]`]])
    }
    for (const t of account.transactions) {
      if (t.voided) { voided++; continue }
      transactions++
      const [payee, memo] = payeeAndMemo(t)
      record([
        ['D', date(t.date)],
        ['T', t.amount],
        ['C', t.status === 'reconciled' ? 'X' : t.status === 'uncleared' ? undefined : '*'],
        ['N', t.number],
        ['P', payee],
        ['M', memo],
        ['L', t.transfer ? `[${name(t.transfer.account)}]` : t.category ? categoryPath(t.category) : undefined]
      ])
    }
  }

  const currencies = [...new Set(accounts.map(a => a.currency))]
  const order = o.dates === 'mdy' ? 'month first' : 'day first'
  const problems = [
    ...(accounts.length === 0 ? [`There are no transactions to export${data.accounts.length === 1 ? ` in “${data.accounts[0].name}”` : ''} for these dates.`] : []),
    ...accountClashes.map(group => `${listNames(group)} would ${group.length === 2 ? 'both' : 'all'} be “${name(group[0])}” in ${QIF_LIMITS.name} characters, so a program reading the file would take them for one account. Rename ${group.length === 2 ? 'one' : 'them'} so the first ${QIF_LIMITS.name} characters differ.`)
  ]
  const warnings = [
    ...(cutNames.size > 0 ? [`Standard QIF keeps the first ${QIF_LIMITS.name} characters of a category’s or an account’s name: ${examples([...cutNames])}.`] : []),
    ...categoryClashes.map(group => `${listNames(group)} would be one category in ${QIF_LIMITS.name} characters, “${categoryPath(group[0].split(':'))}”.`),
    ...(cutPayees > 0 ? [`${plural(cutPayees, 'payee')} longer than ${QIF_LIMITS.payee} characters ${cutPayees === 1 ? 'is' : 'are'} cut, as standard QIF has ${cutPayees === 1 ? 'it' : 'them'}; the whole payee is kept at the start of the memo.`] : []),
    ...(renamed.size > 0 ? [`QIF uses “:”, “/”, “[” and “]” between names, so they are written as “-” in ${[...renamed].map(n => `“${n}”`).join(', ')}.`] : []),
    ...(voided > 0 ? [`${plural(voided, 'voided transaction')} ${voided === 1 ? 'is' : 'are'} left out.`] : []),
    ...(currencies.length > 1 ? [`QIF can’t say which currency an account is in, and these are in ${currencies.join(' and ')}: ${accounts.map(a => `“${a.name}” (${a.currency})`).join(', ')}.`] : []),
    // Only when a reader can't work the order out for itself
    ...(days.length > 0 && days.every(d => d <= 12) ? [`Every day in this file is 12 or less, so a program reading it can’t tell the order of its dates: tell it they are ${order}.`] : [])
  ]
  return { text: out.join('\r\n') + '\r\n', transactions, leftOut: leftOut.map(a => a.id), problems, warnings }
}

function encoded(built: Built, o: QifExportOptions): ExportOutput {
  const { bytes, replaced } = encodeText(built.text, o.encoding)
  const warnings = replaced > 0
    ? [...built.warnings, `${plural(replaced, 'character')} Windows can’t hold ${replaced === 1 ? 'is' : 'are'} written as the nearest letter, or “?”.`]
    : built.warnings
  return { bytes, warnings }
}

export const qifExport: ExportFormat = {
  check(data, options): ExportCheck {
    const o = optionsOf(options)
    const built = build(data, o)
    const { warnings } = encoded(built, o)
    return { transactions: built.transactions, ...(built.leftOut.length > 0 && { accountsLeftOut: built.leftOut }), problems: built.problems, warnings }
  },
  write(data, options): ExportOutput {
    const o = optionsOf(options)
    return encoded(build(data, o), o)
  }
}
