// @vitest-environment node
// The anonymiser, over a "real" file built here — a dossier of made-up names, numbers and addresses in the
// places a bank puts them — and over every committed fixture, which must pass the checks on every test run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOfx } from '../../plugins/exchange.ofx/src/privileged/index'
import { anonymizeCsv, amountMinor, csvShape, formatLike, isHeaderRow, parseCsv, roleOfHeader, shiftCsvDate } from '../../scripts/anonymize/csv'
import { anonymizeOfx } from '../../scripts/anonymize/ofx'
import { anonymizeQif, fakeCategory, qifShape, shiftQifDate } from '../../scripts/anonymize/qif'
import { Deriver, failLuhn, fakeAmountMinor, fakeNumbers, fakePayee, isGenericBankingText, luhnValid, sameShape, shiftOfxDate } from '../../scripts/anonymize/derive'
import { check, main, parseArgs } from '../../scripts/anonymize/main'
import { checkCsvFile, checkFile, checkQifFile, patternMatches, verifyCsvOutput, verifyOutput, verifyQifOutput } from '../../scripts/anonymize/verify'

const FIXTURES = path.resolve(__dirname, '../fixtures/exchange')
const SEED = new TextEncoder().encode('a test seed, thirty-two bytes!!')
const OTHER = new TextEncoder().encode('another seed, also long enough..')

/** A statement as a real bank writes one, Windows-1252 and CRLF, with everything a dossier would hold. */
function realFile(over: { extra?: string, rows?: string } = {}): Uint8Array {
  const rows = over.rows ?? `        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20261003120000[-5:EST]
          <TRNAMT>-142.00
          <FITID>20261003001A7F3B2
          <CHECKNUM>1042
          <NAME>HYDRO OTTAWA 4471
          <MEMO>Bill payment Acct 7788-990
        </STMTTRN>
        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20261005120000[-5:EST]
          <TRNAMT>-4.50
          <FITID>20261005002C8D1E9
          <NAME>SQ *THE DAILY GRIND 4471 OTTAWA ON
          <SIC>5812
        </STMTTRN>
        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20261012120000[-5:EST]
          <TRNAMT>-4.50
          <FITID>20261012003C8D1EA
          <NAME>SQ *THE DAILY GRIND 4471 OTTAWA ON
        </STMTTRN>
        <STMTTRN>
          <TRNTYPE>CREDIT
          <DTPOSTED>20261015120000[-5:EST]
          <TRNAMT>2140.00
          <FITID>20261015004E0F2A1
          <CHECKNUM>1039
          <NAME>ACME WIDGETS PAYROLL
          <PAYEE>
            <NAME>Acme Widgets Inc
            <ADDR1>12 Rideau Street
            <CITY>Ottawa
            <STATE>ON
            <POSTALCODE>K1N 5W7
            <COUNTRY>CAN
            <PHONE>+1 613 555 0199
          </PAYEE>
        </STMTTRN>`
  const text = `OFXHEADER:100\r
DATA:OFXSGML\r
VERSION:102\r
SECURITY:NONE\r
ENCODING:USASCII\r
CHARSET:1252\r
COMPRESSION:NONE\r
OLDFILEUID:NONE\r
NEWFILEUID:NONE\r
\r
<OFX>\r
<SIGNONMSGSRSV1>\r
  <SONRS>\r
    <STATUS>\r
      <CODE>0\r
      <SEVERITY>INFO\r
    </STATUS>\r
    <DTSERVER>20261031235959[-5:EST]\r
    <LANGUAGE>ENG\r
    <FI>\r
      <ORG>Royal Maple Bank of Canada\r
      <FID>003\r
    </FI>\r
    <INTU.BID>00003\r
    <INTU.USERID>jane.doe@example.com\r
${over.extra ?? ''}  </SONRS>\r
</SIGNONMSGSRSV1>\r
<BANKMSGSRSV1>\r
  <STMTTRNRS>\r
    <TRNUID>2026-10-00412\r
    <STATUS>\r
      <CODE>0\r
      <SEVERITY>INFO\r
    </STATUS>\r
    <STMTRS>\r
      <CURDEF>CAD\r
      <BANKACCTFROM>\r
        <BANKID>000300002\r
        <ACCTID>00412-1234567\r
        <ACCTTYPE>CHECKING\r
      </BANKACCTFROM>\r
      <BANKTRANLIST>\r
        <DTSTART>20261001000000[-5:EST]\r
        <DTEND>20261031235959[-5:EST]\r
${rows.replace(/\n/g, '\r\n')}\r
      </BANKTRANLIST>\r
      <LEDGERBAL>\r
        <BALAMT>4182.11\r
        <DTASOF>20261031235959[-5:EST]\r
      </LEDGERBAL>\r
      <AVAILBAL>\r
        <BALAMT>4182.11\r
        <DTASOF>20261031235959[-5:EST]\r
      </AVAILBAL>\r
    </STMTRS>\r
  </STMTTRNRS>\r
</BANKMSGSRSV1>\r
</OFX>\r
`
  return Buffer.from(text, 'latin1')
}

const asText = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')
const fixtureFiles = () => fs.readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(ofx|qfx|qbo)$/i.test(entry.name))
  .map(entry => path.join(entry.parentPath, entry.name))

