// Writing OFX, QFX and QBO (docs/export-design.md, "OFX" and "QFX and QBO"): one account's statement in OFX 1.0.2 SGML,
// as banks send them; stable FITIDs; OFX's lengths kept; the Intuit id in QFX and QBO, only ever the account's own; what
// stops a file, and what is warned about; and the round trip through this plugin's own reader.
import { describe, expect, it } from 'vitest'
import { resolveOptions, type ExportAccount, type ExportData, type ExportOptions, type ExportTransaction } from '@tessera/export-api'
import { OFX_EXPORT, OFX_LIMITS, QBO_EXPORT, QFX_EXPORT, ofxExport } from '../../../plugins/format-ofx/src/privileged/export'
import { declaredEncoding, parseOfx } from '../../../plugins/format-ofx/src/privileged/sgml'
import { statementsOf } from '../../../plugins/format-ofx/src/privileged/statements'
import { decode } from '../../../plugins/import/src/privileged/files'

const LONG = 'INTERNATIONAL BUSINESS MACHINES CORPORATION CANADA'      // 50 characters

const tx = (over: Partial<ExportTransaction> & Pick<ExportTransaction, 'date' | 'amount'>): ExportTransaction =>
  ({ id: `01JBX8Z6Q${over.date.replace(/-/g, '')}${over.amount.replace(/\D/g, '')}`.slice(0, 26), status: 'uncleared', voided: false, balance: '0.00', ...over })

function chequing(over: Partial<ExportAccount> = {}): ExportAccount {
  return {
    id: 'chq', name: 'Chequing', type: 'chequing', currency: 'CAD', digits: 2, closed: false, location: [],
    institution: 'Maple Trust & Co', accountNumber: '12-345678', bankId: '004',
    opening: { date: '2026-10-01', balance: '5000.00' }, closing: { date: '2026-10-31', balance: '6016.88' },
    transactions: [
      tx({ date: '2026-10-03', amount: '-84.12', payee: 'Hydro One', number: '101', memo: 'Sept <bill>', status: 'cleared' }),
      tx({ date: '2026-10-05', amount: '2500.00', payee: 'Employer Inc', category: ['Income', 'Salary'], status: 'electronic', bankId: 'MT20261005-0417' }),
      tx({ date: '2026-10-07', amount: '-500.00', payee: 'Transfer', transfer: { account: 'Savings', direction: 'to' } }),
      tx({ date: '2026-10-08', amount: '-75.00', payee: 'Cancelled Order', voided: true }),
      tx({ date: '2026-10-09', amount: '-60.00', payee: 'ATM withdrawal', number: 'ATM', status: 'electronic' }),
      tx({ date: '2026-10-22', amount: '-150.00', payee: LONG, memo: 'Laptop' }),
      tx({ date: '2026-10-27', amount: '310.00', payee: 'Łódź Café', category: ['Other income'] })
    ],
    ...over
  }
}
const visa = (over: Partial<ExportAccount> = {}): ExportAccount => ({
  id: 'visa', name: 'Visa', type: 'creditCard', currency: 'CAD', digits: 2, closed: false, location: [], accountNumber: '4500 1234 1234 1234',
  opening: { date: '2026-10-01', balance: '-250.00' }, closing: { date: '2026-10-31', balance: '-395.67' },
  transactions: [tx({ date: '2026-10-02', amount: '-145.67', payee: 'Costco', status: 'cleared' })],
  ...over
})

const data = (account: ExportAccount = chequing()): ExportData => ({
  ledger: { name: 'Home' }, exportedAt: '2026-11-06T12:00:00.000Z', range: { from: '2026-10-01', to: '2026-10-31' }, accounts: [account], categories: []
})
const options = (over: ExportOptions = {}) => resolveOptions(OFX_EXPORT.options, over)
const write = async (d: ExportData, over: ExportOptions = {}, formatId = OFX_EXPORT.id) => ofxExport.write(d, options(over), formatId)
const lines = async (d: ExportData, over: ExportOptions = {}, formatId = OFX_EXPORT.id) =>
  decode((await write(d, over, formatId)).bytes, 'windows-1252').split('\r\n')
const check = async (d: ExportData, over: ExportOptions = {}, formatId = OFX_EXPORT.id) => ofxExport.check(d, options(over), formatId)

/** The file as this plugin's reader reads it, as the import does. */
function readBack(bytes: Uint8Array) {
  const text = decode(bytes, declaredEncoding(new TextDecoder('latin1').decode(bytes.subarray(0, 2048))))
  return statementsOf(parseOfx(text)!.root)
}

