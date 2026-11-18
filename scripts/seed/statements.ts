// The bank files that go with the seeded book: OFX in both its syntaxes, QFX, QBO and CSV.
//
// These are written by hand rather than through the format plugins, because the plugins that read them do not
// exist yet — that is the point. They are the fixtures phases 2 to 5 will be built against, so they are written
// the way real banks write them, quirks included: SGML with unclosed tags, Windows-1252 bytes, a credit-card
// statement with its own sign convention, and two CSV exports that disagree about their columns.
import { createHash } from 'node:crypto'
import { ACCOUNTS, type AccountKey, type Entry, type SeedAccount } from './household'

export interface StatementSpec {
  /** The file, relative to the fixtures folder. */
  file: string
  format: 'ofx-sgml' | 'ofx-xml' | 'qfx' | 'qbo' | 'csv-debit-credit' | 'csv-signed' | 'qif-standard' | 'qif-microsoft'
  account: SeedAccount
  month: string
  rows: Entry[]
  /** The account's balance at the end of the month, as the bank sees it. */
  closingBalance: number
  /** What the file is for, in the manifest. */
  note: string
}

/** A stable, bank-looking reference for a row. Real FITIDs are opaque; these are too, and they repeat. */
export function fitid(account: SeedAccount, row: Entry): string {
  const when = row.postedDate ?? row.date
  const key = `${account.accountNumber}|${when}|${row.amount}|${row.payee ?? row.memo ?? ''}`
  return createHash('sha1').update(key).digest('hex').slice(0, 16).toUpperCase()
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/**
 * The characters Windows-1252 puts in 0x80–0x9F, where ISO-8859-1 has control codes. Node can encode
 * `latin1` but not cp1252, and the difference is exactly the punctuation a bank statement is full of: a
 * curly apostrophe written as `latin1` becomes the control character 0x19 and the file is quietly corrupt.
 */
const CP1252_HIGH: Record<string, number> = {
  '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85, '\u2020': 0x86,
  '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a, '\u2039': 0x8b, '\u0152': 0x8c,
  '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95,
  '\u2013': 0x96, '\u2014': 0x97, '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b,
  '\u0153': 0x9c, '\u017e': 0x9e, '\u0178': 0x9f
}

/** Text as Windows-1252 bytes. Anything the code page cannot hold becomes `?`, as a real encoder does. */
export function toCp1252(text: string): Buffer {
  const bytes: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) bytes.push(code)
    else if (CP1252_HIGH[character] !== undefined) bytes.push(CP1252_HIGH[character])
    else bytes.push(0x3f)
  }
  return Buffer.from(bytes)
}

/** OFX writes money as a plain decimal with a leading minus, never grouped. */
export function ofxAmount(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const whole = Math.floor(Math.abs(minor) / 100)
  return `${sign}${whole}.${pad(Math.abs(minor) % 100)}`
}

/** `YYYYMMDDHHMMSS[-5:EST]`, the form a Canadian bank writes. */
const ofxDate = (date: string, time = '120000') => `${date.replace(/-/g, '')}${time}[-5:EST]`

const ofxEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** OFX's own word for what a row is. The importer keeps it for display and nothing else. */
function trnType(row: Entry): string {
  if (row.transferTo !== undefined) return 'XFER'
  if (row.number === 'DEP') return 'DEP'
  if (row.number !== undefined && /^\d{3,}$/.test(row.number)) return 'CHECK'
  if (row.amount > 0) return 'CREDIT'
  if (row.number === 'POS') return 'POS'
  if (row.number === 'PAP' || row.number === 'EFT') return 'DIRECTDEBIT'
  return 'DEBIT'
}

function statementTransactions(spec: StatementSpec, indent: string): string {
  return spec.rows.map(row => {
    const when = row.postedDate ?? row.date
    const name = (row.payee ?? row.memo ?? 'Transaction').slice(0, 32)
    const lines = [
      `${indent}<STMTTRN>`,
      `${indent}  <TRNTYPE>${trnType(row)}`,
      `${indent}  <DTPOSTED>${ofxDate(when)}`,
      `${indent}  <TRNAMT>${ofxAmount(row.amount)}`,
      `${indent}  <FITID>${fitid(spec.account, row)}`
    ]
    if (row.number !== undefined && /^\d{3,}$/.test(row.number)) lines.push(`${indent}  <CHECKNUM>${row.number}`)
    lines.push(`${indent}  <NAME>${ofxEscape(name)}`)
    if (row.memo !== undefined) lines.push(`${indent}  <MEMO>${ofxEscape(row.memo)}`)
    lines.push(`${indent}</STMTTRN>`)
    return lines.join('\n')
  }).join('\n')
}

