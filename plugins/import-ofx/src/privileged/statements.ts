// The statements in an OFX document: bank statements (BANKMSGSRSV1 › STMTRS) and credit card statements
// (CREDITCARDMSGSRSV1 › CCSTMTRS), in the neutral form the import manager reads. OFX signs amounts from the account
// holder's side, as Tessera does (a card charge is negative), so amounts pass through as they are.
import type { AccountType } from '@tessera/accounts-api'
import {
  canonicalDecimal, isoDate,
  type ParsedStatement, type ParseWarning, type StatementAccount, type StatementLine, type StatementLineKind
} from '@tessera/import-api'
import { findAll, valueOf, type OfxNode } from './sgml'

/** OFX's transaction types (TRNTYPE), as the kinds the import manager knows. */
const KINDS: Record<string, StatementLineKind> = {
  CREDIT: 'credit', DEBIT: 'debit', INT: 'interest', DIV: 'dividend', FEE: 'fee', SRVCHG: 'serviceCharge',
  DEP: 'deposit', ATM: 'atm', POS: 'pos', XFER: 'transfer', CHECK: 'cheque', PAYMENT: 'payment', CASH: 'atm',
  DIRECTDEP: 'deposit', DIRECTDEBIT: 'directDebit', REPEATPMT: 'payment', OTHER: 'other'
}

/** OFX's bank account types (ACCTTYPE), as Tessera's. */
const ACCOUNT_TYPES: Record<string, AccountType> = {
  CHECKING: 'chequing', SAVINGS: 'savings', MONEYMRKT: 'savings', CD: 'savings', CREDITLINE: 'lineOfCredit'
}

/** An OFX date (YYYYMMDD, optionally with a time and a zone: 20261005120000[-5:EST]) as the calendar date it names. */
export function ofxDate(text: string | undefined): string | undefined {
  const digits = text?.trim().match(/^(\d{8})/)?.[1]
  return digits === undefined ? undefined : isoDate(digits, 'YMD')
}

/** An OFX amount as a canonical decimal. OFX allows '.' or ',' as the separator. */
export const ofxAmount = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : canonicalDecimal(text) ?? canonicalDecimal(text, { decimal: ',' })

