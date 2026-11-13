// Writing OFX, QFX and QBO: one account's statement, as banks give them. OFX 1.0.2 in SGML, the dialect every OFX
// reader takes (Microsoft Money, GnuCash, and this plugin's own reader), with the header banks send. QFX (Quicken) and
// QBO (QuickBooks) are the same file with the bank's Intuit id (`INTU.BID`) in the sign-on, from the account's own
// field; Tessera never makes one up or borrows another bank's, and without one the file is written with a warning.
// Each line keeps a stable id (`FITID`): the bank's own when the transaction was imported with one, else Tessera's, so
// exporting overlapping dates doesn't double transactions in a program that checks ids. Pure: data in, bytes out.
// See docs/export-design.md, "OFX" and "QFX and QBO".
import { ACCOUNT_TYPE_LABELS, type AccountType } from '@tessera/accounts-api'
import {
  encodeText,
  type AccountFieldUse, type ExportAccount, type ExportCheck, type ExportData, type ExportFormat, type ExportFormatContribution,
  type ExportOptionField, type ExportOptions, type ExportOutput, type ExportTransaction
} from '@tessera/export-api'

export const OFX_EXPORT_SERVICE = 'format-ofx.export'

/** Lengths OFX 1.0.2 gives its elements (the specification's A-n). */
export const OFX_LIMITS = { NAME: 32, MEMO: 255, CHECKNUM: 12, BANKID: 9, ACCTID: 22 } as const

/** Bank statements' account types, by Tessera's; a credit card is a card statement. */
const BANK_TYPES: Partial<Record<AccountType, string>> = { chequing: 'CHECKING', savings: 'SAVINGS', lineOfCredit: 'CREDITLINE' }
const HOLDS: AccountType[] = ['chequing', 'savings', 'lineOfCredit', 'creditCard']
const BANK_ACCOUNTS: AccountType[] = ['chequing', 'savings', 'lineOfCredit']

const OPTIONS: ExportOptionField[] = [
  {
    kind: 'boolean', key: 'clearedOnly', label: 'Only transactions the bank has cleared', default: false,
    description: 'Leaves out uncleared transactions, as the bank’s own statement would.'
  },
  {
    kind: 'boolean', key: 'categoryInMemo', label: 'Put each category in the memo', default: false,
    description: 'OFX has no categories: this keeps them, at the start of each memo.'
  }
]

const ACCOUNT_FIELDS: AccountFieldUse[] = [
  { field: 'accountNumber', need: 'required' },
  { field: 'bankId', need: 'required', accountTypes: BANK_ACCOUNTS }
]
const INTUIT_FIELDS: AccountFieldUse[] = [...ACCOUNT_FIELDS, { field: 'intuitBankId', need: 'recommended' }]

const common = { service: OFX_EXPORT_SERVICE, accounts: 'one' as const, accountTypes: HOLDS, options: OPTIONS }

export const OFX_EXPORT: ExportFormatContribution = {
  ...common, id: 'format-ofx.ofx', label: 'OFX statement (Microsoft Money, GnuCash)', extension: 'ofx', order: 30,
  description: 'A bank or card statement for one account, as banks give them for Microsoft Money: read by Money, GnuCash and most finance programs.',
  accountFields: ACCOUNT_FIELDS
}
export const QFX_EXPORT: ExportFormatContribution = {
  ...common, id: 'format-ofx.qfx', label: 'QFX file (Quicken)', extension: 'qfx', order: 31,
  description: 'The same statement, for Quicken (Web Connect), which expects the bank’s Intuit id.',
  accountFields: INTUIT_FIELDS
}
export const QBO_EXPORT: ExportFormatContribution = {
  ...common, id: 'format-ofx.qbo', label: 'QBO file (QuickBooks)', extension: 'qbo', order: 32,
  description: 'The same statement, for QuickBooks (Web Connect), which expects the bank’s Intuit id.',
  accountFields: INTUIT_FIELDS
}

export const OFX_EXPORTS = [OFX_EXPORT, QFX_EXPORT, QBO_EXPORT]

type Flavour = 'ofx' | 'qfx' | 'qbo'
const flavourOf = (formatId: string): Flavour => formatId === QFX_EXPORT.id ? 'qfx' : formatId === QBO_EXPORT.id ? 'qbo' : 'ofx'
const PROGRAM: Record<Exclude<Flavour, 'ofx'>, string> = { qfx: 'Quicken', qbo: 'QuickBooks' }

/** Text as one OFX value: on one line, and without the characters that would end it. */
const value = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Text on one line, not yet escaped (for measuring). */
const flat = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
/** Text cut to `max` characters, trimmed (a cut that ends in a space would read back otherwise). */
const cut = (text: string, max: number) => text.length <= max ? text : text.slice(0, max).trimEnd()
const day = (iso: string) => iso.replace(/-/g, '')
/** An account number no longer than this is warned about, as likely only the last digits of the real one. */
const SHORT_NUMBER = 4