const isCard = (account: SeedAccount) => account.type === 'creditCard'

function acctFrom(account: SeedAccount, indent: string): string {
  if (isCard(account)) {
    return [
      `${indent}<CCACCTFROM>`,
      `${indent}  <ACCTID>${account.accountNumber.replace(/\s/g, '')}`,
      `${indent}</CCACCTFROM>`
    ].join('\n')
  }
  return [
    `${indent}<BANKACCTFROM>`,
    `${indent}  <BANKID>${account.bankId}`,
    `${indent}  <ACCTID>${account.accountNumber}`,
    `${indent}  <ACCTTYPE>${account.type === 'savings' ? 'SAVINGS' : 'CHECKING'}`,
    `${indent}</BANKACCTFROM>`
  ].join('\n')
}

function period(spec: StatementSpec) {
  const last = new Date(Date.UTC(Number(spec.month.slice(0, 4)), Number(spec.month.slice(5, 7)), 0))
  return { from: `${spec.month}-01`, to: last.toISOString().slice(0, 10) }
}

/**
 * OFX 1.x: a block of `KEY:VALUE` header lines, a blank line, then SGML in which leaf tags are **not** closed.
 * No XML parser can read this, which is exactly why the reader needs its own tokeniser.
 */
export function writeOfxSgml(spec: StatementSpec, options: { intuit?: 'qfx' | 'qbo' } = {}): Buffer {
  const { from, to } = period(spec)
  const wrapper = isCard(spec.account) ? 'CCSTMT' : 'STMT'
  const message = isCard(spec.account) ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1'

  const intuitTags = options.intuit === undefined
    ? ''
    : `\n    <INTU.BID>${options.intuit === 'qbo' ? '3000' : '2001'}` +
      `\n    <INTU.USERID>householder@example.invalid`

  const body = `<OFX>
<SIGNONMSGSRSV1>
  <SONRS>
    <STATUS>
      <CODE>0
      <SEVERITY>INFO
    </STATUS>
    <DTSERVER>${ofxDate(to, '235959')}
    <LANGUAGE>ENG
    <FI>
      <ORG>${ofxEscape(spec.account.institution)}
      <FID>${spec.account.bankId}
    </FI>${intuitTags}
  </SONRS>
</SIGNONMSGSRSV1>
<${message}>
  <${wrapper}TRNRS>
    <TRNUID>${spec.month}-${spec.account.accountNumber.slice(-4)}
    <STATUS>
      <CODE>0
      <SEVERITY>INFO
    </STATUS>
    <${wrapper}RS>
      <CURDEF>CAD
${acctFrom(spec.account, '      ')}
      <BANKTRANLIST>
        <DTSTART>${ofxDate(from, '000000')}
        <DTEND>${ofxDate(to, '235959')}
${statementTransactions(spec, '        ')}
      </BANKTRANLIST>
      <LEDGERBAL>
        <BALAMT>${ofxAmount(spec.closingBalance)}
        <DTASOF>${ofxDate(to, '235959')}
      </LEDGERBAL>
      <AVAILBAL>
        <BALAMT>${ofxAmount(spec.closingBalance)}
        <DTASOF>${ofxDate(to, '235959')}
      </AVAILBAL>
    </${wrapper}RS>
  </${wrapper}TRNRS>
</${message}>
</OFX>
`

  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    ''
  ].join('\r\n')

  // `ENCODING:USASCII` with `CHARSET:1252` means Windows-1252, which is neither ASCII nor UTF-8. Writing the
  // bytes that way is deliberate: a reader that assumes UTF-8 mangles “Café Martin”, and this file proves it.
  return toCp1252(header + body.replace(/\n/g, '\r\n'))
}

