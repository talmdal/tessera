// @vitest-environment node
// The anonymiser (scripts/anonymise/): real statement files with their personal data replaced and their dialect kept,
// checked by a scan that refuses a file in which anything still looks personal. OFX, QFX and QBO here; CSV in
// anonymiseCsv.test.ts, QIF in anonymiseQif.test.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { IMPORT_DIALOGS } from '@tessera/import-api'
import { anonymise, check, describeCounts, emptyMapping, encodeAs, likeRule, outputName, shapeOf, type InputFile, type Mapping } from '../../scripts/anonymise/index'
import { Amounts, readAmount, rewrite, writeSigned } from '../../scripts/anonymise/amounts'
import { decodeFile, lineEndOf, sidecarFor } from '../../scripts/anonymise/encoding'
import { seeded } from '../../scripts/anonymise/random'
import { mask, plain, scan, type Scannable } from '../../scripts/anonymise/scan'
import { Pseudonyms } from '../../scripts/anonymise/words'
import { ofxFormat } from '../../plugins/import-ofx/src/privileged/index'
import { findAll, parseOfx, valueOf, type OfxNode } from '../../plugins/import-ofx/src/privileged/sgml'
import { fixtureBytes, fixtureFile, importFile, SAMPLES } from '../helpers/importFile'
import { setupImport } from '../plugins/import/harness'
import type { ParseContext, ParseResult } from '@tessera/import-api'

const input = (name: string): InputFile => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(SAMPLES, name))) })
const text = (name: string) => fs.readFileSync(path.join(SAMPLES, name), 'latin1')
const OCTOBER = 'maple-trust-chequing-2026-10.ofx'
const NOVEMBER = 'maple-trust-chequing-2026-11.ofx'
/** How this checkout writes the samples' line ends: '\n' as committed, or '\r\n' where git converts them (Windows). */
const SAMPLE_LINE_END = lineEndOf(fs.readFileSync(path.join(SAMPLES, OCTOBER), 'latin1'))
const parse = async (name: string, body: string) => (await ofxFormat.parse(importFile(name, body), {} as ParseContext)) as ParseResult

/** Every value of a kind, in file order. */
const valuesOf = (body: string, tag: string) => findAll(parseOfx(body)!.root, tag).map((n: OfxNode) => n.text)
/** The file with every value taken out: its tags, header and spacing. */
const skeleton = (body: string) => body.replace(/>[^<]*/g, '>')

