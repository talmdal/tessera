// @vitest-environment node
// The parts of OFX that the seeded fixtures cannot show: the SGML quirks, the encodings, the sign
// conventions, corrections, and everything a bank might put in a file that Tessera has nowhere to put.
import { describe, expect, it } from 'vitest'
import { OFX_FORMATS, readOfx, sniffOfx } from '../../../plugins/exchange.ofx/src/privileged/index'
import { decodeEntities, find, findAll, text, tokenize } from '../../../plugins/exchange.ofx/src/privileged/tokenizer'
import { codecFor, decode, looksLikeXml } from '../../../plugins/exchange.ofx/src/privileged/encoding'
import { applySign, parseAmount, parseDate } from '../../../plugins/exchange.ofx/src/privileged/values'

const utf8 = (text: string) => new TextEncoder().encode(text)
const bytes = (...values: number[]) => new Uint8Array(values)

/** An OFX 1.x file around a body, with the header a bank writes. */
const sgml = (body: string, header: Record<string, string> = {}) => {
  const fields = {
    OFXHEADER: '100', DATA: 'OFXSGML', VERSION: '102', SECURITY: 'NONE',
    ENCODING: 'USASCII', CHARSET: '1252', COMPRESSION: 'NONE', OLDFILEUID: 'NONE', NEWFILEUID: 'NONE',
    ...header
  }
  return Object.entries(fields).map(([k, v]) => `${k}:${v}`).join('\r\n') + '\r\n\r\n' + body
}

/** A whole bank statement around a list of `<STMTTRN>` blocks. */
const statement = (rows: string, options: { currency?: string, balance?: string } = {}) => sgml(`<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>${options.currency ?? 'CAD'}
<BANKACCTFROM><BANKID>021000021<ACCTID>00412-1234567<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031
${rows}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>${options.balance ?? '100.00'}<DTASOF>20261031</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`)

const row = (inner: string) => `<STMTTRN>${inner}</STMTTRN>`
const basic = (over = '') => row(`<TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-14.20<FITID>A1<NAME>Hydro${over}`)

const parse = (source: string | Uint8Array, formatId = OFX_FORMATS.ofx, signs?: 'asGiven' | 'invert' | 'fromType') =>
  readOfx(typeof source === 'string' ? utf8(source) : source, { formatId, ...(signs !== undefined && { signs }) })

const only = (source: string) => parse(statement(source)).statements[0].transactions[0]

describe('the tokeniser', () => {
  it('closes an unclosed leaf when the next tag opens', () => {
    const { root, problems } = tokenize('<STATUS><CODE>0<SEVERITY>INFO</STATUS>')
    const status = find(root, 'STATUS')
    expect(text(status, 'CODE')).toBe('0')
    expect(text(status, 'SEVERITY')).toBe('INFO')
    // Both are children of STATUS, not of each other
    expect(status?.children.map(c => c.tag)).toEqual(['CODE', 'SEVERITY'])
    expect(problems).toEqual([])
  })

  it('closes a dangling leaf when its parent closes', () => {
    const { root } = tokenize('<A><B><C>value</A><D>after</D>')
    expect(text(find(root, 'A', 'B'), 'C')).toBe('value')
    expect(text(root, 'D')).toBe('after')
  })

  it('reads well-formed XML as the case where every leaf is closed', () => {
    const { root, problems } = tokenize('<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>')
    const status = find(root, 'STATUS')
    expect(status?.children.map(c => c.tag)).toEqual(['CODE', 'SEVERITY'])
    expect(text(status, 'CODE')).toBe('0')
    expect(problems).toEqual([])
  })

  it('skips declarations, instructions and comments', () => {
    const { root } = tokenize('<?xml version="1.0"?><!-- a note --><?OFX VERSION="211"?><A>1</A>')
    expect(root.children.map(c => c.tag)).toEqual(['A'])
  })

  it('handles an element with attributes, and one that closes itself', () => {
    const { root } = tokenize('<A id="1"><B/><C>x</C></A>')
    const a = find(root, 'A')
    expect(a?.children.map(c => c.tag)).toEqual(['B', 'C'])
    expect(find(a, 'B')?.value).toBe('')
  })

  it('reports a closing tag that was never opened, and one never closed', () => {
    expect(tokenize('<A>1</A></B>').problems[0].message).toMatch(/never opened/)
    expect(tokenize('<A><B>1').problems.some(p => /never closed/.test(p.message))).toBe(true)
  })

  it('counts lines, so a warning can point at one', () => {
    const { root } = tokenize('<A>\n<B>\n<C>x</C>\n</B>\n</A>')
    expect(find(root, 'A', 'B', 'C')?.line).toBe(3)
  })

  it('decodes entities, and leaves alone anything it does not know', () => {
    expect(decodeEntities('Smith &amp; Sons')).toBe('Smith & Sons')
    expect(decodeEntities('&lt;tag&gt; &quot;q&quot; &apos;a&apos;')).toBe('<tag> "q" \'a\'')
    expect(decodeEntities('caf&#233; &#xe9;')).toBe('café é')
    expect(decodeEntities('&unknown; 100% &')).toBe('&unknown; 100% &')
  })

  it('finds a tag at any depth, and all of them', () => {
    const { root } = tokenize('<A><B><C>1</C></B><B><C>2</C></B></A>')
    expect(findAll(root, 'C').map(node => node.value)).toEqual(['1', '2'])
  })
})