/** OFX 2.x: the same tree, well-formed XML, with the header as a processing instruction. */
export function writeOfxXml(spec: StatementSpec): Buffer {
  const { from, to } = period(spec)
  const wrapper = isCard(spec.account) ? 'CCSTMT' : 'STMT'
  const message = isCard(spec.account) ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1'

  const closed = (text: string) =>
    text.replace(/^(\s*)<([A-Z.]+)>([^<\n]+)$/gm, (_whole, space: string, tag: string, value: string) =>
      `${space}<${tag}>${value}</${tag}>`)

  const body = closed(`<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS>
        <CODE>0
        <SEVERITY>INFO
      </STATUS>
      <DTSERVER>${ofxDate(to, '235959')}
      <LANGUAGE>ENG
      <FI>
        <ORG>${ofxEscape(spec.account.institution)}
        <FID>${spec.account.bankId}
      </FI>
    </SONRS>
  </SIGNONMSGSRSV1>
  <${message}>
    <${wrapper}TRNRS>
      <TRNUID>${spec.month}-${spec.account.accountNumber.slice(-4)}
      <STATUS>
        <CODE>0
        <SEVERITY>INFO
      </STATUS>
      <${wrapper}RS>
        <CURDEF>CAD
${acctFrom(spec.account, '        ')}
        <BANKTRANLIST>
          <DTSTART>${ofxDate(from, '000000')}
          <DTEND>${ofxDate(to, '235959')}
${statementTransactions(spec, '          ')}
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>${ofxAmount(spec.closingBalance)}
          <DTASOF>${ofxDate(to, '235959')}
        </LEDGERBAL>
      </${wrapper}RS>
    </${wrapper}TRNRS>
  </${message}>
</OFX>
`)

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n'
  return Buffer.from(header + body, 'utf8')
}

// ---- CSV ----------------------------------------------------------------------------------------

const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const csvDate = (date: string) => {
  const [y, m, d] = date.split('-')
  return `${d}/${m}/${y}`
}

const major = (minor: number) => (Math.abs(minor) / 100).toFixed(2)

/** A bank export with separate debit and credit columns, a title line above the header, and a total below. */
export function writeCsvDebitCredit(spec: StatementSpec): Buffer {
  const { from, to } = period(spec)
  const lines = [
    `${spec.account.institution} - ${spec.account.name} - ${from} to ${to}`,
    ['Date', 'Description', 'Debit', 'Credit', 'Balance'].join(',')
  ]
  let running = spec.closingBalance - spec.rows.reduce((total, row) => total + row.amount, 0)
  for (const row of spec.rows) {
    running += row.amount
    lines.push([
      csvDate(row.postedDate ?? row.date),
      csvCell(row.payee ?? row.memo ?? 'Transaction'),
      row.amount < 0 ? major(row.amount) : '',
      row.amount > 0 ? major(row.amount) : '',
      major(running)
    ].join(','))
  }
  lines.push(`Closing balance,,,,${major(spec.closingBalance)}`)
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
}

/** A plainer export: one signed amount column, ISO dates, a memo of its own, and a BOM for Excel. */
export function writeCsvSigned(spec: StatementSpec): Buffer {
  const lines = [['Transaction Date', 'Payee', 'Memo', 'Reference', 'Amount'].join(',')]
  for (const row of spec.rows) {
    // A transfer has no payee, so the bank prints its memo in the description column, as a real export does
    lines.push([
      row.postedDate ?? row.date,
      csvCell(row.payee ?? row.memo ?? 'Transaction'),
      csvCell(row.payee === undefined ? '' : row.memo ?? ''),
      csvCell(row.number ?? ''),
      (row.amount / 100).toFixed(2)
    ].join(','))
  }
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')])
}

// ---- QIF ----------------------------------------------------------------------------------------

export type QifDialect = 'standard' | 'microsoft'

/** `M/D'YY` in the standard dialect (the apostrophe means 2000+), `M/D/YYYY` in Microsoft's. */
export const qifDate = (date: string, dialect: QifDialect) => {
  const [y, m, d] = date.split('-')
  return dialect === 'microsoft' ? `${Number(m)}/${Number(d)}/${y}` : `${Number(m)}/${Number(d)}'${y.slice(2)}`
}