const dirs: string[] = []
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('what each field becomes', () => {
  const derive = new Deriver(SEED)

  it('makes every 13–19 digit window of a long run fail Luhn, in ids and in a payee’s trailing reference alike', () => {
    for (const run of ['4111111111111111', '4111111111111111222', '79927398713']) {
      const fixed = failLuhn(run)
      for (let start = 0; start + 13 <= fixed.length; start += 1) {
        for (let length = 13; length <= 19 && start + length <= fixed.length; length += 1) expect(luhnValid(fixed.slice(start, start + length))).toBe(false)
      }
    }
    expect(failLuhn('short 1234')).toBe('short 1234')
    const payee = fakePayee(derive, 'INTERAC E-TRANSFER 4111111111111111')
    expect(luhnValid(/\d{13,19}/.exec(payee)?.[0] ?? '')).toBe(false)
  })

  it('keeps a value’s shape — digits for digits, case for case, separators in place — and never a valid card number', () => {
    const account = sameShape(derive, 'account', '00412-1234567')
    expect(account).toMatch(/^\d{5}-\d{7}$/)
    expect(account).not.toBe('00412-1234567')
    const card = sameShape(derive, 'account', '4510220011889043')
    expect(card).toMatch(/^\d{16}$/)
    expect(luhnValid(card)).toBe(false)
    expect(sameShape(derive, 'id', 'A7f3-B2')).toMatch(/^[A-Z]\d[a-z]\d-[A-Z]\d$/)
  })

  it('preserves a payee’s shape: processor prefix, store number, capitals, and length class', () => {
    const fake = fakePayee(derive, 'SQ *THE DAILY GRIND 4471 OTTAWA ON')
    expect(fake).toMatch(/^SQ \*/)
    expect(fake).toBe(fake.toUpperCase())
    expect(fake).not.toContain('DAILY GRIND')
    expect(fakePayee(derive, 'Netflix')).not.toMatch(/\s/)   // short stays a single word
    expect(fakePayee(derive, 'HYDRO OTTAWA 4471')).toMatch(/ \d{4}$/)
    expect(fakePayee(derive, 'Acme')).toBe(fakePayee(derive, 'Acme'))
    expect(fakePayee(new Deriver(OTHER), 'Acme')).not.toBe(fakePayee(derive, 'Acme'))
  })

  it('keeps an amount in its magnitude bucket, sign and all, and the same amount the same', () => {
    expect(fakeAmountMinor(derive, -450)).toBeLessThan(0)
    expect(Math.abs(fakeAmountMinor(derive, -450))).toBeLessThan(1_000)
    expect(Math.abs(fakeAmountMinor(derive, 214_000))).toBeGreaterThanOrEqual(100_000)
    expect(Math.abs(fakeAmountMinor(derive, 214_000))).toBeLessThan(1_000_000)
    expect(fakeAmountMinor(derive, -450)).toBe(fakeAmountMinor(derive, -450))
    expect(fakeAmountMinor(derive, 0)).toBe(0)
  })

  it('shifts a date by whole weeks and leaves the time and zone as written', () => {
    expect(shiftOfxDate('20261003120000[-5:EST]', -14)).toBe('20260919120000[-5:EST]')
    expect(shiftOfxDate('20260101', -7)).toBe('20251225')
    expect(shiftOfxDate('not a date', -7)).toBe('not a date')
  })

  it('keeps a payee or memo that is only generic banking words, and replaces one that names anybody', () => {
    for (const generic of ['WITHDRAWAL', 'Bill Payment', 'INTERAC E-TRANSFER', 'Monthly fee', 'Pre-authorized debit']) {
      expect(isGenericBankingText(generic), generic).toBe(true)
    }
    for (const naming of ['HYDRO OTTAWA', 'Payroll ACME WIDGETS', 'E-TRANSFER JANE DOE', 'SQ *THE DAILY GRIND', 'EFT88412233', 'Bill payment 7788-990']) {
      expect(isGenericBankingText(naming), naming).toBe(false)
    }
    const rows = `        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20261003120000[-5:EST]
          <TRNAMT>-142.00
          <FITID>20261003001A7F3B2
          <NAME>WITHDRAWAL
          <MEMO>E-TRANSFER JANE DOE
        </STMTTRN>`
    const result = anonymizeOfx(realFile({ rows }), { seed: SEED })
    const text = asText(result.output)
    expect(text).toContain('<NAME>WITHDRAWAL')
    expect(text).not.toContain('JANE')
    expect(result.sensitive.has('WITHDRAWAL')).toBe(false)
  })

  it('renumbers cheques in their original order, keeping the width', () => {
    const mapped = fakeNumbers(derive, ['1042', '1039', '1042', 'REF-77'])
    expect(Number(mapped.get('1039'))).toBeLessThan(Number(mapped.get('1042')))
    expect(mapped.get('1042')).toMatch(/^\d{4}$/)
    expect(mapped.get('REF-77')).toMatch(/^[A-Z]{3}-\d{2}$/)
  })
})