describe('encodings', () => {
  it('reads a Windows-1252 body declared as USASCII with CHARSET:1252', () => {
    const body = statement(basic().replace('Hydro', 'Café'))
    const data = Buffer.from(body, 'latin1')
    const document = parse(new Uint8Array(data))
    expect(document.statements[0].transactions[0].payee).toBe('Café')
    expect(document.warnings.filter(w => w.code === 'encoding.replaced')).toEqual([])
  })

  it('reads a UTF-8 body when the header says so', () => {
    const document = parse(utf8(statement(basic().replace('Hydro', 'Café'), {}).replace('ENCODING:USASCII', 'ENCODING:UTF-8')))
    expect(document.statements[0].transactions[0].payee).toBe('Café')
  })

  it('reports a byte it could not read, once, rather than losing it silently', () => {
    // The file says UTF-8, and 0xC3 followed by an ASCII letter is not valid UTF-8
    const source = statement(basic().replace('Hydro', '\u0000ydro')).replace('ENCODING:USASCII', 'ENCODING:UTF-8')
    const broken = new Uint8Array(Buffer.from(source, 'latin1'))
    broken[broken.indexOf(0x00)] = 0xc3
    const document = readOfx(broken, { formatId: OFX_FORMATS.ofx })
    const replaced = document.warnings.filter(w => w.code === 'encoding.replaced')
    expect(replaced).toHaveLength(1)
    expect(replaced[0].message).toMatch(/could not be read/)
    // And the row is still imported: a mangled payee is better than a lost transaction
    expect(document.statements[0].transactions).toHaveLength(1)
  })

  it('chooses a codec from what the header declares', () => {
    expect(codecFor('USASCII', '1252')).toBe('windows-1252')
    expect(codecFor('UTF-8', '1252')).toBe('utf-8')
    expect(codecFor('USASCII', 'NONE')).toBe('windows-1252')
    expect(codecFor('USASCII', '8859-1')).toBe('iso-8859-1')
    expect(codecFor(undefined, undefined)).toBe('windows-1252')
  })

  it('tells the two syntaxes apart, and strips a BOM', () => {
    expect(looksLikeXml('<?xml version="1.0"?><OFX>')).toBe(true)
    expect(looksLikeXml('<?OFX OFXHEADER="200"?>')).toBe(true)
    expect(looksLikeXml('OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX>')).toBe(false)

    const withBom = new Uint8Array([...bytes(0xef, 0xbb, 0xbf), ...utf8('<?xml version="1.0"?><OFX><A>1</A></OFX>')])
    expect(decode(withBom).text.startsWith('<?xml')).toBe(true)
    expect(decode(withBom).header.syntax).toBe('xml')
  })

  it('reads an XML file that declares Windows-1252', () => {
    const body = '<?xml version="1.0" encoding="windows-1252"?>\n' + statement(basic().replace('Hydro', 'é')).split('\r\n\r\n')[1]
    const document = parse(new Uint8Array(Buffer.from(body, 'latin1')))
    expect(document.statements[0].transactions[0].payee).toBe('é')
  })
})