/** Signed, with thousands grouped, as Quicken and Money both write it. */
export const qifAmount = (minor: number) => {
  const sign = minor < 0 ? '-' : ''
  const whole = String(Math.floor(Math.abs(minor) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${whole}.${String(Math.abs(minor) % 100).padStart(2, '0')}`
}

/** Standard QIF truncates payee, memo and category to fifteen characters; the Microsoft dialect does not. */
const qifText = (text: string, dialect: QifDialect) => dialect === 'standard' ? text.slice(0, 15) : text

const qifType = (account: SeedAccount) => account.type === 'creditCard' ? 'CCard' : 'Bank'

/** The `L` line: a category as `Parent:Child`, or a transfer as `[Account name]`. */
function qifCategory(row: Entry, dialect: QifDialect): string | undefined {
  if (row.transferTo !== undefined) {
    const other = ACCOUNTS.find(a => a.key === row.transferTo)
    return other === undefined ? undefined : `[${qifText(other.name, dialect)}]`
  }
  return row.category === undefined ? undefined : qifText(row.category.replace(/\s*:\s*/g, ':'), dialect)
}

/**
 * A QIF statement in either dialect. Microsoft Money's export opens with an `!Account` block and marks the
 * rows the user had cleared; it is written as Windows-1252, since that is what Money wrote. The standard file
 * is the bare `!Type:` list, in ASCII, with the fifteen-character truncation that gives the dialect away.
 */
export function writeQif(spec: StatementSpec, dialect: QifDialect): Buffer {
  const lines: string[] = []
  const type = qifType(spec.account)
  if (dialect === 'microsoft') {
    lines.push('!Account', `N${spec.account.name}`, `T${type}`, `D${spec.account.institution}`, '^')
  }
  lines.push(`!Type:${type}`)
  for (const row of spec.rows) {
    lines.push(`D${qifDate(row.postedDate ?? row.date, dialect)}`)
    lines.push(`T${qifAmount(row.amount)}`)
    lines.push(`U${qifAmount(row.amount)}`)
    if (dialect === 'microsoft' && row.inBook) lines.push('C*')
    if (row.number !== undefined) lines.push(`N${row.number}`)
    if (row.payee !== undefined) lines.push(`P${qifText(row.payee, dialect)}`)
    if (row.memo !== undefined) lines.push(`M${qifText(row.memo, dialect)}`)
    const category = qifCategory(row, dialect)
    if (category !== undefined) lines.push(`L${category}`)
    lines.push('^')
  }
  const text = lines.join('\r\n') + '\r\n'
  return dialect === 'microsoft' ? toCp1252(text) : Buffer.from(text, 'ascii')
}

export function render(spec: StatementSpec): Buffer {
  switch (spec.format) {
    case 'qif-standard': return writeQif(spec, 'standard')
    case 'qif-microsoft': return writeQif(spec, 'microsoft')
    case 'ofx-sgml': return writeOfxSgml(spec)
    case 'ofx-xml': return writeOfxXml(spec)
    case 'qfx': return writeOfxSgml(spec, { intuit: 'qfx' })
    case 'qbo': return writeOfxSgml(spec, { intuit: 'qbo' })
    case 'csv-debit-credit': return writeCsvDebitCredit(spec)
    case 'csv-signed': return writeCsvSigned(spec)
  }
}

/** What a reader should find in a file, so a later test can assert it without reading the book. */
export interface ManifestEntry {
  file: string
  format: StatementSpec['format']
  account: { name: string, number: string, bankId: string, type: SeedAccount['type'] }
  month: string
  note: string
  rows: number
  /** Rows the household has already entered, which should match something in the book. */
  inBook: number
  /** Rows the household has not entered, which should import as new. */
  notInBook: number
  /** Rows whose statement date differs from the one in the book, which the matcher's window must bridge. */
  staggered: number
  closingBalance: number
  carriesReferences: boolean
}

export const manifestEntry = (spec: StatementSpec): ManifestEntry => ({
  file: spec.file,
  format: spec.format,
  account: {
    name: spec.account.name,
    number: spec.account.accountNumber,
    bankId: spec.account.bankId,
    type: spec.account.type
  },
  month: spec.month,
  note: spec.note,
  rows: spec.rows.length,
  inBook: spec.rows.filter(row => row.inBook).length,
  notInBook: spec.rows.filter(row => !row.inBook).length,
  staggered: spec.rows.filter(row => row.postedDate !== undefined).length,
  closingBalance: spec.closingBalance,
  carriesReferences: !spec.format.startsWith('csv') && !spec.format.startsWith('qif')
})

export type { AccountKey }