/** The account number as OFX's ACCTID: without spaces and dashes. */
const acctId = (number: string | undefined) => (number ?? '').replace(/[\s-]/g, '')

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** What kind of line it is, as OFX says (TRNTYPE). */
function trnType(t: ExportTransaction): string {
  const number = t.number?.trim().toUpperCase() ?? ''
  const out = t.amount.startsWith('-')
  if (t.transfer) return 'XFER'
  if (/^\d+$/.test(number) && out) return 'CHECK'
  if (number === 'ATM') return 'ATM'
  if (number === 'DEP') return 'DEP'
  return out ? 'DEBIT' : 'CREDIT'
}

interface Built {
  text: string
  transactions: number
  problems: string[]
  warnings: string[]
}

function build(data: ExportData, options: ExportOptions, flavour: Flavour, exportedAt: string): Built {
  const problems: string[] = []
  if (data.accounts.length !== 1) return { text: '', transactions: 0, problems: ['Choose one account: this file type holds one account per file.'], warnings: [] }
  const account: ExportAccount = data.accounts[0]
  const card = account.type === 'creditCard'
  const bankType = BANK_TYPES[account.type]
  // An account type OFX can't hold: that alone is the problem (said as the export manager says it, so it is said once)
  if (!card && !bankType) {
    return { text: '', transactions: 0, problems: [`This file type can’t hold ${ACCOUNT_TYPE_LABELS[account.type].toLowerCase()} accounts, such as “${account.name}”.`], warnings: [] }
  }

  // What identifies the account to the program reading the file
  const number = acctId(account.accountNumber)
  if (number === '') problems.push(`Enter “${account.name}”’s account number: OFX says which account a statement is for by it.`)
  else if (/[•*xX#]/.test(number)) problems.push(`“${account.name}”’s account number is masked (${account.accountNumber}): enter it whole, as the bank writes it.`)
  else if (number.length > OFX_LIMITS.ACCTID) problems.push(`“${account.name}”’s account number is longer than OFX allows (${OFX_LIMITS.ACCTID} characters without spaces and dashes).`)
  const bankId = account.bankId?.trim() ?? ''
  if (!card) {
    if (bankId === '') problems.push(`Enter “${account.name}”’s bank number: a bank statement says which bank it is from by it. It is in the bank’s own OFX files, after <BANKID>.`)
    else if (!new RegExp(`^[0-9A-Za-z]{1,${OFX_LIMITS.BANKID}}$`).test(bankId)) problems.push(`“${account.name}”’s bank number can be letters and digits only, ${OFX_LIMITS.BANKID} at most.`)
  }
  if (account.digits > 2) problems.push(`${account.currency} amounts have ${account.digits} decimals, which OFX statements aren’t known to carry.`)

  const cleared = options.clearedOnly === true
  const voided = account.transactions.filter(t => t.voided).length
  const lines = account.transactions.filter(t => !t.voided && (!cleared || t.status !== 'uncleared'))
  const uncleared = cleared ? account.transactions.filter(t => !t.voided && t.status === 'uncleared').length : 0
  if (lines.length === 0) problems.push(`There are no transactions to export in “${account.name}” for these dates.`)

  let names = 0
  let memos = 0
  const body: string[] = []
  for (const t of lines) {
    const payee = t.payee === undefined ? undefined : flat(t.payee)
    const long = payee !== undefined && payee.length > OFX_LIMITS.NAME
    if (long) names++
    const category = options.categoryInMemo === true && t.category ? t.category.join(' : ') : undefined
    let memo = [long ? payee : undefined, category, t.memo === undefined ? undefined : flat(t.memo)].filter(Boolean).join(' · ')
    if (memo.length > OFX_LIMITS.MEMO) { memo = cut(memo, OFX_LIMITS.MEMO); memos++ }
    const checkNumber = t.number?.trim() ?? ''
    body.push(
      '<STMTTRN>',
      `<TRNTYPE>${trnType(t)}`,
      `<DTPOSTED>${day(t.date)}`,
      `<TRNAMT>${t.amount}`,
      `<FITID>${value(t.bankId ?? `TESSERA.${t.id}`)}`,
      ...(/^\d+$/.test(checkNumber) && checkNumber.length <= OFX_LIMITS.CHECKNUM ? [`<CHECKNUM>${checkNumber}`] : []),
      ...(payee !== undefined && payee !== '' ? [`<NAME>${value(cut(payee, OFX_LIMITS.NAME))}`] : []),
      ...(memo !== '' ? [`<MEMO>${value(memo)}`] : []),
      '</STMTTRN>'
    )
  }

  const intuit = account.intuitBankId?.trim() ?? ''
  const text = [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE',
    'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
    '<OFX>',
    '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>',
    `<DTSERVER>${exportedAt}`, '<LANGUAGE>ENG',
    ...(account.institution ? ['<FI>', `<ORG>${value(account.institution)}`, '</FI>'] : []),
    ...(flavour !== 'ofx' && intuit !== '' ? [`<INTU.BID>${value(intuit)}`] : []),
    '</SONRS>', '</SIGNONMSGSRSV1>',
    card ? '<CREDITCARDMSGSRSV1>' : '<BANKMSGSRSV1>', card ? '<CCSTMTTRNRS>' : '<STMTTRNRS>',
    '<TRNUID>0', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>',
    card ? '<CCSTMTRS>' : '<STMTRS>',
    `<CURDEF>${account.currency}`,
    ...(card
      ? ['<CCACCTFROM>', `<ACCTID>${value(number)}`, '</CCACCTFROM>']
      : ['<BANKACCTFROM>', `<BANKID>${value(bankId)}`, `<ACCTID>${value(number)}`, `<ACCTTYPE>${bankType ?? 'CHECKING'}`, '</BANKACCTFROM>']),
    '<BANKTRANLIST>', `<DTSTART>${day(account.opening.date)}`, `<DTEND>${day(account.closing.date)}`,
    ...body,
    '</BANKTRANLIST>',
    '<LEDGERBAL>', `<BALAMT>${account.closing.balance}`, `<DTASOF>${day(account.closing.date)}`, '</LEDGERBAL>',
    card ? '</CCSTMTRS>' : '</STMTRS>', card ? '</CCSTMTTRNRS>' : '</STMTTRNRS>', card ? '</CREDITCARDMSGSRSV1>' : '</BANKMSGSRSV1>',
    '</OFX>'
  ].join('\r\n') + '\r\n'

  // A number this short is most likely the last digits of a masked one, which is all an import from such a file keeps
  const short = number !== '' && number.length <= SHORT_NUMBER && !problems.some(p => p.includes('account number'))
  const reader = flavour === 'ofx' ? 'The program reading it' : PROGRAM[flavour]
  const warnings = [
    ...(short
      ? [`“${account.name}”’s account number is only ${number.length} characters (${number}), perhaps the last digits of a longer one. ${reader} finds the account by its whole number: if this isn’t all of it, enter the number as the bank writes it.`]
      : []),
    ...(flavour !== 'ofx' && intuit === ''
      ? [`“${account.name}” has no Intuit bank id, so ${PROGRAM[flavour]} may refuse this file. Add the bank’s id to the account (it is in a .qfx or .qbo file from the bank, after <INTU.BID>), or export OFX instead.`]
      : []),
    ...(names > 0 ? [`${plural(names, 'payee')} longer than ${OFX_LIMITS.NAME} characters ${names === 1 ? 'is' : 'are'} cut, as OFX has ${names === 1 ? 'it' : 'them'}; the whole payee is kept at the start of the memo.`] : []),
    ...(memos > 0 ? [`${plural(memos, 'memo')} longer than ${OFX_LIMITS.MEMO} characters ${memos === 1 ? 'is' : 'are'} cut.`] : []),
    ...(voided > 0 ? [`${plural(voided, 'voided transaction')} ${voided === 1 ? 'is' : 'are'} left out: a bank’s statement has none.`] : []),
    ...(uncleared > 0 ? [`${plural(uncleared, 'uncleared transaction')} ${uncleared === 1 ? 'is' : 'are'} left out, as asked.`] : [])
  ]
  return { text, transactions: lines.length, problems, warnings }
}

/** When the file was made, as OFX writes it: YYYYMMDDHHMMSS. */
const stamp = (iso: string) => iso.replace(/[-:T]/g, '').slice(0, 14)

function encoded(built: Built): ExportOutput {
  const { bytes, replaced } = encodeText(built.text, 'windows-1252')
  const warnings = replaced > 0
    ? [...built.warnings, `${plural(replaced, 'character')} Windows can’t hold ${replaced === 1 ? 'is' : 'are'} written as the nearest letter, or “?”.`]
    : built.warnings
  return { bytes, warnings }
}

export const ofxExport: ExportFormat = {
  check(data, options, formatId): ExportCheck {
    const built = build(data, options, flavourOf(formatId), stamp(data.exportedAt))
    return { transactions: built.transactions, problems: built.problems, warnings: encoded(built).warnings }
  },
  write(data, options, formatId): ExportOutput {
    return encoded(build(data, options, flavourOf(formatId), stamp(data.exportedAt)))
  }
}
