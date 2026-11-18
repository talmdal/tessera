// The neutral model as OFX 2.x — and only 2.x.
//
// OFX 1.x is SGML with unclosed tags and a code-page header, and writing it would mean a second code path
// whose only customer is software old enough to refuse 2.x. Anything that reads OFX at all today reads 2.x,
// and anything that genuinely cannot is also the software that wants QIF, which Tessera already writes. So the
// version is not an option: there is one OFX on the way out. See docs/import-export-design.md#export.
//
// What this does not write is QFX or QBO. Both are defined by an `INTU.BID` identifier Intuit issues to a
// financial institution, and Tessera is not one; a file claiming one would be a forgery that Quicken would
// reject anyway.
import type { ExchangeDocument, ExchangeStatement, ExchangeTransaction } from '@tessera/exchange-api'
import { minorDigits, type AccountType } from '@tessera/accounts-api'

/** `<ORG>`. Tessera is the institution that produced the file, which is what SONRS/FI describes. */
export const OFX_ORG = 'Tessera'

/** The version written, fixed. OFXHEADER 200 is the 2.x header; 211 is the last published 2.x revision. */
export const OFX_HEADER_VERSION = '200'
export const OFX_VERSION = '211'

/** XML's five, escaped. A payee really can contain `&` and `<`, and an unescaped one is a broken file. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * An amount as OFX writes it: a plain signed decimal, point separator, no grouping, with as many decimals as
 * the currency has. The reader scales by the currency's own digits, so writing two for every currency made a
 * yen amount come back a hundredth of what it was and a Bahraini dinar ten times larger.
 */