/** Writes outputs to a temporary folder, for importing them. */
function written(outputs: { outputName: string, text: string }[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-'))
  return outputs.map(o => { const file = path.join(dir, o.outputName); fs.writeFileSync(file, o.text); return file })
}

describe('anonymising OFX files', () => {
  const { outputs: [october, november] } = anonymise([input(OCTOBER), input(NOVEMBER)], { seed: 7 })

  it('leaves nothing personal: account numbers, payees, memos and ids are all replaced, and the scan finds nothing', () => {
    expect(october.findings).toEqual([])
    expect(november.findings).toEqual([])
    for (const gone of ['8812345678', '012345', '00211', 'COSTCO', 'LOBLAWS', 'NORTHERN', 'HYDRO', 'GATINEAU', 'OTTAWA', 'MT2026100201', 'Cheque cleared']) {
      expect(october.text, gone).not.toContain(gone)
    }
    expect(describeCounts(october.counts)).toBe('1 account number, 18 ids, 17 payees, 15 memos, 17 amounts replaced; 2 balances worked out again from the changed lines')
  })

  it('keeps the dialect: every tag, the header, the spacing, dates, types, cheque numbers and the bank, byte for byte', () => {
    const original = text(OCTOBER)
    expect(skeleton(october.text)).toBe(skeleton(original))
    expect(october.text.slice(0, october.text.indexOf('<OFX>'))).toBe(original.slice(0, original.indexOf('<OFX>')))
    for (const tag of ['DTPOSTED', 'DTUSER', 'DTSERVER', 'DTSTART', 'DTASOF', 'TRNTYPE', 'CHECKNUM', 'CURDEF', 'ACCTTYPE', 'ORG', 'FID']) {
      expect(valuesOf(october.text, tag), tag).toEqual(valuesOf(original, tag))
    }
    // Still plain ASCII, its accents written as character references, as the original did. It needs a sidecar only
    // for its line ends, when git checked the sample out with CRLF (Windows, with core.autocrlf)
    expect(october.sidecar).toEqual(SAMPLE_LINE_END === '\n' ? undefined : { encoding: 'windows-1252', bom: false, lineEnd: SAMPLE_LINE_END })
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(october.text)).toBe(true)
    expect(october.text).toMatch(/<NAME>[A-Z]+ D&#201;P&#212;T #\d{3}</)                 // 'DÉPÔT' is a bank's word
    expect(outputName(OCTOBER)).toBe('maple-trust-chequing-2026-10.anon.ofx')
  })

  it("keeps a payee's shape: the bank's words, store numbers as other digits, the province at the end", async () => {
    const { statements: [s] } = await parse('x.ofx', october.text)
    const costco = s.lines.find(l => l.date === '2026-10-06')!
    expect(costco.payee).toMatch(/^POS PURCHASE [A-Z]+ [A-Z]+ #\d{4}$/)
    expect(costco.memo).toMatch(/^[A-Z]+ ON$/)
    expect(s.lines.find(l => l.kind === 'serviceCharge')!.payee).toBe('MONTHLY ACCOUNT FEE')
  })

  it('changes amounts, keeping equal amounts equal, and still reads as the same kinds of lines', async () => {
    const before = (await parse('a.ofx', text(OCTOBER))).statements[0].lines
    const after = (await parse('b.ofx', october.text)).statements[0].lines
    expect(after.map(l => [l.date, l.kind, Math.sign(Number(l.amount))])).toEqual(before.map(l => [l.date, l.kind, Math.sign(Number(l.amount))]))
    expect(after.filter((l, i) => l.amount !== before[i].amount).length).toBeGreaterThan(12)
    const coffees = after.filter(l => l.date === '2026-10-29')
    expect(coffees[0].amount).toBe(coffees[1].amount)                                   // two identical coffees
    const pay = after.filter(l => l.kind === 'deposit')
    expect(pay[0].amount).toBe(pay[1].amount)                                           // two equal paycheques
  })

  it('anonymises overlapping files the same way: the shared week has the same ids, payees and amounts', async () => {
    const oct = (await parse('a.ofx', october.text)).statements[0]
    const nov = (await parse('b.ofx', november.text)).statements[0]
    expect(nov.account.key).toBe(oct.account.key)
    const shared = nov.lines.slice(0, 5)
    expect(shared).toEqual(oct.lines.slice(-5))
  })

  it('keeps the balances adding up, across the files: imported, they end at the bank’s balance, with the overlap not doubled', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const [octFile, novFile] = written([october, november])
    await env.manager.importFiles([octFile])
    const report = await env.manager.importFiles([novFile])
    expect(report!.results[0]).toMatchObject({ counts: { added: 5, duplicates: 5 } })
    const [account] = await env.accounts.list()
    const [{ balances }] = (await env.accounts.chart()).accounts.filter(s => s.account.id === account.id)
    const { statements: [nov] } = await parse('b.ofx', november.text)
    expect(balances.current / 100).toBeCloseTo(Number(nov.balance!.amount), 2)
    expect(nov.balance!.amount).not.toBe('6241.74')
  })

  it('gives the same file for the same seed, and another for another seed', () => {
    expect(anonymise([input(OCTOBER)], { seed: 7 }).outputs[0].text).toBe(anonymise([input(OCTOBER)], { seed: 7 }).outputs[0].text)
    expect(anonymise([input(OCTOBER)], { seed: 8 }).outputs[0].text).not.toBe(october.text)
  })

  it('anonymises a later file the same way with the mapping kept from an earlier run (--map)', async () => {
    const first = anonymise([input(OCTOBER)], { seed: 1 })
    const kept: Mapping = JSON.parse(JSON.stringify(first.mapping))
    const later = anonymise([input(NOVEMBER)], { seed: 99, mapping: kept })
    const oct = (await parse('a.ofx', first.outputs[0].text)).statements[0]
    const nov = (await parse('b.ofx', later.outputs[0].text)).statements[0]
    expect(nov.lines.slice(0, 5)).toEqual(oct.lines.slice(-5))
    // The balances of the two runs agree: October's closing, plus November's new lines, is November's closing
    const newLines = nov.lines.slice(5).reduce((sum, l) => sum + Math.round(Number(l.amount) * 100), 0)
    expect(Math.round(Number(oct.balance!.amount) * 100) + newLines).toBe(Math.round(Number(nov.balance!.amount) * 100))
  })
})

describe('anonymising other files', () => {
  it('keeps a card number’s mask, and the card’s shape', async () => {
    const [visa] = anonymise([input('northwind-visa-2026-10.qfx')], { seed: 3 }).outputs
    expect(visa.findings).toEqual([])
    expect(valuesOf(visa.text, 'ACCTID')[0]).toMatch(/^XXXXXXXXXXXX\d{4}$/)
    expect(valuesOf(visa.text, 'ACCTID')[0]).not.toBe('XXXXXXXXXXXX3456')
    expect(visa.text).not.toContain('866-579-7172')                                     // a phone number in a memo
    const { statements: [s] } = await parse('v.qfx', visa.text)
    expect(s.account).toMatchObject({ type: 'creditCard', numberIsPartial: true })
  })

  it('keeps a converter’s counters (1, 2, 3…), which are not personal, so its ids still look made up', async () => {
    const [qbo] = anonymise([input('maple-trust-chequing-2026-10-converted.qbo')], { seed: 3 }).outputs
    expect(valuesOf(qbo.text, 'FITID')).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)))
    expect(valuesOf(qbo.text, 'INTU.BID')).toEqual(['3000'])                              // the bank is kept by default
    expect(valuesOf(qbo.text, 'INTU.USERID')).not.toEqual(['converted'])
    const { statements: [s] } = await parse('c.qbo', qbo.text)
    expect(s.stableIds).toBe(false)
  })

  it('replaces the bank too when asked, keeps amounts when asked, and moves dates by whole weeks when asked', async () => {
    const [hidden] = anonymise([input('lakeside-business-2026-10.qbo')], { seed: 3, hideInstitution: true }).outputs
    expect(hidden.text).not.toContain('Lakeside')
    expect(valuesOf(hidden.text, 'FID')).not.toEqual(['2290'])
    const [kept] = anonymise([input('lakeside-business-2026-10.qbo')], { seed: 3, keepAmounts: true }).outputs
    for (const tag of ['TRNAMT', 'BALAMT']) expect(valuesOf(kept.text, tag)).toEqual(valuesOf(text('lakeside-business-2026-10.qbo'), tag))
    const [moved] = anonymise([input('lakeside-business-2026-10.qbo')], { seed: 3, shiftWeeks: 2 }).outputs
    expect(valuesOf(moved.text, 'DTPOSTED')[0]).toBe('20261015120000[-5:EST]')
    expect(valuesOf(moved.text, 'DTEND')).toEqual(['20261114'])
    expect((await parse('m.qbo', moved.text)).statements[0].balance!.asOf).toBe('2026-11-14')
  })

  it('keeps a cheque number, and gives a longer CHECKNUM (a reference) another of its shape', () => {
    const body = text(OCTOBER).replace('<CHECKNUM>101', '<CHECKNUM>88123456')
    const [output] = anonymise([{ name: 'x.ofx', bytes: new TextEncoder().encode(body) }], { seed: 3 }).outputs
    expect(output.findings).toEqual([])
    expect(valuesOf(output.text, 'CHECKNUM')[0]).toMatch(/^\d{8}$/)
    expect(valuesOf(output.text, 'CHECKNUM')[0]).not.toBe('88123456')
    const [plainFile] = anonymise([input(OCTOBER)], { seed: 3 }).outputs
    expect(valuesOf(plainFile.text, 'CHECKNUM')).toEqual(valuesOf(text(OCTOBER), 'CHECKNUM'))
  })

  it('keeps the words it is told to keep', () => {
    const [kept] = anonymise([input(OCTOBER)], { seed: 3, keepWords: ['costco', 'Loblaws'] }).outputs
    expect(kept.text).toContain('COSTCO')
    expect(kept.text).toContain('LOBLAWS')
    expect(kept.text).not.toContain('HYDRO')
  })

  it('writes an original that wasn’t plain UTF-8 as UTF-8, with a sidecar to rebuild its bytes: windows-1252, CRLF, a BOM', async () => {
    // A windows-1252 file with accented bytes and CRLF line ends, as many banks write them
    const body = 'OFXHEADER:100\r\nCHARSET:1252\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>1<ACCTID>44556677<ACCTTYPE>CHECKING</BANKACCTFROM>\r\n' +
      '<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-12.00<FITID>A1<NAME>CAF\u00c9 D\u00c9P\u00d4T</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\r\n'
    const bytes = Uint8Array.from(body, ch => ch.charCodeAt(0))
    const [output] = anonymise([{ name: 'bank.ofx', bytes }], { seed: 5 }).outputs
    expect(output.findings).toEqual([])
    expect(output.sidecar).toEqual({ encoding: 'windows-1252', bom: false, lineEnd: '\r\n' })
    expect(output.text).toContain('D\u00c9P\u00d4T')                                      // a bank's word, kept
    const rebuilt = encodeAs(output.text, output.sidecar!)
    expect(rebuilt.includes(0xc9)).toBe(true)                                               // É as windows-1252 writes it
    const again = decodeFile(rebuilt, 'windows-1252')
    expect(again.text).toBe(output.text)
    expect(again.lineEnd).toBe('\r\n')
    // Kept as a fixture, the test helpers rebuild the bytes from the sidecar, and the file reads as the bank's did
    const [file] = written([output])
    fs.writeFileSync(`${file}.meta.json`, JSON.stringify(output.sidecar))
    expect(fixtureBytes(file)).toEqual(rebuilt)
    const { statements: [s] } = (await ofxFormat.parse(fixtureFile(file), {} as ParseContext)) as ParseResult
    expect(s.lines[0].payee).toMatch(/^[A-Z]+ DÉPÔT$/)
    // With a byte-order mark, and '\n' line ends
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body.replace(/\r\n/g, '\n').replace('CHARSET:1252', 'CHARSET:UTF-8'))])
    expect(anonymise([{ name: 'bom.ofx', bytes: bom }], { seed: 5 }).outputs[0].sidecar).toEqual({ encoding: 'utf-8', bom: true, lineEnd: '\n' })
  })

  it('refuses a file it can’t read, saying why', () => {
    const [pdf] = anonymise([{ name: 'statement.pdf', bytes: new TextEncoder().encode('%PDF-1.7') }]).outputs
    expect(pdf.error).toBe('statement.pdf can\'t be anonymised: only OFX, QFX, QBO, CSV and QIF files can.')
    expect(anonymise([{ name: 'x.ofx', bytes: new TextEncoder().encode('not a statement') }]).outputs[0].error).toBe('x.ofx can\'t be anonymised: it has no <OFX> section, so it is not an OFX file.')
  })
})

