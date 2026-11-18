// The OFX tree as the neutral model: statements, transactions, balances, and an honest account of everything
// the file carried that Tessera has nowhere to put.
import { minorDigits } from '@tessera/accounts-api'
import {
  ExchangeError,
  type ExchangeDocument, type ExchangeStatement, type ExchangeTransaction, type ExchangeWarning,
  type UnsupportedRecords
} from '@tessera/exchange-api'
import { decode } from './encoding'
import { find, findAll, findDeep, text, tokenize, type OfxNode } from './tokenizer'
import { accountTypeOf, applySign, parseAmount, parseDate, type SignConvention } from './values'

export interface ReadOfxOptions {
  formatId: string
  /** How the file signs its amounts. Settled by a previous import, or `asGiven`. */
  signs?: SignConvention
}

/** Counts of what was recognised and dropped, gathered as the read goes and reported as one list. */
class Unsupported {
  private readonly counts = new Map<string, { count: number, detail?: string }>()

  add(kind: string, detail?: string, by = 1) {
    const found = this.counts.get(kind)
    if (found === undefined) this.counts.set(kind, { count: by, ...(detail !== undefined && { detail }) })
    else found.count += by
  }

  list(): UnsupportedRecords[] {
    return [...this.counts.entries()].map(([kind, { count, detail }]) => ({
      kind, count, ...(detail !== undefined && { detail })
    }))
  }
}

export function readOfx(data: Uint8Array, options: ReadOfxOptions): ExchangeDocument {
  const { text: source, header, warnings: decodeWarnings } = decode(data)
  const { root, problems } = tokenize(source)
  const ofx = root.children.find(node => node.tag === 'OFX') ?? findDeep(root, 'OFX')

  if (ofx === undefined) {
    throw new ExchangeError('UNREADABLE', 'This file has no <OFX> section, so it is not an OFX file.')
  }

  const warnings: ExchangeWarning[] = [...decodeWarnings]
  for (const problem of problems.slice(0, 20)) {
    warnings.push({ code: 'record.malformed', message: problem.message, source: { line: problem.line } })
  }

  const unsupported = new Unsupported()
  const signs = options.signs ?? 'asGiven'
  const statements: ExchangeStatement[] = []

  for (const node of findAll(ofx, 'STMTRS')) statements.push(readStatement(node, 'bank', signs, warnings, unsupported))
  for (const node of findAll(ofx, 'CCSTMTRS')) statements.push(readStatement(node, 'card', signs, warnings, unsupported))

  countTheRest(ofx, unsupported)
  if (statements.length === 0) refuse(ofx)

  const uniform = uniformSigns(statements)
  if (uniform !== undefined && signs === 'asGiven') {
    warnings.push({
      code: 'signs.uniform',
      message: uniform === 'negative'
        ? 'Every transaction in this file takes money out. If the statement shows money coming in too, the file’s signs are inverted.'
        : 'Every transaction in this file puts money in. If the statement shows money going out too, the file’s signs are inverted.'
    })
  }

  const institution = readInstitution(ofx)
  return {
    formatId: options.formatId,
    dialect: `OFX ${header.version ?? (header.syntax === 'xml' ? '2.x' : '1.x')} (${header.syntax === 'xml' ? 'XML' : 'SGML'})`,
    ...(institution !== undefined && { institution }),
    ...(generatedAt(ofx) !== undefined && { generatedAt: generatedAt(ofx) }),
    statements,
    unsupported: unsupported.list(),
    warnings
  }
}

/** What the file says about the bank. `INTU.USERID` is the user's login there, and is never read. */
function readInstitution(ofx: OfxNode): ExchangeDocument['institution'] | undefined {
  const sonrs = findDeep(ofx, 'SONRS')
  const fi = find(sonrs, 'FI')
  const name = text(fi, 'ORG')
  const fid = text(fi, 'FID')
  // Quicken and QuickBooks identify the bank with an Intuit id instead of, or as well as, the FI block
  const intuit = text(sonrs, 'INTU.BID')
  const id = intuit ?? fid

  if (name === undefined && id === undefined) return undefined
  return {
    ...(name !== undefined && { name }),
    ...(id !== undefined && { id })
  }
}

const generatedAt = (ofx: OfxNode): string | undefined => {
  const date = parseDate(text(findDeep(ofx, 'SONRS'), 'DTSERVER'))
  return date === undefined ? undefined : `${date}T00:00:00.000Z`
}