describe('amounts', () => {
  it('reads a plain decimal without going through a float', () => {
    expect(parseAmount('-142.00')).toMatchObject({ ok: true, minor: -14_200 })
    expect(parseAmount('0.07')).toMatchObject({ ok: true, minor: 7 })
    expect(parseAmount('+1234.56')).toMatchObject({ ok: true, minor: 123_456 })
    expect(parseAmount('12345.67')).toMatchObject({ ok: true, minor: 1_234_567 })
  })

  it('accepts a comma as the decimal separator, as the specification allows', () => {
    expect(parseAmount('-142,00')).toMatchObject({ ok: true, minor: -14_200 })
    expect(parseAmount('1234,5')).toMatchObject({ ok: true, minor: 123_450 })
  })

  it('reads a whole number, and zero', () => {
    expect(parseAmount('-42')).toMatchObject({ ok: true, minor: -4_200 })
    expect(parseAmount('0')).toMatchObject({ ok: true, minor: 0 })
    expect(parseAmount('-0.00')).toMatchObject({ ok: true, minor: 0 })
  })

  it('reads grouping, which gives itself away by repeating or by using both characters', () => {
    expect(parseAmount('1,234.56')).toMatchObject({ ok: true, minor: 123_456 })
    expect(parseAmount('1.234,56')).toMatchObject({ ok: true, minor: 123_456 })
    expect(parseAmount('1.234.567')).toMatchObject({ ok: true, minor: 123_456_700 })
  })

  it('treats a lone separator as the decimal point, because OFX has no grouping', () => {
    // `1,234` is a comma decimal — the reading the specification asks for, not a thousand
    expect(parseAmount('1,234')).toMatchObject({ ok: true, minor: 123, rounded: true })
    expect(parseAmount('142.000')).toMatchObject({ ok: true, minor: 14_200 })
  })

  it('drops trailing zeros beyond the currency, and says so when it has to round', () => {
    const exact = parseAmount('-142.000')
    expect(exact).toMatchObject({ ok: true, minor: -14_200 })
    expect(exact.ok && exact.rounded).toBeUndefined()
    expect(parseAmount('1.005')).toMatchObject({ ok: true, minor: 101, rounded: true })
    expect(parseAmount('9.999')).toMatchObject({ ok: true, minor: 1_000, rounded: true })
  })

  it('honours a currency with no minor units at all', () => {
    expect(parseAmount('1200', 0)).toMatchObject({ ok: true, minor: 1_200 })
    expect(parseAmount('1200.00', 0)).toMatchObject({ ok: true, minor: 1_200 })
  })

  it('refuses what is not an amount', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3.4e5', '--5', undefined]) {
      expect(parseAmount(bad as string | undefined).ok, String(bad)).toBe(false)
    }
  })

  it('skips a row whose amount cannot be read, and says which', () => {
    const document = parse(statement(row('<DTPOSTED>20261003<TRNAMT>wrong<FITID>A1<NAME>Hydro') + basic()))
    expect(document.statements[0].transactions).toHaveLength(1)
    expect(document.warnings.find(w => w.code === 'amount.unparsable')?.message).toMatch(/2026-10-03/)
  })
})

describe('dates', () => {
  it('keeps the calendar date whatever the zone, in both directions', () => {
    // Converting to UTC would move the first back a day and the second forward: a transaction on the wrong
    // side of a statement boundary is worse than one with no time on it
    expect(parseDate('20261103000000[-5:EST]')).toBe('2026-11-03')
    expect(parseDate('20261103000000[+13:NZDT]')).toBe('2026-11-03')
    expect(parseDate('20261103235959.999[0:GMT]')).toBe('2026-11-03')
    expect(parseDate('20261103')).toBe('2026-11-03')
  })

  it('refuses a date that is not one', () => {
    for (const bad of ['', '2026', '20261345', '20260230', 'nonsense', undefined]) {
      expect(parseDate(bad as string | undefined), String(bad)).toBeUndefined()
    }
  })

  it('skips a row with no readable date, and says so', () => {
    const document = parse(statement(row('<TRNAMT>-1.00<FITID>A1<NAME>X') + basic()))
    expect(document.statements[0].transactions).toHaveLength(1)
    expect(document.warnings.some(w => w.code === 'date.unparsable')).toBe(true)
  })

  it('keeps DTUSER as the posted date when it differs from DTPOSTED', () => {
    expect(only(basic('<DTUSER>20261001')).postedDate).toBe('2026-10-01')
    expect(only(basic('<DTUSER>20261003')).postedDate).toBeUndefined()
  })
})