describe('the scan', () => {
  it('refuses an output in which something personal was left where the reader couldn’t see it', () => {
    // Text outside any value (after </OFX>), and a comment: the anonymiser doesn't touch them, and the scan catches them
    const body = `${text(OCTOBER)}\nQuestions? Call 613-555-0199 or write to jane.doe@example.com\n<!-- 4111 1111 1111 1111 -->\n`
    const [output] = anonymise([{ name: 'x.ofx', bytes: new TextEncoder().encode(body) }], { seed: 2 }).outputs
    expect(output.findings.map(f => [f.kind, f.masked])).toEqual([
      ['phone number', '•••-•••-••99'], ['email address', '••••.•••@•••••••.•om'], ['card number', '•••• •••• •••• ••11']
    ])
    // An original value the anonymiser replaced in one place, left in another
    const leaked = `${text(OCTOBER)}\nLOBLAWS\n`
    expect(anonymise([{ name: 'y.ofx', bytes: new TextEncoder().encode(leaked) }], { seed: 2 }).outputs[0].findings)
      .toEqual([{
        kind: 'replaced value', line: leaked.split('\n').indexOf('LOBLAWS') + 1, masked: '•••••WS', text: 'LOBLAWS', token: 'LOBLAWS', shape: 'AAAAAAA',
        at: expect.any(Number)
      }])
  })

  const scannable = (text: string, original = 1): Scannable => ({ text, original: new Uint8Array(text.length).fill(original), hidden: new Uint8Array(text.length) })

  it('knows the usual shapes of personal numbers and addresses', () => {
    const kinds = (text: string) => scan(scannable(text)).map(f => f.kind)
    expect(kinds('card 4111 1111 1111 1111')).toEqual(['card number'])
    expect(kinds('card 4111 1111 1111 1112')).toEqual([])                                  // fails the Luhn check
    expect(kinds('ref 88123456')).toEqual(['long number'])
    expect(kinds('ref 123456')).toEqual([])
    expect(kinds('mail jane@example.ca')).toEqual(['email address'])
    expect(kinds('call (613) 555-0199')).toEqual(['phone number'])
    expect(kinds('call +44 20 7946 0958')).toEqual(['phone number'])
    expect(kinds('OTTAWA ON K1A 0B1')).toEqual(['postal code'])
    expect(kinds('BUFFALO NY 14201-1234')).toEqual(['postal code'])
    expect(kinds('LONDON SW1A 1AA')).toEqual(['postal code'])
    expect(kinds('SIN 046-454-286')).toEqual(['social insurance or security number'])
    expect(kinds('SSN 078-05-1120')).toEqual(['social insurance or security number'])
    expect(kinds('IBAN GB82WEST12345698765432')).toEqual(['IBAN'])
    expect(kinds('POS PURCHASE COSTCO WHSE #0123 OTTAWA ON')).toEqual([])
  })

  it('reports a shape only where it came from the original, and never looks at what is hidden', () => {
    expect(scan(scannable('ACCT 8812345678', 0))).toEqual([])                              // made up by the anonymiser
    const hidden = scannable('<DTPOSTED>20261005120000')
    hidden.hidden.fill(1)
    expect(scan(hidden)).toEqual([])
  })

  it('finds the originals it replaced, as whole words, ignoring case and accents', () => {
    expect(scan(scannable('x Loblaws y'), ['loblaws']).map(f => f.kind)).toEqual(['replaced value'])
    expect(scan(scannable('LOBLAWSON'), ['loblaws'])).toEqual([])
    expect(scan(scannable('Café Dépôt'), ['depot']).map(f => f.text)).toEqual(['Dépôt'])
    expect(scan(scannable('abc'), ['abc'])).toEqual([])                                     // too short to look for
  })

  it('drops findings the user allows, and masks all but the last two characters of what it shows', () => {
    expect(scan(scannable('call 1-800-555-0199'), [], [/1-800-555/])).toEqual([])
    expect(mask('613-555-0199')).toBe('•••-•••-••99')
    expect(plain('x').original[0]).toBe(1)
  })

  it('tests what is allowed against the whole value around a finding, which it describes by its shape', () => {
    // '12345678' is what looks personal; 'CA12345678' is the value, as the user sees it
    const [finding] = scan(scannable('ref CA12345678 paid'))
    expect(finding).toMatchObject({ kind: 'long number', text: '12345678', token: 'CA12345678', shape: 'AA99999999', masked: '••••••78' })
    expect(scan(scannable('ref CA12345678 paid'), [], [/^[A-Z]{2}\d{8}$/])).toEqual([])
    expect(scan(scannable('ref CA12345678 paid'), [], [likeRule('AB00000000')])).toEqual([])
    expect(scan(scannable('ref CA12345678 paid'), [], [likeRule('AA99999999')])).toEqual([])            // the shape it printed
    expect(scan(scannable('ref CA123456789 paid'), [], [likeRule('AA99999999')])).toHaveLength(1)      // another shape
    expect(likeRule('1-800-555-0199').test('1-888-555-0100')).toBe(true)
    expect(likeRule('(613) 555.0199').test('(416) 555.0100')).toBe(true)
    expect(shapeOf('Ré-12 x')).toBe('AA-99 A')
  })

  it('says where a finding is without showing it: a QIF field, a CSV column, an OFX tag', () => {
    const at = (name: string, body: string) => anonymise([{ name, bytes: new TextEncoder().encode(body) }], { seed: 1 }).outputs[0].findings.map(f => f.where)
    expect(at('x.qif', '!Type:Bank\nD1/5/26\nT-1.00\nC613-555-0199\n^\n')).toEqual(['the C field (cleared)'])
    expect(at('x.csv', 'Date,Description,Amount,Status\n2026-10-05,COFFEE,-1.00,613-555-0199\n2026-10-06,TEA,-2.00,Posted\n')).toEqual(['column 4'])
    // An OFX file checked as it is: the sample's account number, in its tag
    expect(check([input(OCTOBER)])[0].findings.map(f => f.where)).toEqual(['<ACCTID>'])
  })

  it('lists what it was allowed to leave, so the report can say what was written as it was', () => {
    const body = '!Type:Bank\nD1/5/26\nT-1.00\nC613-555-0199\n^\n'
    const [output] = anonymise([{ name: 'x.qif', bytes: new TextEncoder().encode(body) }], { seed: 1, allow: [likeRule('999-999-9999')] }).outputs
    expect(output.findings).toEqual([])
    expect(output.allowed?.map(f => [f.kind, f.where, f.shape])).toEqual([['phone number', 'the C field (cleared)', '999-999-9999']])
  })

  it('checks its own output (named *.anon.*) only where it keeps the original: codes, the bank, stray text', () => {
    const [output] = anonymise([input('lakeside-business-2026-10.qbo')], { seed: 3 }).outputs
    const bytes = new TextEncoder().encode(output.text)
    expect(check([{ name: output.outputName, bytes }])[0].findings).toEqual([])                 // its made-up numbers pass
    expect(check([{ name: 'lakeside.qbo', bytes }])[0].findings.map(f => f.kind)).toContain('long number')   // not named as its output
    // Something personal where the anonymiser keeps the original is still found
    const planted = output.text.replace('<ORG>Lakeside Credit Union', '<ORG>Lakeside Credit Union 613-555-0199') + '\nCall jane@example.com\n'
    expect(check([{ name: output.outputName, bytes: new TextEncoder().encode(planted) }])[0].findings.map(f => f.kind)).toEqual(['phone number', 'email address'])
  })

  it('checks files without changing them (--check): account numbers are flagged, dates and ids are not', () => {
    const [maple] = check([input(OCTOBER)])
    expect(maple.findings.map(f => [f.kind, f.masked])).toEqual([['long number', '••••••••78']])
    expect(check([{ name: 'x.pdf', bytes: new Uint8Array() }])[0].error).toContain("can't be anonymised")
  })
})