function readStatement(
  node: OfxNode, kind: 'bank' | 'card', signs: SignConvention,
  warnings: ExchangeWarning[], unsupported: Unsupported
): ExchangeStatement {
  const currency = text(node, 'CURDEF')?.toUpperCase()
  const digits = currency === undefined ? 2 : safeDigits(currency)
  const from = find(node, kind === 'card' ? 'CCACCTFROM' : 'BANKACCTFROM') ?? findDeep(node, 'CCACCTFROM') ?? findDeep(node, 'BANKACCTFROM')

  const rawType = text(from, 'ACCTTYPE')
  const account: ExchangeStatement['account'] = {
    ...(text(from, 'ACCTID') !== undefined && { number: text(from, 'ACCTID') }),
    ...(text(from, 'BANKID') !== undefined && { bankId: text(from, 'BANKID') }),
    ...(currency !== undefined && { currency }),
    ...(rawType !== undefined && { rawType }),
    // A credit-card response is a credit card whatever else it says
    ...(kind === 'card' ? { type: 'creditCard' as const } : accountTypeOf(rawType) !== undefined ? { type: accountTypeOf(rawType)! } : {})
  }

  const list = find(node, 'BANKTRANLIST') ?? findDeep(node, 'BANKTRANLIST')
  const period = readPeriod(list)
  const transactions: ExchangeTransaction[] = []

  for (const [at, row] of findAll(list, 'STMTTRN').entries()) {
    const read = readTransaction(row, at, currency, digits, signs, warnings, unsupported)
    if (read !== undefined) transactions.push(read)
  }

  const balances = readBalances(node, digits, warnings)
  return {
    account,
    ...(period !== undefined && { period }),
    ...(balances !== undefined && { balances }),
    transactions
  }
}

function safeDigits(currency: string): number {
  try {
    return minorDigits(currency)
  } catch { return 2 }
}

function readPeriod(list: OfxNode | undefined): ExchangeStatement['period'] | undefined {
  const from = parseDate(text(list, 'DTSTART'))
  const to = parseDate(text(list, 'DTEND'))
  if (from === undefined && to === undefined) return undefined
  return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) }
}

function readBalances(node: OfxNode, digits: number, warnings: ExchangeWarning[]): ExchangeStatement['balances'] | undefined {
  const one = (tag: string) => {
    const found = find(node, tag) ?? findDeep(node, tag)
    if (found === undefined) return undefined
    const amount = parseAmount(text(found, 'BALAMT'), digits)
    const asOf = parseDate(text(found, 'DTASOF'))
    if (!amount.ok) {
      if (text(found, 'BALAMT') !== undefined) {
        warnings.push({ code: 'amount.unparsable', message: `The ${tag === 'LEDGERBAL' ? 'closing' : 'available'} balance “${text(found, 'BALAMT')}” could not be read.`, source: { line: found.line } })
      }
      return undefined
    }
    return { amount: amount.minor, asOf: asOf ?? '' }
  }

  const ledger = one('LEDGERBAL')
  const available = one('AVAILBAL')
  if (ledger === undefined && available === undefined) return undefined
  return {
    ...(ledger !== undefined && { ledger }),
    ...(available !== undefined && { available })
  }
}

function readTransaction(
  row: OfxNode, at: number, statementCurrency: string | undefined, digits: number,
  signs: SignConvention, warnings: ExchangeWarning[], unsupported: Unsupported
): ExchangeTransaction | undefined {
  const source = { line: row.line, record: at + 1 }

  const date = parseDate(text(row, 'DTPOSTED'))
  if (date === undefined) {
    warnings.push({ code: 'date.unparsable', message: `A transaction has no readable date (“${text(row, 'DTPOSTED') ?? 'none'}”) and was skipped.`, source })
    return undefined
  }

  const amount = parseAmount(text(row, 'TRNAMT'), digits)
  if (!amount.ok) {
    warnings.push({ code: 'amount.unparsable', message: `The transaction of ${date} has no readable amount (“${text(row, 'TRNAMT') ?? 'none'}”) and was skipped.`, source })
    return undefined
  }
  if (amount.rounded === true) {
    warnings.push({ code: 'amount.rounded', message: `The transaction of ${date} was written with more decimal places than ${statementCurrency ?? 'the currency'} has, and was rounded.`, source })
  }

  // A row in a currency of its own is the multi-currency case this release does not handle. A row the bank
  // already converted says so with ORIGCURRENCY instead, and is an ordinary transaction.
  const own = currencyOf(row, 'CURRENCY')
  if (own !== undefined && statementCurrency !== undefined && own.symbol !== statementCurrency) {
    unsupported.add('foreignCurrency', `${own.symbol} transactions cannot be imported yet: Tessera has one currency per account.`)
    return undefined
  }

  const original = currencyOf(row, 'ORIGCURRENCY')
  const trnType = text(row, 'TRNTYPE')
  const payee = readPayee(row, unsupported)
  const correctsId = text(row, 'CORRECTFITID')

  return {
    date,
    ...(postedDate(row, date) !== undefined && { postedDate: postedDate(row, date) }),
    amount: applySign(amount.minor, trnType, signs),
    ...(original !== undefined && original.rate !== undefined && {
      originalAmount: { amount: Math.round(Math.abs(amount.minor) * original.rate), currency: original.symbol }
    }),
    ...(text(row, 'FITID') !== undefined && { externalId: text(row, 'FITID') }),
    ...(correctsId !== undefined && {
      corrects: {
        externalId: correctsId,
        action: (text(row, 'CORRECTACTION') ?? 'REPLACE').toUpperCase() === 'DELETE' ? 'delete' as const : 'replace' as const
      }
    }),
    ...(payee !== undefined && { payee }),
    ...(text(row, 'MEMO') !== undefined && { memo: text(row, 'MEMO') }),
    ...(numberOf(row) !== undefined && { number: numberOf(row) }),
    ...(trnType !== undefined && { kind: trnType }),
    source
  }
}