describe('one transaction', () => {
  it('reads every field a statement row carries', () => {
    const read = only(row(
      '<TRNTYPE>CHECK<DTPOSTED>20261003<TRNAMT>-142.00<FITID>FIT-1<CHECKNUM>0144' +
      '<NAME>Ridgeview Landscaping<MEMO>Autumn clear-up'))
    expect(read).toMatchObject({
      date: '2026-10-03', amount: -14_200, externalId: 'FIT-1', number: '0144',
      payee: 'Ridgeview Landscaping', memo: 'Autumn clear-up', kind: 'CHECK'
    })
    expect(read.source).toMatchObject({ record: 1 })
  })

  it('falls back to REFNUM when there is no cheque number', () => {
    expect(only(basic('<REFNUM>R-99')).number).toBe('R-99')
    expect(only(basic('<CHECKNUM>0101<REFNUM>R-99')).number).toBe('0101')
  })

  it('prefers the structured payee block, and counts the address lines it cannot keep', () => {
    const document = parse(statement(row(
      '<DTPOSTED>20261003<TRNAMT>-10.00<FITID>A1<NAME>ignored' +
      '<PAYEE><NAME>Bytown Auto<ADDR1>12 Main St<CITY>Ottawa<POSTALCODE>K1A0B1</PAYEE>')))
    expect(document.statements[0].transactions[0].payee).toBe('Bytown Auto')
    expect(document.unsupported).toEqual([
      { kind: 'payeeAddress', count: 3, detail: expect.stringContaining('addresses') }
    ])
  })

  it('reads a correction as pointing at the row it corrects', () => {
    expect(only(basic('<CORRECTFITID>OLD-1<CORRECTACTION>REPLACE')).corrects)
      .toEqual({ externalId: 'OLD-1', action: 'replace' })
    expect(only(basic('<CORRECTFITID>OLD-1<CORRECTACTION>DELETE')).corrects)
      .toEqual({ externalId: 'OLD-1', action: 'delete' })
    // A correction with no action named is a replacement
    expect(only(basic('<CORRECTFITID>OLD-1')).corrects).toEqual({ externalId: 'OLD-1', action: 'replace' })
  })
})

describe('currencies', () => {
  it('imports a row the bank converted, and notes what it was originally', () => {
    const read = only(row(
      '<DTPOSTED>20261003<TRNAMT>-62.75<FITID>A1<NAME>Hotel Lisboa' +
      '<ORIGCURRENCY><CURRATE>0.680000<CURSYM>EUR</ORIGCURRENCY>'))
    expect(read.amount).toBe(-6_275)
    expect(read.currency).toBeUndefined()
    expect(read.originalAmount).toEqual({ amount: 4_267, currency: 'EUR' })
  })

  it('counts a row in a currency of its own rather than adding it to a balance', () => {
    const document = parse(statement(
      basic() + row('<DTPOSTED>20261004<TRNAMT>-50.00<FITID>A2<NAME>Berlin<CURRENCY><CURRATE>1.5<CURSYM>EUR</CURRENCY>')))
    expect(document.statements[0].transactions).toHaveLength(1)
    expect(document.unsupported).toEqual([
      { kind: 'foreignCurrency', count: 1, detail: expect.stringContaining('EUR') }
    ])
  })

  it('reads a statement in a currency with no minor units', () => {
    const document = parse(statement(
      row('<DTPOSTED>20261003<TRNAMT>-1200<FITID>A1<NAME>Tokyo'), { currency: 'JPY', balance: '5000' }))
    expect(document.statements[0].transactions[0].amount).toBe(-1_200)
    expect(document.statements[0].balances?.ledger?.amount).toBe(5_000)
  })
})

