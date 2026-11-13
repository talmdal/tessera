// @vitest-environment node
// The OFX format plugin: the sample statements (samples/statements) and hand-made edge cases, read into the neutral
// statements the import manager imports. OFX 1.x (SGML, unclosed value tags) and 2.x (XML), QFX, QBO, cards and
// banks, and ids a conversion tool made up.
import { describe, expect, it } from 'vitest'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { isCanonicalDecimal, isImportError, IMPORT_FORMATS_POINT, type ParseContext, type ParseResult } from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { OFX_FORMAT, activate, ofxFormat } from '../../../plugins/format-ofx/src/privileged/index'
import { parseOfx, valueOf } from '../../../plugins/format-ofx/src/privileged/sgml'
import { madeUpIds, ofxDate } from '../../../plugins/format-ofx/src/privileged/statements'
import fs from 'node:fs'
import path from 'node:path'
import { importFile, sample, SAMPLES } from '../../helpers/importFile'

const context = {} as ParseContext
const parse = async (file: ReturnType<typeof importFile>) => (await ofxFormat.parse(file, context)) as ParseResult
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, err => err)

/** A minimal OFX 1.x file around a bank statement's body. */
const sgml = (body: string, header = 'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n') =>
  `${header}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>1<ACCTID>99<ACCTTYPE>SAVINGS</BANKACCTFROM>` +
  `<BANKTRANLIST>${body}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

describe('the OFX format plugin', () => {
  it('contributes one format for .ofx, .qfx and .qbo, and provides its service', () => {
    const extensions = new ExtensionRegistryImpl()
    const provided: [string, unknown][] = []
    activate({
      extensions, subscriptions: [],
      services: { provide: (_: string, id: string, impl: unknown) => { provided.push([id, impl]); return { dispose() {} } } }
    } as never)
    expect(extensions.getContributions(IMPORT_FORMATS_POINT).map(c => c.impl)).toEqual([OFX_FORMAT])
    expect(OFX_FORMAT.extensions).toEqual(['ofx', 'qfx', 'qbo'])
    expect(OFX_FORMAT.label).toBe('OFX / QFX / QBO statement (Microsoft Money, Quicken, QuickBooks)')
    // One plugin per file type: it writes OFX, QFX and QBO too, for File › Export… (docs/export-design.md)
    expect(extensions.getContributions(EXPORT_FORMATS_POINT).map(c => [c.id, (c.impl as { extension: string }).extension])).toEqual([
      ['format-ofx.ofx', 'ofx'], ['format-ofx.qfx', 'qfx'], ['format-ofx.qbo', 'qbo']
    ])
    expect(provided.map(([id]) => id)).toEqual(['format-ofx.import', 'format-ofx.export'])
    expect(provided[0][1]).toBe(ofxFormat)
  })

  it('knows an OFX file by its header, in either version, and nothing else', () => {
    const sniff = (text: string) => ofxFormat.sniff!({ name: 'x', extension: 'txt', head: new TextEncoder().encode(text) })
    expect(sniff('OFXHEADER:100\nDATA:OFXSGML')).toBe(true)
    expect(sniff('<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX>')).toBe(true)
    expect(sniff('Date,Description,Amount\n2026-10-01,Coffee,-4.75')).toBe(false)
  })
})

describe('the sample statements', () => {
  it('reads an OFX 1.x chequing statement: account, period, balance, and every line with its kind', async () => {
    const { statements, warnings } = await parse(sample('maple-trust-chequing-2026-10.ofx'))
    expect(warnings).toEqual([])
    expect(statements).toHaveLength(1)
    const [s] = statements
    expect(s.account).toEqual({
      key: 'ofx:bank:012345:8812345678', keyStrength: 'strong', accountNumber: '8812345678',
      label: 'Maple Trust Bank •••• 5678', institution: 'Maple Trust Bank', type: 'chequing', bankId: '012345'
    })
    expect(s.currency).toBe('CAD')
    expect(s.period).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(s.balance).toEqual({ amount: '4677.80', asOf: '2026-10-31' })
    expect(s.lines).toHaveLength(17)
    expect(s.lines[0]).toEqual({ date: '2026-10-02', amount: '-1200.00', payee: 'CHEQUE 101', memo: 'Cheque cleared', number: '101', externalId: 'MT2026100201', kind: 'cheque' })
    // The date the user paid (DTUSER) is kept when it differs from the posting date, for matching
    expect(s.lines.find(l => l.externalId === 'MT2026100601')).toMatchObject({ date: '2026-10-06', userDate: '2026-10-05', amount: '-84.12', payee: 'POS PURCHASE COSTCO WHSE #0123', kind: 'pos' })
    expect(s.lines.map(l => l.kind)).toEqual(expect.arrayContaining(['serviceCharge', 'interest', 'directDebit', 'atm', 'transfer']))
    for (const line of s.lines) expect(isCanonicalDecimal(line.amount), line.amount).toBe(true)
  })

  it('keeps every sample statement plain ASCII, so copying it between machines can’t change it', () => {
    const statements = fs.readdirSync(SAMPLES).filter(name => /\.(ofx|qfx|qbo|csv|qif)$/i.test(name))
    expect(statements.length).toBeGreaterThanOrEqual(22)
    for (const name of statements) {
      const bytes = fs.readFileSync(path.join(SAMPLES, name))
      expect(bytes.findIndex(b => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)), name).toBe(-1)
    }
  })

  it('reads character references, as the sample spells its accented payee', async () => {
    const { statements: [s] } = await parse(sample('maple-trust-chequing-2026-10.ofx'))
    expect(s.lines.find(l => l.externalId === 'MT2026101201')?.payee).toBe('CAFÉ DÉPÔT #204')
  })

  it('decodes the windows-1252 bytes a file declares, so accented payees survive', async () => {
    // Built here, byte by byte: a file holding these bytes can be mangled on its way to another machine.
    const text = sgml('<STMTTRN><TRNTYPE>POS<DTPOSTED>20261012<TRNAMT>-6.45<FITID>A<NAME>CAF{E} D{E}P{O}T #204 {euro}</STMTTRN>')
    const cp1252: Record<string, number[]> = { E: [0xc9], O: [0xd4], euro: [0x80] }
    const bytes = new Uint8Array(text.split(/\{(\w+)\}/).flatMap((part, i) =>
      i % 2 ? cp1252[part] : [...part].map(c => c.charCodeAt(0))))
    expect(bytes.every(b => b < 0x80 || [0xc9, 0xd4, 0x80].includes(b))).toBe(true)
    expect((await parse(importFile('x.ofx', bytes))).statements[0].lines[0].payee).toBe('CAFÉ DÉPÔT #204 €')
  })

  it('reads a QFX credit card statement like any OFX one: a masked card number, charges negative, payments positive', async () => {
    const { statements: [s] } = await parse(sample('northwind-visa-2026-10.qfx'))
    expect(s.account).toEqual({
      key: 'ofx:card:XXXXXXXXXXXX3456', keyStrength: 'strong', accountNumber: 'XXXXXXXXXXXX3456', numberIsPartial: true,
      label: 'Northwind Card Services •••• 3456', institution: 'Northwind Card Services', type: 'creditCard', intuitBankId: '55501'
    })
    expect(s.balance).toEqual({ amount: '-464.77', asOf: '2026-10-31' })
    expect(s.lines.find(l => l.payee === 'NETFLIX.COM')?.amount).toBe('-36.80')
    expect(s.lines.find(l => l.payee === 'PAYMENT - THANK YOU')).toMatchObject({ amount: '540.00', kind: 'credit' })
    expect(s.lines.find(l => l.payee === 'FOREIGN TRANSACTION FEE')?.kind).toBe('fee')
  })

  it('reads an OFX 2.x (XML) file with two accounts as two statements, with entities decoded', async () => {
    const { statements } = await parse(sample('harbour-bank-2026-10.ofx'))
    expect(statements.map(s => [s.account.key, s.account.type, s.lines.length, s.balance?.amount])).toEqual([
      ['ofx:bank:000987:223301-4410', 'chequing', 5, '2148.74'],
      ['ofx:bank:000987:223301-4411', 'savings', 2, '5306.12']
    ])
    expect(statements[0].lines.find(l => l.externalId === 'HB-C-1024')?.payee).toBe('JOHNNY & CO BISTRO')
    expect(statements[0].lines[0].date).toBe('2026-10-01')        // 20261001000000.000[-4:EDT]: the date as written
  })

  it("reads next month's file, which starts before this month's ended: the overlap has the same bank ids", async () => {
    const october = (await parse(sample('maple-trust-chequing-2026-10.ofx'))).statements[0].lines.map(l => l.externalId)
    const november = (await parse(sample('maple-trust-chequing-2026-11.ofx'))).statements[0].lines.map(l => l.externalId)
    const overlap = november.filter(id => october.includes(id))
    expect(overlap).toEqual(['MT2026102701', 'MT2026102901', 'MT2026102902', 'MT2026103101', 'MT2026103102'])
    expect(november).toHaveLength(overlap.length + 5)
  })
})

describe('OFX edge cases', () => {
  it('reads dates as the calendar date the bank wrote, whatever the time and zone', () => {
    expect(ofxDate('20261005120000[-5:EST]')).toBe('2026-10-05')
    expect(ofxDate('20261005235959.999[+9:JST]')).toBe('2026-10-05')
    expect(ofxDate('20261005')).toBe('2026-10-05')
    expect(ofxDate('20261305')).toBeUndefined()
    expect(ofxDate('yesterday')).toBeUndefined()
  })

  it('leaves out a transaction it cannot read, with a warning, and keeps the rest', async () => {
    const { statements: [s], warnings } = await parse(importFile('x.ofx', sgml(
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-1.00<FITID>A<NAME>GOOD</STMTTRN>' +
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261399<TRNAMT>-2.00<FITID>B<NAME>BAD DATE</STMTTRN>' +
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>lots<FITID>C<NAME>BAD AMOUNT</STMTTRN>')))
    expect(s.lines.map(l => l.externalId)).toEqual(['A'])
    expect(warnings?.map(w => w.message)).toEqual([
      'Bank 1 •••• 99: a transaction (B) was left out: the date “20261399” can\'t be read.',
      'Bank 1 •••• 99: a transaction (C) was left out: the amount “lots” can\'t be read.'
    ])
  })

  it('copes with lines without bank ids, empty values, PAYEE aggregates, decimal commas and entities', async () => {
    const { statements: [s] } = await parse(importFile('x.ofx', sgml(
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-1,50<MEMO><NAME>NO ID &amp; EMPTY MEMO</STMTTRN>' +
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261006<TRNAMT>+2.00<FITID>P<PAYEE><NAME>PAYEE AGGREGATE<CITY>OTTAWA</PAYEE></STMTTRN>')))
    expect(s.lines).toEqual([
      { date: '2026-10-05', amount: '-1.50', payee: 'NO ID & EMPTY MEMO', kind: 'debit' },
      { date: '2026-10-06', amount: '2.00', payee: 'PAYEE AGGREGATE', externalId: 'P', kind: 'credit' }
    ])
  })

  it('reads SGML value tags that are never closed, and ignores closing tags that match nothing', () => {
    const doc = parseOfx('<OFX><A><B>one<C>two</C></D></A><E>three</OFX>')!
    expect(valueOf(doc.root, 'B')).toBe('one')
    expect(valueOf(doc.root, 'C')).toBe('two')
    expect(valueOf(doc.root, 'E')).toBe('three')
    expect(doc.root.children.map(n => n.name)).toEqual(['A', 'E'])
  })

  it('refuses what is not an OFX statement, saying why', async () => {
    expect(await failure(parse(importFile('x.ofx', 'Date,Amount\n2026-10-01,-4.75')))).toMatchObject({ code: 'UNREADABLE', message: "x.ofx isn't an OFX statement: it has no <OFX> section." })
    const refused = '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Signon invalid</STATUS></SONRS></SIGNONMSGSRSV1></OFX>'
    const err = await failure(parse(importFile('x.ofx', refused)))
    expect(isImportError(err)).toBe(true)
    expect(err.message).toBe('x.ofx holds no statement. The bank said: Signon invalid')
  })

  it('decodes a UTF-8 OFX 1.x file, and one with a byte-order mark', async () => {
    const utf8 = sgml('<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-1.00<FITID>A<NAME>CRÈME BRÛLÉE</STMTTRN>', 'OFXHEADER:100\nCHARSET:UTF-8\n\n')
    expect((await parse(importFile('x.ofx', utf8))).statements[0].lines[0].payee).toBe('CRÈME BRÛLÉE')
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(utf8)])
    expect((await parse(importFile('x.ofx', bom))).statements[0].lines[0].payee).toBe('CRÈME BRÛLÉE')
  })
})

describe('QBO (QuickBooks Web Connect)', () => {
  it('reads a QBO file as the OFX it is, naming the bank from its FI, never from INTU.BID', async () => {
    const { statements, warnings } = await parse(sample('lakeside-business-2026-10.qbo'))
    expect(warnings).toEqual([])
    const [s] = statements
    expect(s.account).toEqual({
      key: 'ofx:bank:229000:4002290117', keyStrength: 'strong', accountNumber: '4002290117',
      label: 'Lakeside Credit Union •••• 0117', institution: 'Lakeside Credit Union', type: 'chequing',
      // Kept for exports, never to name or find the account
      bankId: '229000', intuitBankId: '2290'
    })
    expect(s.balance).toEqual({ amount: '11038.25', asOf: '2026-10-31' })
    expect(s.lines).toHaveLength(10)
    expect(s.lines.find(l => l.number === '2041')).toMatchObject({ amount: '-725.00', kind: 'cheque', externalId: 'LCU202610200001' })
    expect(s).not.toHaveProperty('stableIds')
    // INTU.BID names a bank in QuickBooks' list, which a file made by a converter may borrow: it is never used
    const converted = (await parse(sample('maple-trust-chequing-2026-10-converted.qbo'))).statements[0]
    expect(converted.account).toMatchObject({ institution: 'Maple Trust Bank', label: 'Maple Trust Bank •••• 5678', key: 'ofx:bank:012345:8812345678' })
    // Not even kept for exports: its ids are made up, so its Intuit id may well be another bank's
    expect(converted.stableIds).toBe(false)
    expect(converted.account).not.toHaveProperty('intuitBankId')
    expect(JSON.stringify(converted.account)).not.toContain('3000')
  })

  it("gives a QBO file and an OFX file for the same account the same key, so they share a saved match and bank ids", async () => {
    const ofx = (await parse(sample('maple-trust-chequing-2026-10.ofx'))).statements[0]
    const qbo = (await parse(sample('maple-trust-chequing-2026-10-converted.qbo'))).statements[0]
    expect(qbo.account.key).toBe(ofx.account.key)
  })
})

describe('made-up bank ids', () => {
  const line = (externalId: string | undefined, over: object = {}) =>
    ({ date: '2026-10-05', amount: '-1.00', payee: `SHOP ${externalId}`, ...(externalId !== undefined && { externalId }), ...over })

  it('are a counter: at least 3 lines, every id a short plain number, one after another', () => {
    expect(madeUpIds(['1', '2', '3'].map(id => line(id)))).toEqual({ why: 'counter', example: '1, 2, 3' })
    expect(madeUpIds(['1003', '1001', '1002', '1004'].map(id => line(id)))).toEqual({ why: 'counter', example: '1001, 1002, 1003' })
    expect(madeUpIds(['001', '002', '003'].map(id => line(id)))).toMatchObject({ why: 'counter' })
  })

  it('are the same id on two different lines, but not one line sent twice', () => {
    expect(madeUpIds([line('A7'), line('B9'), line('A7', { amount: '-2.00' })])).toEqual({ why: 'reused', example: 'A7' })
    expect(madeUpIds([line('A7'), line('A7')])).toBeUndefined()
  })

  it("aren't a bank's own: long, dated, sparse, mixed, missing, or too few to tell", () => {
    expect(madeUpIds(['MT2026100201', 'MT2026100301', 'MT2026100401'].map(id => line(id)))).toBeUndefined()
    expect(madeUpIds(['1', '2', '5'].map(id => line(id)))).toBeUndefined()
    expect(madeUpIds(['1', '2', '3', '1234567'].map(id => line(id)))).toBeUndefined()
    expect(madeUpIds(['1', '2', 'X3'].map(id => line(id)))).toBeUndefined()
    expect(madeUpIds([line('1'), line('2'), line(undefined)])).toBeUndefined()
    expect(madeUpIds(['1', '2'].map(id => line(id)))).toBeUndefined()
    expect(madeUpIds([])).toBeUndefined()
  })

  it('make the statement say its ids can’t be trusted, with one warning, in any OFX file', async () => {
    const { statements: [s], warnings } = await parse(sample('maple-trust-chequing-2026-10-converted.qbo'))
    expect(s.stableIds).toBe(false)
    expect(s.lines.map(l => l.externalId)).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)))
    expect(warnings).toEqual([{ message: 'Maple Trust Bank •••• 5678: the transaction ids look made up (1, 2, 3…), so its lines are recognised by their content instead.' }])
    const reused = await parse(importFile('x.ofx', sgml(
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-1.00<FITID>T1<NAME>ONE</STMTTRN>' +
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-2.00<FITID>T1<NAME>TWO</STMTTRN>')))
    expect(reused.statements[0].stableIds).toBe(false)
    expect(reused.warnings).toEqual([{ message: 'Bank 1 •••• 99: the same transaction id (“T1”) is given to different transactions, so its lines are recognised by their content instead.' }])
  })
})

describe('where values are written', () => {
  it('records each value’s place in the text, entities and all, for tools that rewrite them in place', () => {
    const text = 'OFXHEADER:100\n\n<OFX><A><NAME>  CAF&#201; D&#201;P&#212;T #204 \n<MEMO>x</A><B><C>two</C></B></OFX>'
    const doc = parseOfx(text)!
    const values: [string, string | undefined, string][] = []
    const walk = (n: typeof doc.root) => { for (const c of n.children) { if (c.span) values.push([c.name, c.text, text.slice(c.span.start, c.span.end)]); walk(c) } }
    walk(doc.root)
    expect(values).toEqual([['NAME', 'CAFÉ DÉPÔT #204', 'CAF&#201; D&#201;P&#212;T #204'], ['MEMO', 'x', 'x'], ['C', 'two', 'two']])
  })
})