/** A card number shown only in part (XXXXXXXXXXXX3456, ****3456). */
const isMasked = (number: string) => /[X*#•]/i.test(number)
const lastDigits = (number: string) => number.replace(/[^0-9A-Za-z]/g, '').slice(-4)

function lineOf(trn: OfxNode, where: string, warnings: ParseWarning[]): StatementLine | undefined {
  const date = ofxDate(valueOf(trn, 'DTPOSTED'))
  const amount = ofxAmount(valueOf(trn, 'TRNAMT'))
  const id = valueOf(trn, 'FITID')
  if (date === undefined || amount === undefined) {
    const what = date === undefined ? `the date “${valueOf(trn, 'DTPOSTED') ?? ''}”` : `the amount “${valueOf(trn, 'TRNAMT') ?? ''}”`
    warnings.push({ message: `${where}: a transaction${id ? ` (${id})` : ''} was left out: ${what} can't be read.` })
    return undefined
  }
  const userDate = ofxDate(valueOf(trn, 'DTUSER'))
  const type = valueOf(trn, 'TRNTYPE')?.toUpperCase()
  // NAME is the payee's name; some banks send it in a PAYEE aggregate (PAYEE › NAME) instead, which valueOf also finds
  const payee = valueOf(trn, 'NAME')
  const memo = valueOf(trn, 'MEMO')
  const number = valueOf(trn, 'CHECKNUM')
  return {
    date, amount,
    ...(userDate !== undefined && userDate !== date && { userDate }),
    ...(payee !== undefined && { payee }),
    ...(memo !== undefined && { memo }),
    ...(number !== undefined && { number }),
    ...(id !== undefined && { externalId: id }),
    ...(type !== undefined && KINDS[type] !== undefined && { kind: KINDS[type] })
  }
}

/** Lines alike in everything the bank says about them: the same line sent twice, not two transactions. */
const sameLine = (a: StatementLine, b: StatementLine) =>
  a.date === b.date && a.amount === b.amount && a.payee === b.payee && a.memo === b.memo && a.number === b.number

/**
 * Why a statement's bank ids can't be trusted to name the same transaction in another file, or undefined when they
 * can. Conversion tools (PDF or CSV to QBO, most often) make ids up:
 * - 'counter': they number the lines, 1, 2, 3… in every file. At least 3 lines, every id a plain number of at most
 *   6 digits, and the ids, sorted, one after another;
 * - 'reused': two different lines share an id. (One line sent twice, alike in everything, is just a repeat.)
 * Real FITIDs are long, or dated, or sparse, so a bank's own ids pass. See docs/import-formats-design.md, "Made-up
 * bank ids".
 */
export function madeUpIds(lines: readonly StatementLine[]): { why: 'counter' | 'reused', example: string } | undefined {
  const byId = new Map<string, StatementLine>()
  for (const line of lines) {
    if (line.externalId === undefined) continue
    const seen = byId.get(line.externalId)
    if (seen && !sameLine(seen, line)) return { why: 'reused', example: line.externalId }
    byId.set(line.externalId, line)
  }
  if (lines.length < 3 || !lines.every(line => line.externalId !== undefined && /^\d{1,6}$/.test(line.externalId))) return undefined
  const numbers = [...new Set(lines.map(line => Number(line.externalId)))].sort((a, b) => a - b)
  if (numbers[numbers.length - 1] - numbers[0] !== numbers.length - 1) return undefined
  return { why: 'counter', example: numbers.slice(0, 3).join(', ') }
}

function statementOf(rs: OfxNode, account: StatementAccount, where: string, warnings: ParseWarning[]): ParsedStatement {
  const list = findAll(rs, 'BANKTRANLIST')[0]
  const currency = valueOf(rs, 'CURDEF')?.toUpperCase()
  let from = ofxDate(valueOf(list, 'DTSTART'))
  let to = ofxDate(valueOf(list, 'DTEND'))
  // A period that ends before it starts isn't one (a bank seen giving the download's date as its start): the lines' own
  // dates say what the statement covers
  if (from !== undefined && to !== undefined && from > to) { from = undefined; to = undefined }
  const ledgerBalance = findAll(rs, 'LEDGERBAL')[0]
  const balance = ofxAmount(valueOf(ledgerBalance, 'BALAMT'))
  const asOf = ofxDate(valueOf(ledgerBalance, 'DTASOF'))
  const lines = (list ? findAll(list, 'STMTTRN') : [])
    .map(trn => lineOf(trn, where, warnings))
    .filter((line): line is StatementLine => line !== undefined)
  // Ids a tool made up would drop the next file's lines as duplicates: the lines are known by their content instead
  const madeUp = madeUpIds(lines)
  if (madeUp) {
    warnings.push({
      message: madeUp.why === 'counter'
        ? `${where}: the transaction ids look made up (${madeUp.example}…), so its lines are recognised by their content instead.`
        : `${where}: the same transaction id (“${madeUp.example}”) is given to different transactions, so its lines are recognised by their content instead.`
    })
  }
  return {
    account,
    ...(madeUp && { stableIds: false }),
    ...(currency !== undefined && { currency }),
    ...((from !== undefined || to !== undefined) && { period: { ...(from && { from }), ...(to && { to }) } }),
    ...(balance !== undefined && asOf !== undefined && { balance: { amount: balance, asOf } }),
    lines
  }
}

/** The institution, from the sign-on's financial institution (FI › ORG), if the file names it. */
function institutionOf(root: OfxNode): string | undefined {
  const signOn = findAll(root, 'SONRS')[0]
  return valueOf(signOn ? findAll(signOn, 'FI')[0] : undefined, 'ORG')
}

/** A statement's account, and its identity across files: the bank (or card) and the account number. */
function bankAccount(from: OfxNode | undefined, institution: string | undefined): StatementAccount {
  const bankId = valueOf(from, 'BANKID') ?? ''
  const number = valueOf(from, 'ACCTID') ?? ''
  const type = ACCOUNT_TYPES[valueOf(from, 'ACCTTYPE')?.toUpperCase() ?? '']
  return {
    ...(number !== '' && { key: `ofx:bank:${bankId}:${number}`, keyStrength: 'strong' as const, accountNumber: number }),
    ...(number !== '' && isMasked(number) && { numberIsPartial: true }),
    label: `${institution ?? (bankId !== '' ? `Bank ${bankId}` : 'Bank account')}${number !== '' ? ` •••• ${lastDigits(number)}` : ''}`,
    ...(institution !== undefined && { institution }),
    ...(type !== undefined && { type })
  }
}

function cardAccount(from: OfxNode | undefined, institution: string | undefined): StatementAccount {
  const number = valueOf(from, 'ACCTID') ?? ''
  return {
    ...(number !== '' && { key: `ofx:card:${number}`, keyStrength: 'strong' as const, accountNumber: number }),
    ...(number !== '' && isMasked(number) && { numberIsPartial: true }),
    label: `${institution ?? 'Credit card'}${number !== '' ? ` •••• ${lastDigits(number)}` : ''}`,
    ...(institution !== undefined && { institution }),
    type: 'creditCard'
  }
}

/** Every statement in the document, with warnings for the transactions left out. */
export function statementsOf(root: OfxNode): { statements: ParsedStatement[], warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  const institution = institutionOf(root)
  const statements: ParsedStatement[] = []
  for (const rs of findAll(root, 'STMTRS')) {
    const account = bankAccount(findAll(rs, 'BANKACCTFROM')[0], institution)
    statements.push(statementOf(rs, account, account.label ?? 'A bank statement', warnings))
  }
  for (const rs of findAll(root, 'CCSTMTRS')) {
    const account = cardAccount(findAll(rs, 'CCACCTFROM')[0], institution)
    statements.push(statementOf(rs, account, account.label ?? 'A card statement', warnings))
  }
  return { statements, warnings }
}

/** The error a bank sent instead of a statement (a STATUS of severity ERROR), if that is all the file holds. */
export function errorOf(root: OfxNode): string | undefined {
  for (const status of findAll(root, 'STATUS')) {
    if (valueOf(status, 'SEVERITY')?.toUpperCase() === 'ERROR') {
      return valueOf(status, 'MESSAGE') ?? `The bank reported error ${valueOf(status, 'CODE') ?? 'with no code'}.`
    }
  }
}