describe('anonymising a file', () => {
  it('lets nothing from the input survive, and says so when checked', () => {
    const input = realFile()
    const result = anonymizeOfx(input, { seed: SEED })
    const text = asText(result.output)
    for (const value of ['Royal Maple', 'jane.doe', '1234567', 'HYDRO OTTAWA', 'DAILY GRIND', 'Acme Widgets', 'Rideau', 'K1N 5W7', '613 555', '4182.11', '20261003001A7F3B2']) {
      expect(text, value).not.toContain(value)
    }
    const verification = verifyOutput({
      input, output: result.output, outputText: result.text, sensitive: result.sensitive, formatId: 'exchange-ofx.ofx',
      structure: { inputTags: result.inputTags, outputTags: result.tags, dropped: new Set(['INTU.USERID', 'ADDR1', 'CITY', 'STATE', 'POSTALCODE', 'COUNTRY', 'PHONE', 'SIC']) }
    })
    expect(verification).toMatchObject({ substringMatches: 0, patternMatches: 0, parsed: true, structureMatched: true, problems: [] })
  })

  it('is the same output for the same seed, and a different one for a different seed', () => {
    const once = anonymizeOfx(realFile(), { seed: SEED })
    const twice = anonymizeOfx(realFile(), { seed: SEED })
    const other = anonymizeOfx(realFile(), { seed: OTHER })
    expect(Buffer.from(twice.output).equals(Buffer.from(once.output))).toBe(true)
    expect(Buffer.from(other.output).equals(Buffer.from(once.output))).toBe(false)
  })

  it('parses to the same statements and rows, keeps the layout, and still reads as Windows-1252 CRLF', () => {
    const input = realFile()
    const result = anonymizeOfx(input, { seed: SEED })
    const before = readOfx(input, { formatId: 'exchange-ofx.ofx' })
    const after = readOfx(result.output, { formatId: 'exchange-ofx.ofx' })
    expect(after.statements).toHaveLength(1)
    expect(after.statements[0].transactions).toHaveLength(before.statements[0].transactions.length)
    expect(asText(result.output).startsWith('OFXHEADER:100\r\nDATA:OFXSGML\r\n')).toBe(true)
    expect(asText(result.output)).toMatch(/\r\n        <STMTTRN>\r\n          <TRNTYPE>DEBIT\r\n/)
    // The dropped INTU.USERID line is gone whole; the line after it keeps its own indentation
    expect(asText(result.output)).toMatch(/<INTU.BID>9999\r\n  <\/SONRS>\r\n/)
    expect(after.institution).toEqual({ name: 'Example Bank', id: '9999' })
  })

  it('recomputes every balance from the synthetic rows, so the file still adds up', () => {
    const result = anonymizeOfx(realFile(), { seed: SEED })
    const after = readOfx(result.output, { formatId: 'exchange-ofx.ofx' })
    const [statement] = after.statements
    const sum = statement.transactions.reduce((n, t) => n + t.amount, 0)
    expect(statement.balances?.ledger?.amount).toBe(result.openingBalances[0] + sum)
    expect(statement.balances?.available?.amount).toBe(result.openingBalances[0] + sum)
    expect(statement.balances?.ledger?.amount).not.toBe(418_211)
  })

  it('shifts every date by the same number of weeks: weekdays and intervals survive', () => {
    const input = realFile()
    const result = anonymizeOfx(input, { seed: SEED })
    const before = readOfx(input, { formatId: 'exchange-ofx.ofx' }).statements[0].transactions.map(t => t.date)
    const after = readOfx(result.output, { formatId: 'exchange-ofx.ofx' }).statements[0].transactions.map(t => t.date)
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
    const shifts = before.map((date, at) => day(after[at]) - day(date))
    expect(new Set(shifts).size).toBe(1)
    expect(Math.abs(shifts[0]) % 7).toBe(0)
    expect(shifts[0]).toBeLessThan(0)
    expect(result.dateShiftDays).toBe(shifts[0])
  })

  it('keeps a repeated charge repeated, and the same payee the same payee', () => {
    const after = readOfx(anonymizeOfx(realFile(), { seed: SEED }).output, { formatId: 'exchange-ofx.ofx' })
    const coffees = after.statements[0].transactions.filter(t => t.payee?.startsWith('SQ *'))
    expect(coffees).toHaveLength(2)
    expect(coffees[0].amount).toBe(coffees[1].amount)
    expect(coffees[0].payee).toBe(coffees[1].payee)
  })

  it('drops a tag it has no policy for, counts it by name, and never records its value', () => {
    const result = anonymizeOfx(realFile({ extra: '    <EMAIL>jane.doe@example.com\r\n    <MKTGINFO>Visit us at https://bank.example/offers?u=jane\r\n' }), { seed: SEED })
    expect(result.unrecognised).toContainEqual({ tag: 'SIC', count: 1 })
    expect(result.unrecognised).toContainEqual({ tag: 'MKTGINFO', count: 1 })
    expect(JSON.stringify(result.unrecognised)).not.toContain('jane')
    expect(asText(result.output)).not.toContain('SIC')
    expect(asText(result.output)).not.toContain('offers')
  })

  it('fails the verification when a field is wired to pass through, naming the field and the shape — never the value', () => {
    const input = realFile()
    const result = anonymizeOfx(input, { seed: SEED, unsafePassThrough: new Set(['NAME']) })
    const verification = verifyOutput({
      input, output: result.output, outputText: result.text, sensitive: result.sensitive, sensitiveTags: result.sensitiveTags, formatId: 'exchange-ofx.ofx',
      structure: { inputTags: result.inputTags, outputTags: result.tags, dropped: new Set(['INTU.USERID', 'ADDR1', 'CITY', 'STATE', 'POSTALCODE', 'COUNTRY', 'PHONE', 'SIC']) }
    })
    expect(verification.substringMatches).toBeGreaterThan(0)
    expect(verification.problems[0]).toMatch(/survived into the output/)
    expect(verification.problems.join('\n')).toMatch(/a <NAME> value of \d+ characters, shaped “[A9 *-]+”/)
    expect(verification.problems.join('\n')).not.toMatch(/HYDRO|GRIND|ACME/)
  })

  it('does not mistake an OFX timestamp for a card number, or a hex reference for an IBAN', () => {
    expect(patternMatches('<DTSERVER>20261031235959[-5:EST]<DTPOSTED>20261003120000')).toEqual([])
    expect(patternMatches('<FITID>DE12FCD258B9EBB6AA')).toEqual([])
    expect(patternMatches('IBAN GB82WEST12345698765432').map(p => p.name)).toEqual(['an IBAN'])
    // Reserved example domains identify nobody; a real-looking address is still caught
    expect(patternMatches('householder@example.invalid someone@example.com')).toEqual([])
    expect(patternMatches('householder@gmail.com').map(p => p.name)).toEqual(['an email address'])
  })

  it('flags identifying shapes whether or not the input held them', () => {
    const names = patternMatches('card 4111111111111111, mail jane@acme-widgets.ca, call +1 613 555 0199, K1N 5W7, 12 Rideau Street').map(p => p.name)
    expect(names).toEqual(expect.arrayContaining([
      expect.stringMatching(/card number/), 'an email address', 'an international phone number', 'a Canadian postal code', 'a street address'
    ]))
  })
})