export function ofxAmount(minor: number, digits = 2): string {
  const sign = minor < 0 ? '-' : ''
  const magnitude = String(Math.abs(minor))
  if (digits === 0) return `${sign}${magnitude}`
  const padded = magnitude.padStart(digits + 1, '0')
  return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`
}

/**
 * A calendar date as `YYYYMMDD`, with no time and no zone. The reader discards the time for a reason — a
 * zone can move a transaction across a statement boundary — so the writer does not invent one.
 */
export const ofxDate = (iso: string) => iso.replace(/-/g, '')

/** A timestamp for `DTSERVER`: midday UTC, so no zone a reader applies can move it off the day. */
export const ofxTimestamp = (iso: string) => `${ofxDate(iso.slice(0, 10))}120000[0:GMT]`

/** Tessera's account types as OFX's `ACCTTYPE`. Only the bank ones; a card has no ACCTTYPE at all. */
export function ofxAccountType(type: AccountType | undefined): string {
  switch (type) {
    case 'savings': return 'SAVINGS'
    case 'lineOfCredit': return 'CREDITLINE'
    case 'cash': case 'chequing': return 'CHECKING'
    default: return 'CHECKING'
  }
}

/** Whether a statement is written as a credit card one, which has its own message set and no `ACCTTYPE`. */
const isCard = (statement: ExchangeStatement) => statement.account.type === 'creditCard'

/**
 * `TRNTYPE` is required. The model does not carry one for an exported row, so it is derived from the sign —
 * which is all a receiving program does with it anyway. `CREDIT` and `DEBIT` are the two every reader knows.
 */
const trnType = (t: ExchangeTransaction) => t.kind ?? (t.amount < 0 ? 'DEBIT' : 'CREDIT')

interface Writer {
  push(line: string): void
}

/** An element with a text value, escaped; skipped entirely when the value is absent or empty. */
function leaf(out: Writer, indent: string, tag: string, value: string | undefined) {
  if (value === undefined || value === '') return
  out.push(`${indent}<${tag}>${escapeXml(value)}</${tag}>`)
}

function writeTransaction(out: Writer, indent: string, t: ExchangeTransaction, digits: number) {
  out.push(`${indent}<STMTTRN>`)
  const inner = `${indent}  `
  leaf(out, inner, 'TRNTYPE', trnType(t))
  leaf(out, inner, 'DTPOSTED', ofxDate(t.date))
  if (t.postedDate !== undefined) leaf(out, inner, 'DTAVAIL', ofxDate(t.postedDate))
  leaf(out, inner, 'TRNAMT', ofxAmount(t.amount, digits))
  // FITID is required and must be unique within the account. On export it is the transaction's ULID, which is
  // stable across exports — so a program that imported last month's file recognises the same rows in this one.
  leaf(out, inner, 'FITID', t.externalId)
  leaf(out, inner, 'CHECKNUM', t.number)
  leaf(out, inner, 'NAME', t.payee?.slice(0, 32))
  leaf(out, inner, 'MEMO', memoOf(t))
  out.push(`${indent}</STMTTRN>`)
}

/**
 * OFX has no category and no transfer, so both go in the memo rather than being dropped silently — which is
 * the honest thing for a format that cannot hold them, and is what the round-trip test asserts.
 */
function memoOf(t: ExchangeTransaction): string | undefined {
  const parts = [t.memo]
  if (t.transferAccount !== undefined) parts.push(`Transfer: ${t.transferAccount}`)
  else if (t.category !== undefined) parts.push(t.category)
  const joined = parts.filter(part => part !== undefined && part !== '').join(' · ')
  return joined === '' ? undefined : joined
}

function writeStatement(out: Writer, statement: ExchangeStatement, at: string, index: number) {
  const card = isCard(statement)
  const [wrapper, response, acctFrom] = card
    ? ['CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM']
    : ['STMTTRNRS', 'STMTRS', 'BANKACCTFROM']

  out.push(`      <${wrapper}>`)
  // TRNUID ties a response to a request. There was no request, so any stable value will do.
  out.push(`        <TRNUID>${index + 1}</TRNUID>`)
  out.push('        <STATUS>')
  out.push('          <CODE>0</CODE>')
  out.push('          <SEVERITY>INFO</SEVERITY>')
  out.push('        </STATUS>')
  out.push(`        <${response}>`)
  const currency = statement.account.currency ?? 'CAD'
  // Every amount in the statement is written with this currency's own number of decimals.
  const digits = minorDigits(currency)
  leaf(out, '          ', 'CURDEF', currency)

  out.push(`          <${acctFrom}>`)
  // The account's own routing number when it has one — a statement it was imported from supplied it — and
  // nothing when it has not. `BANKID` means a routing or transit number, so writing `Tessera` there, as this
  // once did, was not a weaker answer but a wrong-typed one: a receiving program keys an account on it.
  if (!card) leaf(out, '            ', 'BANKID', statement.account.bankId)
  // ACCTID is required. Falling back to the account's name keeps the file valid when no number is recorded.
  leaf(out, '            ', 'ACCTID', statement.account.number ?? statement.account.name ?? 'ACCOUNT')
  if (!card) leaf(out, '            ', 'ACCTTYPE', ofxAccountType(statement.account.type))
  out.push(`          </${acctFrom}>`)

  const dates = statement.transactions.map(t => t.date).sort()
  const from = statement.period?.from ?? dates[0] ?? at
  const to = statement.period?.to ?? dates[dates.length - 1] ?? at

  out.push('          <BANKTRANLIST>')
  leaf(out, '            ', 'DTSTART', ofxDate(from))
  leaf(out, '            ', 'DTEND', ofxDate(to))
  for (const t of statement.transactions) writeTransaction(out, '            ', t, digits)
  out.push('          </BANKTRANLIST>')

  // LEDGERBAL is required. With no balance recorded, the sum of what is here is the honest figure.
  const ledger = statement.balances?.ledger
  const amount = ledger?.amount ?? statement.transactions.reduce((sum, t) => sum + t.amount, 0)
  out.push('          <LEDGERBAL>')
  leaf(out, '            ', 'BALAMT', ofxAmount(amount, digits))
  leaf(out, '            ', 'DTASOF', ofxDate(ledger?.asOf ?? to))
  out.push('          </LEDGERBAL>')

  if (statement.balances?.available !== undefined) {
    out.push('          <AVAILBAL>')
    leaf(out, '            ', 'BALAMT', ofxAmount(statement.balances.available.amount, digits))
    leaf(out, '            ', 'DTASOF', ofxDate(statement.balances.available.asOf))
    out.push('          </AVAILBAL>')
  }

  out.push(`        </${response}>`)
  out.push(`      </${wrapper}>`)
}

/**
 * The document as an OFX 2.x file. Bank and credit-card statements go in their own message sets, because a
 * reader looks for `CCSTMTRS` under `CREDITCARDMSGSRSV1` and will not find a card statement filed as a bank
 * one — so a document holding both produces both blocks.
 */
export function writeOfx(document: ExchangeDocument): Uint8Array {
  const at = (document.generatedAt ?? new Date().toISOString()).slice(0, 10)
  const lines: string[] = []
  const out: Writer = { push: line => lines.push(line) }

  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<?OFX OFXHEADER="${OFX_HEADER_VERSION}" VERSION="${OFX_VERSION}" ` +
    'SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>')
  lines.push('<OFX>')

  lines.push('  <SIGNONMSGSRSV1>')
  lines.push('    <SONRS>')
  lines.push('      <STATUS>')
  lines.push('        <CODE>0</CODE>')
  lines.push('        <SEVERITY>INFO</SEVERITY>')
  lines.push('      </STATUS>')
  lines.push(`      <DTSERVER>${ofxTimestamp(document.generatedAt ?? `${at}T12:00:00Z`)}</DTSERVER>`)
  lines.push('      <LANGUAGE>ENG</LANGUAGE>')
  lines.push('      <FI>')
  lines.push(`        <ORG>${escapeXml(OFX_ORG)}</ORG>`)
  lines.push('      </FI>')
  lines.push('    </SONRS>')
  lines.push('  </SIGNONMSGSRSV1>')

  const bank = document.statements.filter(statement => !isCard(statement))
  const cards = document.statements.filter(isCard)

  if (bank.length > 0) {
    lines.push('  <BANKMSGSRSV1>')
    bank.forEach((statement, index) => writeStatement(out, statement, at, index))
    lines.push('  </BANKMSGSRSV1>')
  }
  if (cards.length > 0) {
    lines.push('  <CREDITCARDMSGSRSV1>')
    cards.forEach((statement, index) => writeStatement(out, statement, at, bank.length + index))
    lines.push('  </CREDITCARDMSGSRSV1>')
  }

  lines.push('</OFX>')
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
}