describe('sign conventions', () => {
  const file = statement(
    row('<TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-10.00<FITID>A1<NAME>Out') +
    row('<TRNTYPE>CREDIT<DTPOSTED>20261002<TRNAMT>25.00<FITID>A2<NAME>In'))

  it('takes the file’s signs as given by default', () => {
    expect(parse(file).statements[0].transactions.map(r => r.amount)).toEqual([-1_000, 2_500])
  })

  it('inverts a whole file for an issuer that writes charges positive', () => {
    expect(parse(file, OFX_FORMATS.ofx, 'invert').statements[0].transactions.map(r => r.amount)).toEqual([1_000, -2_500])
  })

  it('takes the direction from the type word for an exporter that signs nothing', () => {
    const positive = statement(
      row('<TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>10.00<FITID>A1<NAME>Out') +
      row('<TRNTYPE>CREDIT<DTPOSTED>20261002<TRNAMT>25.00<FITID>A2<NAME>In'))
    expect(parse(positive, OFX_FORMATS.ofx, 'fromType').statements[0].transactions.map(r => r.amount)).toEqual([-1_000, 2_500])
  })

  it('maps each type word the way a statement means it', () => {
    for (const type of ['DEBIT', 'FEE', 'SRVCHG', 'ATM', 'POS', 'CHECK', 'PAYMENT', 'DIRECTDEBIT']) {
      expect(applySign(5_000, type, 'fromType'), type).toBe(-5_000)
    }
    for (const type of ['CREDIT', 'DEP', 'DIRECTDEP', 'INT', 'DIV']) {
      expect(applySign(-5_000, type, 'fromType'), type).toBe(5_000)
    }
  })

  it('says when every row goes the same way, so the review can offer the flip', () => {
    const allOut = statement([1, 2, 3, 4, 5].map(n =>
      row(`<TRNTYPE>DEBIT<DTPOSTED>2026100${n}<TRNAMT>-1${n}.00<FITID>A${n}<NAME>Out`)).join(''))
    const warning = parse(allOut).warnings.find(w => w.code === 'signs.uniform')
    expect(warning?.message).toMatch(/takes money out/)
    // And not once the user has already settled it
    expect(parse(allOut, OFX_FORMATS.ofx, 'invert').warnings.some(w => w.code === 'signs.uniform')).toBe(false)
  })

  it('keeps quiet about a file too small to tell anything from', () => {
    expect(parse(statement(basic())).warnings.some(w => w.code === 'signs.uniform')).toBe(false)
  })
})

describe('what the file holds besides a bank statement', () => {
  it('counts investment transactions rather than dropping them', () => {
    const document = parse(sgml(`<OFX>
<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS>
<INVTRANLIST><DTSTART>20261001<DTEND>20261031
<BUYSTOCK><INVBUY><UNITS>10</INVBUY></BUYSTOCK>
<SELLSTOCK><INVSELL><UNITS>5</INVSELL></SELLSTOCK>
</INVTRANLIST>
</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>${basic()}</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`))
    expect(document.statements[0].transactions).toHaveLength(1)
    expect(document.unsupported).toContainEqual(
      { kind: 'investment', count: 2, detail: expect.stringContaining('investment accounts') })
  })

  it('reads a file holding both a bank account and a credit card', () => {
    const document = parse(sgml(`<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>1<ACCTID>111<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST>${basic()}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>CAD
<CCACCTFROM><ACCTID>4510220011889043</CCACCTFROM>
<BANKTRANLIST>${basic()}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`))
    expect(document.statements).toHaveLength(2)
    expect(document.statements[0].account).toMatchObject({ number: '111', type: 'savings' })
    expect(document.statements[1].account).toMatchObject({ number: '4510220011889043', type: 'creditCard' })
  })

  it('maps each account type the specification names', () => {
    const typed = (acctType: string) => parse(sgml(`<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>${acctType}</BANKACCTFROM>
<BANKTRANLIST>${basic()}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`)).statements[0].account

    expect(typed('CHECKING').type).toBe('chequing')
    expect(typed('SAVINGS').type).toBe('savings')
    expect(typed('MONEYMRKT').type).toBe('savings')
    expect(typed('CREDITLINE').type).toBe('lineOfCredit')
    // An unknown word is kept verbatim so the user can see it, and left for them to choose
    expect(typed('SOMETHINGELSE').type).toBeUndefined()
    expect(typed('SOMETHINGELSE').rawType).toBe('SOMETHINGELSE')
  })
})

describe('refusing a file', () => {
  it('says so when there is no OFX section at all', () => {
    expect(() => parse('<html><body>Not a statement</body></html>')).toThrow(/no <OFX> section/)
  })

  it('passes on the bank’s own error rather than calling the file malformed', () => {
    const refused = sgml(`<OFX><SIGNONMSGSRSV1><SONRS>
<STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Your password has expired</STATUS>
</SONRS></SIGNONMSGSRSV1></OFX>`)
    expect(() => parse(refused)).toThrow(/Your password has expired.*15500/)
  })

  it('says a file with a signon but no statement holds none', () => {
    const empty = sgml('<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS></SONRS></SIGNONMSGSRSV1></OFX>')
    expect(() => parse(empty)).toThrow(/holds no statement/)
  })

  it('reads a statement with no transactions in it at all', () => {
    const document = parse(statement(''))
    expect(document.statements[0].transactions).toEqual([])
    expect(document.statements[0].balances?.ledger?.amount).toBe(10_000)
  })
})