/** A bank's export with a header, a BOM, CRLF, a leading column nobody has a rule for, and a running balance. */
const withHeader = () => Buffer.from('\ufeff' + [
  'Filter,Date,Description,Sub-description,Type of Transaction,Amount,Balance',
  '"Chequing 00412-1234567","2026-10-03","HYDRO OTTAWA","Bill payment 7788-990 Jane Doe","Debit","-142.00","4040.11"',
  '"Chequing 00412-1234567","2026-10-05","SQ *THE DAILY GRIND 4471","Point of sale","Debit","-4.50","4035.61"',
  '"Chequing 00412-1234567","2026-10-15","ACME WIDGETS PAYROLL","Direct deposit","Credit","2140.00","6175.61"',
  ''
].join('\r\n'), 'utf8')

/** Another bank's: no header at all, every cell quoted, a debit column, an empty credit column, LF endings. */
const headerless = () => Buffer.from([
  '"2026-10-03","HYDRO OTTAWA","142.00",,"4040.11"',
  '"2026-10-05","THE DAILY GRIND 4471","4.50",,"4035.61"',
  '"2026-10-12","THE DAILY GRIND 4471","4.50",,"4031.11"',
  '"2026-10-15","ACME WIDGETS PAYROLL",,"2140.00","6171.11"',
  ''
].join('\n'), 'utf8')

describe('CSV shapes', () => {
  it('reads the header for each column’s role, and infers the roles when there is no header', () => {
    expect(['Date', 'Description', 'Sub-description', 'Type of Transaction', 'Amount', 'Balance', 'Filter', 'Cheque No.'].map(roleOfHeader))
      .toEqual(['date', 'payee', 'memo', 'enum', 'amount', 'balance', 'unknown', 'number'])
    expect(isHeaderRow(parseCsv('Date,Description,Amount', ',')[0])).toBe(true)
    expect(isHeaderRow(parseCsv('"2026-10-03","HYDRO","142.00"', ',')[0])).toBe(false)
    const result = anonymizeCsv(headerless(), { seed: SEED })
    expect(result.columns.map(c => c.role)).toEqual(['date', 'payee', 'amount', 'amount', 'balance'])
  })

  it('handles an empty known leaf and an element that never closes without losing the file', () => {
    const rows = `        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20261003120000[-5:EST]
          <TRNAMT>-142.00
          <FITID>20261003001A7F3B2
          <NAME>HYDRO OTTAWA 4471
          <WEIRDBLOCK>
            <X>1
        </STMTTRN>`
    const input = realFile({ rows }).toString('latin1').replace('<ACCTTYPE>CHECKING', '<ACCTTYPE>')
    const result = anonymizeOfx(Buffer.from(input, 'latin1'), { seed: SEED })
    const after = readOfx(result.output, { formatId: 'exchange-ofx.ofx' })
    expect(after.statements[0].transactions).toHaveLength(1)
    expect(asText(result.output)).toMatch(/<ACCTTYPE>\r\n/)
    expect(result.unrecognised).toContainEqual({ tag: 'WEIRDBLOCK', count: 1 })
  })
})

describe('anonymising a CSV export', () => {
  it('keeps the shape — BOM, CRLF, quoting, columns, rows — and lets nothing from the input survive', () => {
    const input = withHeader()
    const result = anonymizeCsv(input, { seed: SEED })
    const text = result.text
    expect(result.output[0]).toBe(0xef)   // the BOM is still there
    expect(text.split('\r\n')).toHaveLength(5)
    // `Filter` is a column name nothing recognises, so it is replaced like any unknown text: by shape alone it
    // cannot be told from a holder's name on a bank's preamble line.
    expect(text.split('\r\n')[0]).toBe('\ufeffColumn 1,Date,Description,Sub-description,Type of Transaction,Amount,Balance')
    expect(text.split('\r\n')[1].split(',')).toHaveLength(7)
    expect(text.split('\r\n')[1].startsWith('"')).toBe(true)
    for (const value of ['1234567', 'HYDRO OTTAWA', 'DAILY GRIND', 'Jane Doe', '7788-990', 'ACME', '4040.11', '6175.61']) expect(text, value).not.toContain(value)
    expect(text).toContain('"Debit"')   // the type words are an enum and pass
    const verification = verifyCsvOutput({ input, output: result.output, outputText: result.text, sensitive: result.sensitive })
    expect(verification.problems).toEqual([])
    // The report names the column by position, never by its text: it promises counts and tags, never values.
    expect(result.unrecognised).toEqual([{ tag: 'column:#1', count: 1 }])
  })

  it('rebuilds the running balance from the synthetic amounts, in the file’s own direction', () => {
    const result = anonymizeCsv(withHeader(), { seed: SEED })
    const rows = result.text.split('\r\n').slice(1, 4).map(line => parseCsv(line, ',')[0].map(c => c.text))
    const amounts = rows.map(r => amountMinor(r[5])!)
    const balances = rows.map(r => amountMinor(r[6])!)
    expect(balances[1] - balances[0]).toBe(amounts[1])
    expect(balances[2] - balances[1]).toBe(amounts[2])
    expect(amounts[0]).toBeLessThan(0)
    expect(amounts[2]).toBeGreaterThan(0)
    // The headerless file writes debits and credits as magnitudes in their own columns: the balance falls with
    // one and rises with the other, each column's direction read from the rows themselves
    const other = anonymizeCsv(headerless(), { seed: SEED })
    const lines = other.text.split('\n').slice(0, 4).map(line => parseCsv(line, ',')[0].map(c => c.text))
    expect(amountMinor(lines[1][4])! - amountMinor(lines[0][4])!).toBe(-amountMinor(lines[1][2])!)
    expect(amountMinor(lines[3][4])! - amountMinor(lines[2][4])!).toBe(amountMinor(lines[3][3])!)
    expect(lines[1][3]).toBe('')   // the empty credit column stays empty
    expect(lines[1][1]).toBe(lines[2][1])   // the same payee stays the same payee
  })

  it('shifts dates in the shape they came in, and writes amounts the way the cell did', () => {
    expect(shiftCsvDate('2026-10-03', -14, 'mdy')).toBe('2026-09-19')
    expect(shiftCsvDate('03/10/2026', -14, 'dmy')).toBe('19/09/2026')
    expect(shiftCsvDate('10/03/2026', -14, 'mdy')).toBe('09/19/2026')
    expect(shiftCsvDate('03-Oct-2026', -14, 'mdy')).toBe('19-Sep-2026')
    expect(shiftCsvDate('Oct 3, 2026', -14, 'mdy')).toBe('Sep 19, 2026')
    expect(formatLike('-1,234.56', -98765)).toBe('-987.65')
    expect(formatLike('(142.00)', -5000)).toBe('(50.00)')
    expect(formatLike('$2,140.00', 123456)).toBe('$1,234.56')
    expect(formatLike('142', -5000)).toBe('-50')
  })

  it('checks a committed CSV fixture for identifying shapes and that it still reads as rows', () => {
    expect(checkCsvFile(Buffer.from('Date,Payee,Amount\n2026-10-01,Grocer,-4.50\n')).ok).toBe(true)
    expect(checkCsvFile(Buffer.from('Date,Payee,Amount\n2026-10-01,jane@gmail.com,-4.50\n')).problems[0]).toMatch(/email/)
  })
})

