// @vitest-environment node
// The OFX 2.x writer, and the round trip through the real reader — which is the sharpest check available that
// the two halves agree, since the reader was written long before the writer and knows nothing about it.
import { describe, expect, it } from 'vitest'
import type { ExchangeDocument } from '@tessera/exchange-api'
import { OFX_FORMATS, readOfx, writeOfx } from '../../../plugins/exchange.ofx/src/privileged/index'
import {
  OFX_VERSION, escapeXml, ofxAccountType, ofxAmount, ofxDate
} from '../../../plugins/exchange.ofx/src/privileged/writer'

const text = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)

const document = (over: Partial<ExchangeDocument> = {}): ExchangeDocument => ({
  formatId: OFX_FORMATS.ofx,
  generatedAt: '2026-11-18T09:00:00.000Z',
  statements: [{
    account: { name: 'Chequing', number: '1234567890', bankId: '001002003', type: 'chequing', currency: 'CAD' },
    period: { from: '2026-10-01', to: '2026-10-31' },
    balances: { ledger: { amount: 500000, asOf: '2026-10-31' } },
    transactions: [
      { date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa', memo: 'November', number: '1042', externalId: 'T1', cleared: 'cleared' },
      { date: '2026-10-25', amount: 214000, payee: 'Acme Widgets', category: 'Salary', externalId: 'T2' }
    ]
  }],
  unsupported: [],
  warnings: [],
  ...over
})

const card = (): ExchangeDocument => document({
  statements: [{
    account: { name: 'Visa', number: '4512', type: 'creditCard', currency: 'CAD' },
    transactions: [{ date: '2026-10-05', amount: -4500, payee: 'The Daily Grind', externalId: 'C1' }]
  }]
})

describe('the header', () => {
  it('declares OFX 2.x as XML, and nothing about 1.x', () => {
    const written = text(writeOfx(document()))
    expect(written.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(written).toContain(`VERSION="${OFX_VERSION}"`)
    expect(written).toContain('OFXHEADER="200"')
    // The 1.x header block is a colon-delimited preamble; none of it belongs in a 2.x file.
    expect(written).not.toMatch(/^OFXHEADER:/m)
    expect(written).not.toMatch(/^DATA:OFXSGML/m)
    expect(written).not.toContain('CHARSET')
  })

  it('names Tessera as the institution and writes no Intuit tags', () => {
    const written = text(writeOfx(document()))
    expect(written).toContain('<ORG>Tessera</ORG>')
    expect(written).not.toContain('INTU.BID')
    expect(written).not.toContain('INTU.USERID')
  })

  it('is well-formed: every tag opened is closed, as 2.x requires', () => {
    const written = text(writeOfx(document()))
    const opened: string[] = []
    for (const [, closing, tag] of written.matchAll(/<(\/?)([A-Z][A-Z0-9.]*)>/g)) {
      if (closing === '') opened.push(tag)
      else expect(opened.pop()).toBe(tag)
    }
    expect(opened).toEqual([])
  })
})

describe('a bank statement', () => {
  it('writes STMTRS under BANKMSGSRSV1, with the account and the period', () => {
    const written = text(writeOfx(document()))
    expect(written).toContain('<BANKMSGSRSV1>')
    expect(written).toContain('<STMTRS>')
    expect(written).toContain('<BANKID>001002003</BANKID>')
    expect(written).toContain('<ACCTID>1234567890</ACCTID>')
    expect(written).toContain('<ACCTTYPE>CHECKING</ACCTTYPE>')
    expect(written).toContain('<DTSTART>20261001</DTSTART>')
    expect(written).toContain('<DTEND>20261031</DTEND>')
    expect(written).toContain('<LEDGERBAL>')
    expect(written).toContain('<BALAMT>5000.00</BALAMT>')
  })

  it('writes each row with the FITID the book will recognise next time', () => {
    const written = text(writeOfx(document()))
    expect(written).toContain('<FITID>T1</FITID>')
    expect(written).toContain('<TRNAMT>-142.00</TRNAMT>')
    expect(written).toContain('<CHECKNUM>1042</CHECKNUM>')
    expect(written).toContain('<NAME>Hydro Ottawa</NAME>')
  })

  it('derives TRNTYPE from the sign, which is all a reader does with it', () => {
    const written = text(writeOfx(document()))
    expect(written).toContain('<TRNTYPE>DEBIT</TRNTYPE>')
    expect(written).toContain('<TRNTYPE>CREDIT</TRNTYPE>')
  })
})

describe('a credit-card statement', () => {
  it('goes in its own message set, where a reader actually looks for it', () => {
    const written = text(writeOfx(card()))
    expect(written).toContain('<CREDITCARDMSGSRSV1>')
    expect(written).toContain('<CCSTMTRS>')
    expect(written).toContain('<CCACCTFROM>')
    // A card account has no ACCTTYPE and no BANKID in OFX.
    expect(written).not.toContain('<ACCTTYPE>')
    expect(written).not.toContain('<BANKID>')
  })

  it('writes both message sets for a document holding both kinds', () => {
    const both = document({ statements: [...document().statements, ...card().statements] })
    const written = text(writeOfx(both))
    expect(written).toContain('<BANKMSGSRSV1>')
    expect(written).toContain('<CREDITCARDMSGSRSV1>')
  })
})

describe('escaping', () => {
  it('escapes XML’s five characters, because a payee really can contain them', () => {
    expect(escapeXml(`Smith & Sons <"Ltd"> 'x'`)).toBe('Smith &amp; Sons &lt;&quot;Ltd&quot;&gt; &apos;x&apos;')
  })

  it('writes a file that is still well-formed with such a payee in it', () => {
    const tricky = document()
    tricky.statements[0].transactions = [
      { date: '2026-10-15', amount: -100, payee: 'Smith & Sons <Ltd>', memo: 'a "quoted" note', externalId: 'X1' }
    ]
    const written = text(writeOfx(tricky))
    expect(written).toContain('<NAME>Smith &amp; Sons &lt;Ltd&gt;</NAME>')
    // Every ampersand in the file begins a real entity: a bare `&` is what makes an XML parser give up.
    expect([...written.matchAll(/&(?![a-z]+;|#\d+;)/g)]).toEqual([])
  })
})

describe('amounts and dates', () => {
  it('writes a plain signed decimal with no grouping', () => {
    expect(ofxAmount(-14200)).toBe('-142.00')
    expect(ofxAmount(123456789)).toBe('1234567.89')
    expect(ofxAmount(0)).toBe('0.00')
    expect(ofxAmount(-5)).toBe('-0.05')
  })

  it('writes a date with no time and no zone, since a zone can move a row across a statement boundary', () => {
    expect(ofxDate('2026-10-15')).toBe('20261015')
    expect(text(writeOfx(document()))).not.toMatch(/<DTPOSTED>\d{8}\d/)
  })

  it('maps Tessera’s account types onto ACCTTYPE', () => {
    expect(ofxAccountType('savings')).toBe('SAVINGS')
    expect(ofxAccountType('chequing')).toBe('CHECKING')
    expect(ofxAccountType('lineOfCredit')).toBe('CREDITLINE')
    expect(ofxAccountType(undefined)).toBe('CHECKING')
  })
})

describe('what the file must still have when the model is thin', () => {
  it('writes the required LEDGERBAL and period even with no balance and no period recorded', () => {
    const bare = document({
      statements: [{
        account: { name: 'Chequing' },
        transactions: [{ date: '2026-10-15', amount: -14200, payee: 'A', externalId: 'T1' }]
      }]
    })
    const written = text(writeOfx(bare))
    // The sum of what is here is the honest balance when none was recorded.
    expect(written).toContain('<BALAMT>-142.00</BALAMT>')
    expect(written).toContain('<DTSTART>20261015</DTSTART>')
    expect(written).toContain('<ACCTID>Chequing</ACCTID>')
  })
})

describe('the round trip', () => {
  const roundTrip = async (doc: ExchangeDocument) =>
    readOfx(writeOfx(doc), { formatId: OFX_FORMATS.ofx, signs: 'asGiven' })

  it('carries what OFX claims to carry', async () => {
    const read = await roundTrip(document())
    const rows = read.statements[0].transactions
    const original = document().statements[0].transactions

    expect(read.warnings).toEqual([])
    expect(rows.map(r => r.date)).toEqual(original.map(r => r.date))
    expect(rows.map(r => r.amount)).toEqual(original.map(r => r.amount))
    expect(rows.map(r => r.payee)).toEqual(original.map(r => r.payee))
    expect(rows.map(r => r.externalId)).toEqual(['T1', 'T2'])
    expect(rows[0].number).toBe('1042')
    expect(read.statements[0].account.number).toBe('1234567890')
    expect(read.statements[0].account.bankId).toBe('001002003')
    expect(read.statements[0].account.currency).toBe('CAD')
    expect(read.statements[0].balances?.ledger?.amount).toBe(500000)
  })

  it('leaves out what OFX has no way to carry, rather than inventing it', async () => {
    const read = await roundTrip(document())
    const rows = read.statements[0].transactions
    // OFX has no category, no transfer and no clearing status. The first two survive only as memo text.
    expect(rows.every(r => r.category === undefined)).toBe(true)
    expect(rows.every(r => r.transferAccount === undefined)).toBe(true)
    expect(rows.every(r => r.cleared === undefined)).toBe(true)
    expect(rows[1].memo).toBe('Salary')
  })

  it('notes a transfer in the memo rather than dropping it silently', async () => {
    const withTransfer = document()
    withTransfer.statements[0].transactions = [
      { date: '2026-10-20', amount: -50000, payee: 'To savings', transferAccount: 'Savings', externalId: 'T3' }
    ]
    const read = await roundTrip(withTransfer)
    expect(read.statements[0].transactions[0].memo).toBe('Transfer: Savings')
  })

  it('brings a credit-card statement back as a credit-card statement', async () => {
    const read = await roundTrip(card())
    expect(read.statements[0].account.type).toBe('creditCard')
    expect(read.statements[0].transactions[0].amount).toBe(-4500)
  })

  it('survives a payee holding XML’s own characters', async () => {
    const tricky = document()
    tricky.statements[0].transactions = [
      { date: '2026-10-15', amount: -100, payee: 'Smith & Sons <Ltd>', externalId: 'X1' }
    ]
    const read = await roundTrip(tricky)
    expect(read.statements[0].transactions[0].payee).toBe('Smith & Sons <Ltd>')
  })

  it('round-trips a figure that a float would get wrong', async () => {
    const cents = document()
    cents.statements[0].transactions = [
      { date: '2026-10-15', amount: -7, payee: 'Seven cents', externalId: 'P1' },
      { date: '2026-10-16', amount: -1070, payee: 'Ten seventy', externalId: 'P2' }
    ]
    const read = await roundTrip(cents)
    expect(read.statements[0].transactions.map(r => r.amount)).toEqual([-7, -1070])
  })
})

describe('the bank’s own identifiers', () => {
  it('writes the account’s routing number as BANKID when it has one', () => {
    expect(text(writeOfx(document()))).toContain('<BANKID>001002003</BANKID>')
  })

  it('leaves BANKID out when the account has none, rather than inventing one', () => {
    const noRouting = document()
    delete noRouting.statements[0].account.bankId
    const written = text(writeOfx(noRouting))
    // `BANKID` means a routing or transit number; a plausible-looking wrong one is worse than none, because a
    // receiving program keys the account on it.
    expect(written).not.toContain('<BANKID>')
    expect(written).not.toContain('Tessera</BANKID>')
    // `Tessera` still names the institution that produced the file, which is what ORG is for.
    expect(written).toContain('<ORG>Tessera</ORG>')
  })

  it('round-trips both identifiers, which is how next month’s statement finds the same account', async () => {
    const read = await readOfx(writeOfx(document()), { formatId: OFX_FORMATS.ofx, signs: 'asGiven' })
    expect(read.statements[0].account).toMatchObject({ bankId: '001002003', number: '1234567890' })
  })
})

describe('a currency that does not have two decimals', () => {
  // The writer used to write two decimals for every currency while the reader scaled by the currency's own, so
  // ¥1500 came back as ¥15 and 1.234 BHD as 12.340.
  const inCurrency = (currency: string, amount: number): ExchangeDocument => document({
    statements: [{
      account: { name: 'Account', number: '1', currency, type: 'chequing' },
      balances: { ledger: { amount, asOf: '2026-10-31' } },
      transactions: [{ date: '2026-10-15', amount, payee: 'A', externalId: 'T1' }]
    }]
  })

  it('writes and reads back a yen amount, which has no minor unit', async () => {
    const written = text(writeOfx(inCurrency('JPY', -1500)))
    expect(written).toContain('<TRNAMT>-1500</TRNAMT>')
    const read = await readOfx(writeOfx(inCurrency('JPY', -1500)), { formatId: OFX_FORMATS.ofx, signs: 'asGiven' })
    expect(read.statements[0].transactions[0].amount).toBe(-1500)
    expect(read.statements[0].balances?.ledger?.amount).toBe(-1500)
  })

  it('writes and reads back a dinar amount, which has three', async () => {
    expect(text(writeOfx(inCurrency('BHD', 1234)))).toContain('<TRNAMT>1.234</TRNAMT>')
    const read = await readOfx(writeOfx(inCurrency('BHD', 1234)), { formatId: OFX_FORMATS.ofx, signs: 'asGiven' })
    expect(read.statements[0].transactions[0].amount).toBe(1234)
  })

  it('still writes two for a two-decimal currency, small amounts included', () => {
    expect(ofxAmount(-5, 2)).toBe('-0.05')
    expect(ofxAmount(123456, 2)).toBe('1234.56')
    expect(ofxAmount(7, 3)).toBe('0.007')
    expect(ofxAmount(0, 0)).toBe('0')
  })
})