describe('writing OFX', () => {
  it('writes a bank statement as banks send them: the header, the sign-on, the account, the lines and the balance', async () => {
    const file = await lines(data())
    expect(file.slice(0, 10)).toEqual([
      'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE',
      'OLDFILEUID:NONE', 'NEWFILEUID:NONE', ''
    ])
    expect(file).toContain('<DTSERVER>20261106120000')
    expect(file).toContain('<ORG>Maple Trust &amp; Co')
    expect(file.join('\n')).toContain('<BANKACCTFROM>\n<BANKID>004\n<ACCTID>12345678\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>')
    expect(file.join('\n')).toContain('<BANKTRANLIST>\n<DTSTART>20261001\n<DTEND>20261031')
    expect(file.join('\n')).toContain('<LEDGERBAL>\n<BALAMT>6016.88\n<DTASOF>20261031\n</LEDGERBAL>')
    // Each line: its kind, date, amount, id, cheque number, payee and memo, escaped
    const transactions = file.join('\n').split('<STMTTRN>\n').slice(1).map(t => t.split('\n</STMTTRN>')[0].split('\n'))
    expect(transactions).toEqual([
      ['<TRNTYPE>CHECK', '<DTPOSTED>20261003', '<TRNAMT>-84.12', expect.stringMatching(/^<FITID>TESSERA\./), '<CHECKNUM>101', '<NAME>Hydro One', '<MEMO>Sept &lt;bill&gt;'],
      ['<TRNTYPE>CREDIT', '<DTPOSTED>20261005', '<TRNAMT>2500.00', '<FITID>MT20261005-0417', '<NAME>Employer Inc'],
      ['<TRNTYPE>XFER', '<DTPOSTED>20261007', '<TRNAMT>-500.00', expect.stringMatching(/^<FITID>TESSERA\./), '<NAME>Transfer'],
      ['<TRNTYPE>ATM', '<DTPOSTED>20261009', '<TRNAMT>-60.00', expect.stringMatching(/^<FITID>TESSERA\./), '<NAME>ATM withdrawal'],
      ['<TRNTYPE>DEBIT', '<DTPOSTED>20261022', '<TRNAMT>-150.00', expect.stringMatching(/^<FITID>TESSERA\./), '<NAME>INTERNATIONAL BUSINESS MACHINES', `<MEMO>${LONG} · Laptop`],
      ['<TRNTYPE>CREDIT', '<DTPOSTED>20261027', '<TRNAMT>310.00', expect.stringMatching(/^<FITID>TESSERA\./), '<NAME>Lódz Café']
    ])
    expect(file).not.toContain('<INTU.BID>')
  })

  it('gives each line the same id every time: the bank’s when it had one, else Tessera’s own', async () => {
    const ids = async () => (await lines(data())).filter(l => l.startsWith('<FITID>'))
    expect(await ids()).toEqual(await ids())
    expect((await ids()).filter(id => id.startsWith('<FITID>TESSERA.'))).toHaveLength(5)
  })

  it('writes a card statement without a bank number', async () => {
    const file = (await lines(data(visa()))).join('\n')
    expect(file).toContain('<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>')
    expect(file).toContain('<CCACCTFROM>\n<ACCTID>4500123412341234\n</CCACCTFROM>')
    expect(file).not.toContain('<BANKID>')
    expect(file).toContain('<BALAMT>-395.67')
    expect((await check(data(visa()))).problems).toEqual([])
  })

  it('says what it changes or leaves out', async () => {
    expect((await check(data())).warnings).toEqual([
      '1 payee longer than 32 characters is cut, as OFX has it; the whole payee is kept at the start of the memo.',
      '1 voided transaction is left out: a bank’s statement has none.',
      '2 characters Windows can’t hold are written as the nearest letter, or “?”.'
    ])
    expect(OFX_LIMITS.NAME).toBe(32)
  })

  it('leaves out uncleared transactions, and puts categories in the memo, when asked', async () => {
    const cleared = await check(data(), { clearedOnly: true })
    expect(cleared.transactions).toBe(3)
    expect(cleared.warnings).toContain('3 uncleared transactions are left out, as asked.')
    const file = await lines(data(), { categoryInMemo: true })
    expect(file).toContain('<MEMO>Income : Salary')
    expect(file).toContain('<MEMO>Other income')
  })

  it('refuses what would make a wrong statement: no account number, or a masked one; no bank number for a bank account', async () => {
    const problems = async (over: Partial<ExportAccount>) => (await check(data(chequing(over)))).problems
    expect(await problems({ accountNumber: undefined })).toEqual(['Enter “Chequing”’s account number: OFX says which account a statement is for by it.'])
    expect(await problems({ accountNumber: '•••• 5678' })).toEqual(['“Chequing”’s account number is masked (•••• 5678): enter it whole, as the bank writes it.'])
    expect(await problems({ accountNumber: '1'.repeat(23) })).toEqual(['“Chequing”’s account number is longer than OFX allows (22 characters without spaces and dashes).'])
    expect(await problems({ bankId: undefined })).toEqual(['Enter “Chequing”’s bank number: a bank statement says which bank it is from by it. It is in the bank’s own OFX files, after <BANKID>.'])
    expect(await problems({ bankId: '004-1' })).toEqual(['“Chequing”’s bank number can be letters and digits only, 9 at most.'])
    expect(await problems({ currency: 'BHD', digits: 3 })).toEqual(['BHD amounts have 3 decimals, which OFX statements aren’t known to carry.'])
    expect(await problems({ transactions: [] })).toEqual(['There are no transactions to export in “Chequing” for these dates.'])
  })
})