/** A Money export: an !Account block, ISO dates, grouped amounts, cleared marks, a transfer, a split, an address. */
const qifFile = (over: { strict?: boolean } = {}) => {
  const cat = (full: string, short: string) => over.strict ? short : full
  return Buffer.from([
    '!Account', 'NJane and John Joint Chequing', 'TBank', 'DRoyal Maple Bank 00412-1234567', '^',
    '!Type:Bank',
    'D2026-10-03', 'T-142.00', 'C*', 'NEFT88412233', 'PHYDRO OTTAWA 4471', 'MBill payment Acct 7788-990', `L${cat('Utilities & Services:Electricity Bill', 'Utilities & Ser:Electricity Bil')}`, '^',
    'D2026-10-05', 'T-4.50', 'PSQ *THE DAILY GRIND 4471 OTTAWA ON', 'MCoffee', `L${cat('Dining Out', 'Dining Out')}`, '^',
    'D2026-10-10', 'T-500.00', 'NDEP', 'PTransfer to savings', 'L[Jane and John Savings]', '^',
    'D2026-10-15', 'T2,140.00', 'CX', 'N1042', 'PACME WIDGETS PAYROLL', 'A12 Rideau Street', 'AOttawa ON K1N 5W7', `L${cat('Salary Income', 'Salary Income')}`, '^',
    'D2026-10-20', 'T-1,250.00', 'N1043', 'PRIDEAU PROPERTY MGMT', `S${cat('Housing Expenses:Rent Payment', 'Housing Expense:Rent Payment')}`, 'EOctober rent', '$-1,200.00', `S${cat('Housing Expenses:Parking Spot', 'Housing Expense:Parking Spot')}`, 'EParking', '$-50.00', '^',
    ''
  ].join('\r\n'), 'latin1')
}

describe('a CSV the anonymiser must not pass through', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  // A bank's preamble line has no date or amount, so it reads as the header row. Copied verbatim, it committed
  // the holder's name and account number — and verification passed, because header cells were never checked.
  it('replaces a header cell it does not recognise, and remembers it so verification would catch it', () => {
    const input = bytes('Account Holder:,JOHN Q SMITHERSON,Acct 0012-3456789\nDate,Description,Amount,Balance\n2026-01-02,TIM HORTONS 1234,-5.00,100.00\n')
    const result = anonymizeCsv(input, { seed: SEED })
    for (const value of ['SMITHERSON', '0012-3456789', '3456789']) expect(result.text, value).not.toContain(value)
    expect(result.sensitive).toContain('JOHN Q SMITHERSON')
    expect(verifyCsvOutput({ input, output: result.output, outputText: result.text, sensitive: result.sensitive }).problems).toEqual([])
  })

  it('does not trust a recognised column name that carries digits', () => {
    // `Account 0012-3456789` is the account role by its word, and an account number by its digits.
    const input = bytes('Date,Description,Amount,Account 0012-3456789\n2026-01-02,TIM HORTONS,-5.00,x\n')
    const result = anonymizeCsv(input, { seed: SEED })
    expect(result.text).not.toContain('0012-3456789')
    // Ordinary names still pass, so the fixture keeps its shape.
    expect(result.text.split('\n')[0].startsWith('Date,Description,Amount,')).toBe(true)
  })

  // A balance the anonymiser cannot parse cannot be rebuilt from the fake amounts, so the placeholder — the
  // real figure — was written out, and nothing remembered it.
  it('drops a balance it cannot parse rather than writing the real figure', () => {
    const input = bytes('Date,Description,Amount,Balance\n2026-01-02,TIM HORTONS,-5.00,12345.67 CR\n2026-01-03,SALARY ACME,1000.00,13345.67 CR\n')
    const result = anonymizeCsv(input, { seed: SEED })
    for (const value of ['12345.67', '13345.67']) expect(result.text, value).not.toContain(value)
    expect(result.sensitive).toContain('12345.67 CR')
  })
})