describe('sniffing', () => {
  const head = (text: string) => new TextEncoder().encode(text)
  const plain = head('OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><SIGNONMSGSRSV1>')
  const intuit = head('OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><SIGNONMSGSRSV1><SONRS><INTU.BID>3000')
  const xml = head('<?xml version="1.0"?>\n<?OFX OFXHEADER="200" VERSION="211"?>\n<OFX>')

  it('recognises both syntaxes', () => {
    expect(sniffOfx(plain, 'x.ofx', OFX_FORMATS.ofx)).toBe(1)
    expect(sniffOfx(xml, 'x.ofx', OFX_FORMATS.ofx)).toBe(1)
  })

  it('declines anything that is not OFX', () => {
    for (const other of ['Date,Payee,Amount\n', '!Type:Bank\nD11/03/26\n', '{"json": true}', 'SQLite format 3\0']) {
      for (const id of Object.values(OFX_FORMATS)) expect(sniffOfx(head(other), 'x.dat', id), other).toBe(0)
    }
  })

  it('lets the Intuit tag decide between the three when the extension cannot', () => {
    // A file carrying INTU.BID is a QFX or a QBO before it is plain OFX
    expect(sniffOfx(intuit, 'x.dat', OFX_FORMATS.qfx)).toBeGreaterThan(sniffOfx(intuit, 'x.dat', OFX_FORMATS.ofx))
    // And one without it is plain OFX first, though the others do not rule themselves out: plenty of .qfx
    // files carry no Intuit block at all
    expect(sniffOfx(plain, 'x.dat', OFX_FORMATS.ofx)).toBeGreaterThan(sniffOfx(plain, 'x.dat', OFX_FORMATS.qfx))
    expect(sniffOfx(plain, 'x.dat', OFX_FORMATS.qfx)).toBeGreaterThan(0)
  })
})

describe('an empty field with no closing tag (SGML)', () => {
  // `<NAME>` followed straight by the next field used to be taken as an element, adopting every field after it:
  // the transaction lost its amount and reference and was dropped as unreadable.
  it('is an empty leaf, and the fields after it stay the transaction’s own', () => {
    const { root, problems } = tokenize('<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<NAME>\n<TRNAMT>-5.00<FITID>1</STMTTRN>')
    const trn = find(root, 'STMTTRN')!
    // An empty leaf, as `text` reports any empty value: absent. What matters is that it has no children.
    expect(find(trn, 'NAME')?.children).toEqual([])
    expect(text(trn, 'NAME')).toBeUndefined()
    expect(text(trn, 'TRNAMT')).toBe('-5.00')
    expect(text(trn, 'FITID')).toBe('1')
    expect(problems).toEqual([])
  })

  it('is read as a transaction with no payee, rather than dropped', async () => {
    const sgml = [
      'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252',
      'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD',
      '<BANKACCTFROM><BANKID>1<ACCTID>123<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST><DTSTART>20261001<DTEND>20261031',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<NAME>',
      '<TRNAMT>-5.00<FITID>F1<MEMO>Coffee</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'
    ].join('\r\n')
    const read = await readOfx(new TextEncoder().encode(sgml), { formatId: 'exchange-ofx.ofx', signs: 'asGiven' })
    expect(read.statements[0].transactions).toEqual([
      expect.objectContaining({ amount: -500, externalId: 'F1', memo: 'Coffee' })
    ])
    expect(read.warnings.filter(w => w.code === 'amount.unparsable')).toEqual([])
  })

  it('still takes an empty unknown tag as an element, so an aggregate it does not know keeps its children', () => {
    const { root } = tokenize('<OFX><MYSTERY>\n<CODE>0</MYSTERY></OFX>')
    expect(find(root, 'OFX', 'MYSTERY', 'CODE')).toBeDefined()
  })
})

describe('the fromType sign convention', () => {
  it('keeps the file’s own sign for a transfer, which can go either way', () => {
    expect(applySign(50000, 'XFER', 'fromType')).toBe(50000)
    expect(applySign(-50000, 'XFER', 'fromType')).toBe(-50000)
  })

  it('never produces a negative zero', () => {
    expect(Object.is(applySign(0, 'DEBIT', 'fromType'), -0)).toBe(false)
  })

  it('still signs the types that do say which way the money went', () => {
    expect(applySign(500, 'DEBIT', 'fromType')).toBe(-500)
    expect(applySign(-500, 'CREDIT', 'fromType')).toBe(500)
  })
})