describe('a short account number', () => {
  it('is written, with a warning that it may be only the last digits of the real one', async () => {
    const card = data(visa({ accountNumber: '3456' }))
    expect((await check(card)).problems).toEqual([])
    expect((await lines(card)).join('\n')).toContain('<ACCTID>3456')
    expect((await check(card, {}, QFX_EXPORT.id)).warnings[0]).toBe('“Visa”’s account number is only 4 characters (3456), perhaps the last digits of a '
      + 'longer one. Quicken finds the account by its whole number: if this isn’t all of it, enter the number as the bank writes it.')
    expect((await check(card)).warnings[0]).toMatch(/^“Visa”’s account number is only 4 characters .* The program reading it finds/)
    // Five characters or more, or a number that is a problem already, isn't warned about
    expect((await check(data(visa({ accountNumber: '12345' })))).warnings.join(' ')).not.toMatch(/only \d+ characters/)
    expect((await check(data(visa({ accountNumber: 'XX56' })))).warnings.join(' ')).not.toMatch(/only \d+ characters/)
  })
})

describe('writing QFX and QBO', () => {
  it('writes the account’s own Intuit id in the sign-on, and nothing else differs', async () => {
    for (const format of [QFX_EXPORT, QBO_EXPORT]) {
      const file = await lines(data(chequing({ intuitBankId: '12345' })), {}, format.id)
      expect(file).toContain('<INTU.BID>12345')
      expect(file.filter(l => l !== '<INTU.BID>12345')).toEqual(await lines(data(chequing({ intuitBankId: '12345' }))))
    }
  })

  it('without an Intuit id, writes the file and warns that the program may refuse it', async () => {
    expect((await lines(data(), {}, QFX_EXPORT.id))).not.toContain('<INTU.BID>')
    expect((await check(data(), {}, QBO_EXPORT.id)).warnings[0]).toBe('“Chequing” has no Intuit bank id, so QuickBooks may refuse this file. '
      + 'Add the bank’s id to the account (it is in a .qfx or .qbo file from the bank, after <INTU.BID>), or export OFX instead.')
    expect((await check(data(), {}, QFX_EXPORT.id)).warnings[0]).toMatch(/so Quicken may refuse this file/)
    expect((await check(data(), {}, QFX_EXPORT.id)).problems).toEqual([])
  })

  it('declares what it writes of the account, and for which accounts', () => {
    expect(OFX_EXPORT.accountFields).toEqual([
      { field: 'accountNumber', need: 'required' }, { field: 'bankId', need: 'required', accountTypes: ['chequing', 'savings', 'lineOfCredit'] }
    ])
    expect(QFX_EXPORT.accountFields?.at(-1)).toEqual({ field: 'intuitBankId', need: 'recommended' })
    expect([OFX_EXPORT, QFX_EXPORT, QBO_EXPORT].map(f => [f.extension, f.accounts, f.accountTypes])).toEqual([
      ['ofx', 'one', ['chequing', 'savings', 'lineOfCredit', 'creditCard']], ['qfx', 'one', ['chequing', 'savings', 'lineOfCredit', 'creditCard']],
      ['qbo', 'one', ['chequing', 'savings', 'lineOfCredit', 'creditCard']]
    ])
  })
})

describe('reading an exported OFX back', () => {
  it('reads the account by its bank and number, the period, the balance and every line, trusting its ids', async () => {
    const { statements, warnings } = readBack((await write(data(chequing({ intuitBankId: '12345' })), {}, QBO_EXPORT.id)).bytes)
    expect(warnings).toEqual([])
    const [s] = statements
    expect(s.account).toMatchObject({ key: 'ofx:bank:004:12345678', keyStrength: 'strong', type: 'chequing', institution: 'Maple Trust & Co', bankId: '004', intuitBankId: '12345' })
    expect(s).not.toHaveProperty('stableIds')
    expect(s.period).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(s.balance).toEqual({ amount: '6016.88', asOf: '2026-10-31' })
    const written = chequing().transactions.filter(t => !t.voided)
    expect(s.lines.map(l => [l.date, l.amount])).toEqual(written.map(t => [t.date, t.amount]))
    expect(s.lines.map(l => l.kind)).toEqual(['cheque', 'credit', 'transfer', 'atm', 'debit', 'credit'])
    expect(s.lines[1].externalId).toBe('MT20261005-0417')
    // A cut payee comes back cut, its whole name at the start of the memo
    expect(s.lines[4]).toMatchObject({ payee: 'INTERNATIONAL BUSINESS MACHINES', memo: `${LONG} · Laptop` })
  })

  it('reads a card statement back as a card, by its number', async () => {
    const [s] = readBack((await write(data(visa()))).bytes).statements
    expect(s.account).toMatchObject({ key: 'ofx:card:4500123412341234', type: 'creditCard' })
    expect(s.balance).toEqual({ amount: '-395.67', asOf: '2026-10-31' })
  })
})