describe('the leak check', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  // Input and output share a shape, so the leak check is the only thing that can report a problem — otherwise
  // a shape mismatch would make every expectation of "a problem" pass for the wrong reason.
  const check = (output: string, sensitive: string[]) => verifyCsvOutput({
    input: bytes(output), output: bytes(output), outputText: output, sensitive: new Set(sensitive)
  }).problems

  it('finds an account number written with different separators', () => {
    for (const written of ['00123456789', '0012 3456789', '0012.345.6789']) {
      expect(check(`Date,Memo,Amount\n2025-03-07,Ref ${written},-8.55\n`, ['0012-3456789']), written).not.toEqual([])
    }
  })

  it('does not run neighbouring cells together into a false match', () => {
    // A date and an amount in adjacent cells share digits with nothing sensitive once the comma separates them.
    expect(check('Date,Memo,Amount\n2025-03-07,Coffee,-8.55\n', ['20250307855'])).toEqual([])
  })

  it('still finds an exact copy of a word value, as before', () => {
    expect(check('Date,Memo,Amount\n2025-03-07,john smith,-8.55\n', ['JOHN SMITH'])).not.toEqual([])
  })
})

describe('a CSV with a preamble above its header', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const lines = (text: string) => anonymizeCsv(bytes(text), { seed: SEED }).text.split('\n')

  it('finds the real header below the preamble, so the rows are anonymised as rows', () => {
    const out = lines('Statement Period: October 2026\nDate,Description,Amount,Balance\n2026-10-02,TIM HORTONS,-5.00,100.00\n')
    expect(out[1]).toBe('Date,Description,Amount,Balance')
    expect(out[2]).not.toContain('TIM HORTONS')
    expect(out[2]).toMatch(/^\d{4}-\d{2}-\d{2},/)
  })

  it('keeps a preamble line that carries nothing personal, as the bank wrote it', () => {
    const out = lines('Page 1 of 2,Account Summary\nDate,Description,Amount\n2026-10-02,COFFEE,-4.50\n')
    expect(out[0]).toBe('Page 1 of 2,Account Summary')
  })

  it('shifts a preamble’s dates by the same days as the rows, month names included', () => {
    const result = anonymizeCsv(bytes('Statement Period: October 2026\nDate,Description,Amount\n2026-10-15,COFFEE,-4.50\n'), { seed: SEED })
    const [preamble, , row] = result.text.split('\n')
    const shiftedRow = new Date(`${row.split(',')[0]}T00:00:00Z`)
    const month = shiftedRow.toLocaleString('en', { month: 'long', timeZone: 'UTC' })
    expect(preamble).toBe(`Statement Period: ${month} ${shiftedRow.getUTCFullYear()}`)
    expect(preamble).not.toContain('October')
  })

  it('replaces only the personal pieces of a line, and remembers them', () => {
    const result = anonymizeCsv(bytes('Account Holder:,JOHN Q SMITHERSON,Acct 0012-3456789\nDate,Description,Amount\n2026-10-02,COFFEE,-4.50\n'), { seed: SEED })
    const [preamble] = result.text.split('\n')
    // The labels stay; the name and the number do not.
    expect(preamble.startsWith('Account Holder:,')).toBe(true)
    expect(preamble).toMatch(/,Acct \d{4}-\d{7}$/)
    for (const value of ['SMITHERSON', '0012-3456789']) expect(preamble).not.toContain(value)
    expect(result.sensitive).toContain('JOHN Q SMITHERSON')
    expect(result.sensitive).toContain('0012-3456789')
  })

  it('reads the delimiter from the table, not from a title line that has none', () => {
    const out = lines('Maple Trust - Savings\nDate;Description;Amount\n2026-10-02;COFFEE;-4,50\n')
    expect(out[1]).toBe('Date;Description;Amount')
    expect(out[2].split(';')).toHaveLength(3)
  })
})