describe('the parts', () => {
  it('write an amount in its own style, changed, and a balance with its own sign', () => {
    const written = readAmount('($1,234.50)')!
    expect(written).toMatchObject({ prefix: '($', suffix: ')', decimal: '.', group: ',', decimals: 2, value: -1234500000 })
    expect(rewrite(written, 2345600000)).toBe('($2,345.60)')
    expect(rewrite(readAmount('-12,50', ',')!, -9990000)).toBe('-9,99')
    expect(writeSigned(-5000000, readAmount('100.00')!)).toBe('-5.00')
    expect(writeSigned(5000000, readAmount('-100.00')!)).toBe('5.00')
    const amounts = new Amounts(seeded(1))
    const changed = amounts.change(-84120000, 2)                                           // -84.12
    expect(amounts.change(84120000, 2)).toBe(-changed)                                      // one factor per magnitude
    expect(Math.abs(changed) / 84120000).toBeGreaterThanOrEqual(0.79)
    expect(Math.abs(changed) / 84120000).toBeLessThanOrEqual(1.26)
    expect(amounts.change(0, 2)).toBe(0)
    expect(new Amounts(seeded(1), {}, true).change(-84120000, 2)).toBe(-84120000)
  })

  it('make up words and numbers consistently, never an original, in the original’s case and shape', () => {
    const words = new Pseudonyms(seeded(4))
    words.note('COSTCO WHSE 0123')
    const a = words.text('POS PURCHASE COSTCO WHSE #0123 OTTAWA ON')
    expect(a.text).toMatch(/^POS PURCHASE [A-Z]{6} [A-Z]{4} #\d{4} [A-Z]{6} ON$/)
    expect(words.text('Costco').text).toBe(a.text.split(' ')[2][0] + a.text.split(' ')[2].slice(1).toLowerCase())
    expect(a.text).not.toContain('0123')
    expect(words.shape('AB-12cd')).toMatch(/^[A-Z]{2}-\d{2}[a-z]{2}$/)
    expect(words.shape('XXXX3456', { masks: true })).toMatch(/^XXXX\d{4}$/)
    expect([...words.replaced]).toEqual(expect.arrayContaining(['costco', 'whse', '0123', 'ottawa']))
  })

  it('tell how a file was written, and when it needs a sidecar', () => {
    expect([lineEndOf('a\nb\n'), lineEndOf('a\r\nb\r\n'), lineEndOf('a\rb\r'), lineEndOf('one line')]).toEqual(['\n', '\r\n', '\r', '\n'])
    const ascii = decodeFile(new TextEncoder().encode('plain\n'), 'windows-1252')
    expect(sidecarFor(ascii, 'plain\n')).toBeUndefined()
    expect(sidecarFor(ascii, 'caf\u00e9\n')).toEqual({ encoding: 'windows-1252', bom: false, lineEnd: '\n' })
    expect(decodeFile(Uint8Array.of(0x43, 0xe9)).encoding).toBe('windows-1252')           // not UTF-8, and nothing declared
    expect(decodeFile(new TextEncoder().encode('Caf\u00e9')).encoding).toBe('utf-8')
    expect(encodeAs('C\u00e9\n', { encoding: 'utf-16le', bom: true, lineEnd: '\r\n' })).toEqual(Uint8Array.of(0xff, 0xfe, 0x43, 0, 0xe9, 0, 0x0d, 0, 0x0a, 0))
  })
})

describe('npm run anonymise', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve('node_modules/ts-node/dist/bin-esm.js'), '--transpile-only', 'scripts/anonymise.mts', ...args], { encoding: 'utf8' })
  /** As `npm run` runs it: from the project's root, with the folder it was started in as INIT_CWD. */
  const runIn = (folder: string, ...args: string[]) => spawnSync(process.execPath, [path.resolve('node_modules/ts-node/dist/bin-esm.js'), '--transpile-only', 'scripts/anonymise.mts', ...args], { encoding: 'utf8', env: { ...process.env, INIT_CWD: folder } })

  it('writes each file as <name>.anon.<ext>, reports what it replaced, and refuses a mapping kept in the repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-cli-'))
    const done = run(path.join(SAMPLES, OCTOBER), '--out', dir, '--map', path.join(dir, 'private', 'map.json'))
    expect(done.status, done.stderr).toBe(0)
    expect(done.stdout).toContain('1 account number, 18 ids, 17 payees, 15 memos, 17 amounts replaced')
    const sidecar = SAMPLE_LINE_END === '\n' ? [] : ['maple-trust-chequing-2026-10.anon.ofx.meta.json']   // CRLF checkouts
    expect(fs.readdirSync(dir).sort()).toEqual(['maple-trust-chequing-2026-10.anon.ofx', ...sidecar, 'private'])
    const mapping = JSON.parse(fs.readFileSync(path.join(dir, 'private', 'map.json'), 'utf8')) as Mapping
    expect(Object.keys(mapping).sort()).toEqual(Object.keys(emptyMapping()).sort())
    // It won't overwrite, and won't keep the originals inside the repository
    expect(run(path.join(SAMPLES, OCTOBER), '--out', dir).stdout).toContain('not written, as')
    const refused = run(path.join(SAMPLES, OCTOBER), '--map', 'map.json')
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain("can't be kept inside the repository")
    // --check finds the sample's account number, and exits 1
    const checked = run('--check', path.join(SAMPLES, OCTOBER))
    expect(checked.status).toBe(1)
    expect(checked.stdout).toContain('long number: ••••••••78')
  }, 60_000)

  it('refuses a file, saying where and how to allow what it found by its shape, and writes it when told to allow that', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-allow-'))
    fs.writeFileSync(path.join(folder, 'money.qif'), '!Type:Bank\nD1/5/26\nT-1.00\nPCoffee\nC613-555-0199\n^\n')
    const refused = runIn(folder, 'money.qif', '--out', 'out')
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain('line 5, the C field (cleared): phone number: •••-•••-••99  (shaped like 999-999-9999)')
    expect(refused.stdout).toContain('--allow-like 999-999-9999')
    expect(fs.existsSync(path.join(folder, 'out'))).toBe(false)
    // As it says: allowed by its shape, on the command line or in a file, it is written, and the report says so
    const allowed = runIn(folder, 'money.qif', '--out', 'out', '--allow-like', '999-999-9999')
    expect(allowed.status, allowed.stderr).toBe(0)
    expect(allowed.stdout).toContain('Written as it was, as allowed: read it before committing the file:')
    expect(fs.readFileSync(path.join(folder, 'out', 'money.anon.qif'), 'utf8')).toContain('C613-555-0199')
    fs.writeFileSync(path.join(folder, 'allow.txt'), '# public numbers\nlike 999-999-9999\n')
    fs.rmSync(path.join(folder, 'out'), { recursive: true })
    expect(runIn(folder, 'money.qif', '--out', 'out', '--allow-file', 'allow.txt').status).toBe(0)
    fs.writeFileSync(path.join(folder, 'bad.txt'), '[unclosed\n')
    expect(runIn(folder, 'money.qif', '--allow-file', 'bad.txt').stderr).toContain('line 1: “[unclosed” isn\'t a regular expression (start it with “like ” for an example).')
  }, 90_000)

  it('reads relative paths from the folder it was run in, and suggests the names closest to one that isn’t there', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-here-'))
    for (const name of ['bank1-checking.csv', 'bank1-chequing.qbo', 'bank2-chequing.qbo']) fs.copyFileSync(path.join(SAMPLES, OCTOBER), path.join(folder, name))
    const typo = runIn(folder, 'bank1-checking.qbo', '--out', 'converted')
    expect(typo.status).toBe(2)
    expect(typo.stderr).toContain(`${path.join(folder, 'bank1-checking.qbo')} doesn't exist. Did you mean “bank1-chequing.qbo” or “bank1-checking.csv” or “bank2-chequing.qbo”?`)
    const done = runIn(folder, 'bank1-chequing.qbo', '--out', 'converted')
    expect(done.status, done.stderr).toBe(0)
    expect(fs.readdirSync(path.join(folder, 'converted'))).toContain('bank1-chequing.anon.qbo')
    expect(runIn(folder, path.join('nowhere', 'x.qbo')).stderr).toContain(`there is no folder ${path.join(folder, 'nowhere')}`)
  }, 60_000)
})