/** `DTUSER` or `DTAVAIL`: what the bank says about when it moved, shown but never matched on. */
function postedDate(row: OfxNode, date: string): string | undefined {
  const other = parseDate(text(row, 'DTUSER')) ?? parseDate(text(row, 'DTAVAIL'))
  return other === undefined || other === date ? undefined : other
}

/** `CHECKNUM`, else `REFNUM`: the cheque number, or whatever reference the bank prints beside the row. */
const numberOf = (row: OfxNode) => text(row, 'CHECKNUM') ?? text(row, 'REFNUM')

/**
 * `NAME`, or the structured `PAYEE` block. The block's address lines have nowhere to go, so they are counted
 * rather than dropped quietly — a reader that loses something should always be able to say how much.
 */
function readPayee(row: OfxNode, unsupported: Unsupported): string | undefined {
  const block = find(row, 'PAYEE')
  if (block !== undefined) {
    const lines = ['ADDR1', 'ADDR2', 'ADDR3', 'CITY', 'STATE', 'POSTALCODE', 'COUNTRY', 'PHONE']
      .filter(tag => text(block, tag) !== undefined).length
    if (lines > 0) unsupported.add('payeeAddress', 'Payee addresses are not stored; the name was kept.', lines)
    return text(block, 'NAME') ?? text(row, 'NAME')
  }
  return text(row, 'NAME')
}

/** A `CURRENCY` or `ORIGCURRENCY` block: the symbol, and the rate when the bank gave one. */
function currencyOf(row: OfxNode, tag: 'CURRENCY' | 'ORIGCURRENCY'): { symbol: string, rate?: number } | undefined {
  const block = find(row, tag)
  const symbol = text(block, 'CURSYM') ?? text(row, tag)
  if (symbol === undefined || !/^[A-Za-z]{3}$/.test(symbol)) return undefined
  const rate = parseAmount(text(block, 'CURRATE'), 6)
  return { symbol: symbol.toUpperCase(), ...(rate.ok && rate.minor > 0 && { rate: rate.minor / 1_000_000 }) }
}

/** Investments, securities and anything else the file carried that this release has no home for. */
function countTheRest(ofx: OfxNode, unsupported: Unsupported) {
  const investments = findAll(ofx, 'INVTRANLIST')
    .reduce((total, list) => total + list.children.filter(child => child.tag !== 'DTSTART' && child.tag !== 'DTEND').length, 0)
  if (investments > 0) {
    unsupported.add('investment', 'Tessera has no investment accounts yet, so buys, sells and dividends were skipped.', investments)
  } else if (findAll(ofx, 'INVSTMTRS').length > 0) {
    unsupported.add('investment', 'Tessera has no investment accounts yet.', findAll(ofx, 'INVSTMTRS').length)
  }

  const securities = findAll(ofx, 'SECLIST').reduce((total, list) => total + list.children.length, 0)
  if (securities > 0) unsupported.add('security', 'Security definitions were skipped.', securities)
}

/**
 * A file with no statement in it. When the bank put an error code in the response, that is what the user needs
 * to be told — not that the file is malformed, which it is not.
 */
function refuse(ofx: OfxNode): never {
  for (const status of findAll(ofx, 'STATUS')) {
    const code = text(status, 'CODE')
    if (code === undefined || code === '0') continue
    const message = text(status, 'MESSAGE')
    throw new ExchangeError('UNREADABLE',
      `The bank reported a problem instead of a statement${message === undefined ? '' : `: ${message}`} (code ${code}).`)
  }
  throw new ExchangeError('EMPTY', 'This file holds no statement.')
}

/** `'negative'` or `'positive'` when every transaction in the file goes the same way, else undefined. */
function uniformSigns(statements: readonly ExchangeStatement[]): 'negative' | 'positive' | undefined {
  const amounts = statements.flatMap(statement => statement.transactions.map(row => row.amount)).filter(amount => amount !== 0)
  if (amounts.length < 4) return undefined
  if (amounts.every(amount => amount < 0)) return 'negative'
  if (amounts.every(amount => amount > 0)) return 'positive'
  return undefined
}