describe('anonymising a QIF export', () => {
  it('keeps the file line for line — control lines, records, endings — and lets nothing identifying survive', () => {
    const input = qifFile()
    const result = anonymizeQif(input, { seed: SEED })
    const text = result.text
    expect(text.split('\r\n').filter(l => l === '^')).toHaveLength(6)
    expect(text).toMatch(/^!Account\r\nN/)
    expect(text).toContain('\r\n!Type:Bank\r\n')
    for (const value of ['Jane', 'John', 'Royal Maple', '1234567', 'HYDRO', 'DAILY GRIND', 'ACME', 'Rideau', 'K1N 5W7', '7788-990', 'Utilities & Services', 'Housing Expenses', '88412233']) {
      expect(text, value).not.toContain(value)
    }
    expect(text).not.toMatch(/^A/m)   // the address lines are gone
    const verification = verifyQifOutput({ input, outputText: text, sensitive: result.sensitive, sensitiveTags: result.sensitiveTags, unrecognised: result.unrecognised })
    expect(verification.problems).toEqual([])
    expect(result.unrecognised).toEqual([])
  })

  it('maps categories onto the starter chart keeping their depth, transfers onto consistent fake account names', () => {
    const result = anonymizeQif(qifFile(), { seed: SEED })
    const lines = result.text.split('\r\n')
    const categories = lines.filter(l => /^[LS][^[]/.test(l)).map(l => l.slice(1))
    expect(categories.some(c => c.includes(':'))).toBe(true)
    for (const c of categories) for (const segment of c.split(':')) expect(['Salary', 'Interest', 'Dividends', 'Gifts received', 'Other income', 'Housing', 'Utilities', 'Food', 'Transportation', 'Health', 'Personal', 'Entertainment', 'Gifts and donations', 'Education', 'Childcare', 'Travel', 'Bank fees', 'Interest paid', 'Taxes', 'Miscellaneous', 'Rent', 'Mortgage interest', 'Property tax', 'Home insurance', 'Maintenance', 'Electricity', 'Heating', 'Water', 'Internet', 'Phone', 'Groceries', 'Dining out', 'Fuel', 'Public transit', 'Car insurance', 'Car maintenance', 'Parking', 'Medical', 'Dental', 'Pharmacy', 'Clothing', 'Personal care', 'Other']).toContain(segment)
    const accountLine = lines.find(l => l.startsWith('N') && lines.indexOf(l) < 5)!
    const transfer = lines.find(l => l.startsWith('L['))!
    expect(transfer).toMatch(/^L\[[A-Za-z ]+\]$/)
    expect(transfer.slice(2, -1)).not.toBe(accountLine.slice(1))   // two real accounts stay two fake ones
    expect(fakeCategory(new Deriver(SEED), 'Auto:Fuel/Work', undefined)).toMatch(/^[A-Za-z ]+:[A-Za-z ]+\/(Home|Work|Rental|Trip|Project|Shared)$/)
    expect(fakeCategory(new Deriver(SEED), 'Auto:Fuel', 15).split(':').every(s => s.length <= 15)).toBe(true)
  })

  it('rebuilds a split’s total from its synthetic parts, and keeps T and U together', () => {
    const result = anonymizeQif(qifFile(), { seed: SEED })
    const records = result.text.split('^')
    const split = records.find(r => r.includes('\r\nS'))!
    const parts = [...split.matchAll(/\r\n\$(-?[\d,]+\.\d\d)/g)].map(m => amountMinor(m[1])!)
    const total = amountMinor(/\r\nT(-?[\d,]+\.\d\d)/.exec(split)![1])!
    expect(parts).toHaveLength(2)
    expect(total).toBe(parts[0] + parts[1])
    expect(/\r\nT-[\d,]+\.\d\d/.test(split)).toBe(true)
  })

  it('learns the dialect field by field: a strict export’s categories stay within fifteen characters', () => {
    const strict = anonymizeQif(qifFile({ strict: true }), { seed: SEED })
    for (const line of strict.text.split('\r\n').filter(l => /^[LS][^[]/.test(l))) {
      for (const segment of line.slice(1).split(':')) expect(segment.length, line).toBeLessThanOrEqual(15)
    }
    // Payees were full length in the input, so they are not capped — exactly as Money's strict export has it:
    // the same payees come out the same as from the loose file
    const loose = anonymizeQif(qifFile(), { seed: SEED })
    const payees = (text: string) => text.split('\r\n').filter(l => l.startsWith('P') && !l.startsWith('PTransfer'))
    expect(payees(strict.text)).toEqual(payees(loose.text))
    // The loose file's categories are mapped whole; the strict file's are capped at fifteen
    expect(loose.text).toContain(`\r\nL${fakeCategory(new Deriver(SEED), 'Utilities & Services:Electricity Bill', undefined)}\r\n`)
    expect(strict.text).toContain(`\r\nL${fakeCategory(new Deriver(SEED), 'Utilities & Ser:Electricity Bil', 15)}\r\n`)
  })

  it('shifts every date form QIF uses, and keeps number codes while changing the references in them', () => {
    expect(shiftQifDate('2026-10-03', -14, 'mdy')).toBe('2026-09-19')
    expect(shiftQifDate("10/3'26", -14, 'mdy')).toBe("9/19'26")
    expect(shiftQifDate("1/ 5'26", -7, 'mdy')).toBe("12/29'25")
    expect(shiftQifDate('10/03/2026', -14, 'mdy')).toBe('09/19/2026')
    const result = anonymizeQif(qifFile(), { seed: SEED })
    const numbers = result.text.split('\r\n').filter(l => l.startsWith('N') && !l.startsWith('NJ')).map(l => l.slice(1))
    expect(numbers).toContain('DEP')
    expect(numbers.some(n => /^EFT\d{8}$/.test(n) && n !== 'EFT88412233')).toBe(true)
    // Free text in the number field is text, not a code
    const wordy = anonymizeQif(Buffer.from(['!Type:Bank', 'D2026-10-01', 'T-5.00', 'NHands-on care', 'PGrocer', '^', ''].join('\r\n'), 'latin1'), { seed: SEED })
    expect(wordy.text).not.toContain('Hands-on')
    expect(wordy.text).toMatch(/\r\nN[A-Z][a-z]{4}-[a-z]{2} [a-z]{4}\r\n/)
    const cheques = numbers.filter(n => /^\d+$/.test(n))
    expect(cheques).toHaveLength(2)
    expect(Number(cheques[0])).toBeLessThan(Number(cheques[1]))
  })

  it('never writes a fake that contains a word from the input, even one that is in its own corpus', () => {
    // A payee that happens to be a corpus word, and an account named like a fake account name
    const input = Buffer.from(['!Type:Bank', 'D2026-10-01', 'T-5.00', 'PJade', 'L[Visa Rewards Card]', '^', 'D2026-10-02', 'T-6.00', 'PAcorn', 'LKite:Halo', '^', ''].join('\r\n'), 'latin1')
    const result = anonymizeQif(input, { seed: SEED })
    const lower = result.text.toLowerCase()
    for (const word of ['jade', 'acorn', 'kite', 'halo', 'visa rewards card']) expect(lower, word).not.toContain(word)
    expect(verifyQifOutput({ input, outputText: result.text, sensitive: result.sensitive, sensitiveTags: result.sensitiveTags, unrecognised: [] }).problems).toEqual([])
  })

  it('drops a block it has no rules for, whole, and reports it by its control line', () => {
    const input = Buffer.from(qifFile().toString('latin1') + '!Type:Memorized\r\nKP\r\nT-12.00\r\nPSecret Payee Name\r\n^\r\n', 'latin1')
    const result = anonymizeQif(input, { seed: SEED })
    expect(result.text).not.toContain('Memorized')
    expect(result.text).not.toContain('Secret')
    expect(result.unrecognised).toContainEqual({ tag: '!Type:Memorized', count: 1 })
    expect(qifShape(result.text).controls).toEqual(['!Account', '!Type:Bank'])
    expect(checkQifFile(result.output).ok).toBe(true)
  })
})

describe('the anonymised real statements', () => {
  const ANONYMIZED = path.join(FIXTURES, 'anonymized')
  const manifest = () => JSON.parse(fs.readFileSync(path.join(ANONYMIZED, 'manifest.json'), 'utf8')) as {
    statements: { file: string, format: string, rows: number }[]
  }

  it('read as their manifest says, through the readers that exist', () => {
    for (const entry of manifest().statements) {
      const data = fs.readFileSync(path.join(ANONYMIZED, entry.file))
      if (entry.format.startsWith('exchange-ofx')) {
        const doc = readOfx(data, { formatId: entry.format })
        expect(doc.statements, entry.file).toHaveLength(1)
        expect(doc.statements[0].transactions, entry.file).toHaveLength(entry.rows)
        expect(doc.institution?.name ?? 'Example Bank', entry.file).toBe('Example Bank')
      } else if (entry.format.startsWith('exchange-qif')) {
        const shape = qifShape(new TextDecoder('windows-1252').decode(data))
        expect(shape.blocks.reduce((n, b) => n + b.length, 0), entry.file).toBe(entry.rows)
      } else {
        expect(csvShape(data).rows, entry.file).toBe(entry.rows)
      }
    }
  })

  it('are all named in the manifest, and the manifest names nothing that is not there', () => {
    const files = fs.readdirSync(ANONYMIZED).filter(f => f !== 'manifest.json').sort()
    expect(files).toEqual(manifest().statements.map(s => s.file).sort())
  })

  it('carry nothing identifying-shaped and nothing from the seeded household either', () => {
    for (const entry of manifest().statements) {
      const text = fs.readFileSync(path.join(ANONYMIZED, entry.file)).toString('latin1')
      expect(patternMatches(text), entry.file).toEqual([])
      // The seed's own payees would mean a real statement leaked the household's names, which cannot happen
      expect(text).not.toMatch(/Maple Ridge Properties|Brightpath|Hydro Ottawa/)
    }
  })
})

describe('the command line', () => {
  it('writes the fixture and a report with counts and no values, and never records the seed or the shift', async () => {
    const dir = tempDir()
    const input = path.join(dir, 'real.qfx')
    fs.writeFileSync(input, realFile())
    const output = path.join(dir, 'out', 'fixture.qfx')
    const report = path.join(dir, 'report.json')
    const lines: string[] = []
    const code = await main([input, output, '--seed-file', path.join(dir, '.anon-seed'), '--report', report, '--quiet'],
      { log: l => lines.push(l), error: l => lines.push(l) })

    expect(code).toBe(0)
    expect(fs.existsSync(output)).toBe(true)
    const written = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(written.input).toMatchObject({ format: 'exchange-ofx.qfx', records: 4 })
    expect(written.verification).toMatchObject({ substringMatches: 0, patternMatches: 0, parsed: true, structureMatched: true })
    expect(written.dateShiftDays).toBe('(not recorded)')
    expect(written.seed).toBe('(not recorded)')
    expect(fs.readFileSync(report, 'utf8')).not.toContain('jane')
    // The seed file was created, and the same seed gives the same fixture again
    expect(fs.readFileSync(path.join(dir, '.anon-seed'))).toHaveLength(32)
    const first = fs.readFileSync(output)
    await main([input, output, '--seed-file', path.join(dir, '.anon-seed'), '--quiet'], { log: () => {}, error: () => {} })
    expect(fs.readFileSync(output).equals(first)).toBe(true)
  })

  it('refuses real amounts under tests/, and explains itself for anything else it cannot do', async () => {
    const dir = tempDir()
    const input = path.join(dir, 'real.ofx')
    fs.writeFileSync(input, realFile())
    const errors: string[] = []
    const io = { log: () => {}, error: (l: string) => errors.push(l) }
    expect(await main([input, path.resolve('tests/fixtures/exchange/ofx/never.ofx'), '--keep-amounts'], io)).toBe(1)
    expect(errors.join('\n')).toMatch(/Refusing to write a file with real amounts under tests/)
    expect(fs.existsSync(path.resolve('tests/fixtures/exchange/ofx/never.ofx'))).toBe(false)
    expect(await main(['--nonsense'], io)).toBe(2)
    expect(() => parseArgs(['a', 'b', 'c'])).toThrow(/nothing more/)
  })

  it('checks every committed fixture, which is how a hand-added one is caught on every test run', () => {
    for (const file of fixtureFiles()) {
      const result = checkFile(fs.readFileSync(file), `exchange-ofx.${path.extname(file).slice(1)}`)
      expect(result.problems.join(' | '), path.basename(file)).toBe('')
    }
    const lines: string[] = []
    expect(check(FIXTURES, { log: l => lines.push(l), error: l => lines.push(l) })).toBe(0)
    const all = fs.readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(ofx|qfx|qbo|csv|qif)$/i.test(entry.name)).length
    expect(lines.filter(l => l.startsWith('ok')).length).toBe(all)
  })
})
