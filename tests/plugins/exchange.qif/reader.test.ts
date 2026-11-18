// @vitest-environment node
// The QIF reader: both dialects, both forms, every date and amount shape, splits, transfers, the opening-balance
// convention, the category list, and what it counts rather than drops — over hand-built snippets, the seeded
// fixtures, and the anonymised Money exports.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { QIF_FORMAT, readQif, sniffQif } from '../../../plugins/exchange.qif/src/privileged/index'
import { categoryPath, dialectOf, truncatedAt } from '../../../plugins/exchange.qif/src/privileged/reader'
import { decodeQif, splitQif } from '../../../plugins/exchange.qif/src/privileged/lines'
import {
  accountTypeOf, clearedOf, expandYear, inferDateOrder, parseQifAmount, parseQifDate
} from '../../../plugins/exchange.qif/src/privileged/values'

const FIXTURES = path.resolve(__dirname, '../../fixtures/exchange')
const bytes = (text: string) => Buffer.from(text.replace(/\n/g, '\r\n'), 'latin1')
const read = (text: string, options: Partial<Parameters<typeof readQif>[1]> = {}) =>
  readQif(bytes(text), { formatId: QIF_FORMAT, ...options })

const BANK = `!Type:Bank
D10/3'26
T-142.00
U-142.00
C*
N1042
PHydro Ottawa
MNovember
LUtilities:Electricity
^
D10/5'26
T-4.50
PThe Daily Grind
LFood:Dining out/Work
^
D10/10'26
T-500.00
PTransfer to savings
L[Savings]
^
D10/15'26
T2,140.00
CX
PAcme Widgets
LSalary
A12 Rideau Street
AOttawa ON
^
D10/20'26
T-1,250.00
N1043
PRideau Property Mgmt
SHousing:Rent
EOctober rent
$-1,200.00
SHousing:Parking
$-50.00
^
`

describe('values', () => {
  it('reads amounts with either separator, grouping, parentheses and a trailing minus', () => {
    expect(parseQifAmount('-1,234.56')).toEqual({ ok: true, minor: -123456 })
    expect(parseQifAmount('1.234,56')).toEqual({ ok: true, minor: 123456 })
    expect(parseQifAmount('1,234')).toEqual({ ok: true, minor: 123400 })
    expect(parseQifAmount('(42.00)')).toEqual({ ok: true, minor: -4200 })
    expect(parseQifAmount('42.00-')).toEqual({ ok: true, minor: -4200 })
    expect(parseQifAmount('0.07')).toEqual({ ok: true, minor: 7 })
    expect(parseQifAmount('12')).toEqual({ ok: true, minor: 1200 })
    expect(parseQifAmount('abc')).toEqual({ ok: false })
    expect(parseQifAmount(undefined)).toEqual({ ok: false })
  })

  it('reads every date shape, with Quicken’s year rules', () => {
    expect(parseQifDate("10/3'26", 'mdy')).toBe('2026-10-03')
    expect(parseQifDate("1/ 5'26", 'mdy')).toBe('2026-01-05')
    expect(parseQifDate('10/03/2026', 'mdy')).toBe('2026-10-03')
    expect(parseQifDate('03/10/2026', 'dmy')).toBe('2026-10-03')
    expect(parseQifDate('2026-10-03', 'mdy')).toBe('2026-10-03')
    expect(parseQifDate('2026/10/03', 'dmy')).toBe('2026-10-03')
    expect(parseQifDate('3-Oct-26', 'mdy')).toBe('2026-10-03')
    expect(parseQifDate('10/3/49', 'mdy')).toBe('2049-10-03')
    expect(parseQifDate('10/3/50', 'mdy')).toBe('1950-10-03')
    expect(parseQifDate('2/30/2026', 'mdy')).toBeUndefined()
    expect(expandYear('26', true)).toBe(2026)
    expect(expandYear('99', false)).toBe(1999)
  })

  it('infers the date order from a day above twelve, either side', () => {
    expect(inferDateOrder(["5/3'26", "13/5'26"])).toBe('dmy')
    expect(inferDateOrder(["5/3'26", "5/13'26"])).toBe('mdy')
    expect(inferDateOrder(["5/3'26", '2026-10-03'])).toBeUndefined()
  })

  it('maps the type words and cleared flags', () => {
    expect(accountTypeOf('Bank')).toBe('chequing')
    expect(accountTypeOf('CCard')).toBe('creditCard')
    expect(accountTypeOf('Oth L')).toBe('otherLiability')
    expect(accountTypeOf('Nonsense')).toBeUndefined()
    expect(clearedOf('*')).toBe('cleared')
    expect(clearedOf('X')).toBe('reconciled')
    expect(clearedOf('')).toBeUndefined()
  })

  it('splits lines into blocks and records, keeping a record that forgot its caret', () => {
    const warnings: { code: string }[] = []
    const blocks = splitQif('!Type:Bank\r\nD1/1/26\r\nT1.00\r\n^\r\nD1/2/26\r\nT2.00\r\n!Type:Cat\r\nNFood\r\n^\r\n', warnings as never)
    expect(blocks.map(b => b.control)).toEqual(['!Type:Bank', '!Type:Cat'])
    expect(blocks[0].records).toHaveLength(2)
    expect(warnings[0].code).toBe('record.malformed')
    expect(decodeQif(Buffer.from('PCaf\xe9', 'latin1')).text).toBe('PCafé')
  })
})

describe('a bare statement', () => {
  it('reads the rows, with payee, memo, number, category, transfer, cleared state and splits', async () => {
    const document = await read(BANK)
    expect(document.statements).toHaveLength(1)
    const [statement] = document.statements
    expect(statement.account).toMatchObject({ type: 'chequing', rawType: 'Bank' })
    expect(statement.transactions).toHaveLength(5)
    expect(statement.transactions[0]).toMatchObject({
      date: '2026-10-03', amount: -14200, payee: 'Hydro Ottawa', memo: 'November', number: '1042',
      category: 'Utilities : Electricity', cleared: 'cleared'
    })
    // A class after the slash has no home and is dropped from the path
    expect(statement.transactions[1].category).toBe('Food : Dining out')
    expect(statement.transactions[2]).toMatchObject({ transferAccount: 'Savings' })
    expect(statement.transactions[2].category).toBeUndefined()
    expect(statement.transactions[3]).toMatchObject({ amount: 214000, cleared: 'reconciled', category: 'Salary' })
    expect(statement.transactions[4].splits).toEqual([
      { amount: -120000, category: 'Housing : Rent', memo: 'October rent' },
      { amount: -5000, category: 'Housing : Parking' }
    ])
    expect(statement.period).toEqual({ from: '2026-10-03', to: '2026-10-20' })
    expect(document.unsupported).toContainEqual(expect.objectContaining({ kind: 'address', count: 2 }))
    expect(document.formatId).toBe(QIF_FORMAT)
  })

  it('turns the opening-balance record into the closing balance, not a transaction', async () => {
    const document = await read(`!Account\nNChequing\nTBank\n^\n!Type:Bank\nD9/30'26\nT4000.00\nPOpening Balance\nL[Chequing]\n^\nD10/3'26\nT-142.00\nPHydro\n^\n`)
    const [statement] = document.statements
    expect(statement.transactions).toHaveLength(1)
    expect(statement.balances?.ledger).toEqual({ amount: 400000 - 14200, asOf: '2026-10-03' })
    expect(statement.account.name).toBe('Chequing')
  })

  it('reads a file with no !Type line at all as a bank account', async () => {
    const document = await read(`D10/3'26\nT-1.00\nPSomething\n^\n`)
    expect(document.statements[0].transactions).toHaveLength(1)
  })

  it('skips a row with no readable date or amount, saying so', async () => {
    const document = await read(`!Type:Bank\nDnever\nT1.00\n^\nD10/3'26\nTlots\n^\nD10/4'26\nT2.00\n^\n`)
    expect(document.statements[0].transactions).toHaveLength(1)
    expect(document.warnings.map(w => w.code)).toEqual(['date.unparsable', 'amount.unparsable'])
  })

  it('refuses a file with no records, and one with no transactions', async () => {
    await expect(read('')).rejects.toMatchObject({ code: 'UNREADABLE' })
    await expect(read('!Type:Cat\nNFood\n^\n')).rejects.toMatchObject({ code: 'EMPTY' })
  })
})

describe('the date order', () => {
  it('settles it from the file when a day above twelve appears', async () => {
    const request = vi.fn()
    const document = await read(`!Type:Bank\nD13/5/2026\nT1.00\n^\nD5/6/2026\nT1.00\n^\n`, { request })
    expect(document.statements[0].transactions.map(t => t.date)).toEqual(['2026-05-13', '2026-06-05'])
    expect(request).not.toHaveBeenCalled()
  })

  it('asks, showing real dates from the file both ways, when nothing settles it', async () => {
    const request = vi.fn(async () => 'dmy' as const)
    const document = await read(`!Type:Bank\nD5/3'26\nT1.00\n^\nD6/4'26\nT1.00\n^\n`, { request })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'choice', id: 'exchange-qif.dateOrder',
      options: [
        expect.objectContaining({ value: 'mdy', detail: expect.stringContaining('May 3, 2026') }),
        expect.objectContaining({ value: 'dmy', detail: expect.stringContaining('March 5, 2026') })
      ]
    }))
    expect(document.statements[0].transactions[0].date).toBe('2026-03-05')
  })

  it('uses an answer the caller settled, and asks nothing for ISO dates', async () => {
    const request = vi.fn()
    const settled = await read(`!Type:Bank\nD5/3'26\nT1.00\n^\n`, { dateOrder: 'dmy', request })
    expect(settled.statements[0].transactions[0].date).toBe('2026-03-05')
    await read(`!Type:Bank\nD2026-05-03\nT1.00\n^\n`, { request })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('the whole-book form', () => {
  const BOOK = `!Option:AutoSwitch
!Account
NChequing
TBank
^
!Account
NVisa
TCCard
^
!Clear:AutoSwitch
!Type:Cat
NFood:Groceries
E
^
NSalary
I
^
!Account
NChequing
TBank
^
!Type:Bank
D10/3'26
T-50.00
PGrocer
LFood:Groceries
^
D10/4'26
T-200.00
PCard payment
L[Visa]
^
!Account
NVisa
TCCard
^
!Type:CCard
D10/4'26
T200.00
PPayment
L[Chequing]
^
!Type:Memorized
KP
T-12.00
PNetflix
^
!Type:Invst
D10/5'26
NBuy
YShares
^
`

  it('reads one statement per account, in file order, with the category list', async () => {
    const document = await read(BOOK)
    expect(document.statements.map(s => s.account.name)).toEqual(['Chequing', 'Visa'])
    expect(document.statements[0].account.type).toBe('chequing')
    expect(document.statements[1].account.type).toBe('creditCard')
    expect(document.statements[0].transactions).toHaveLength(2)
    expect(document.statements[1].transactions).toHaveLength(1)
    expect(document.statements[1].transactions[0].transferAccount).toBe('Chequing')
    expect(document.categories).toEqual([
      { path: 'Food : Groceries', kind: 'expense' },
      { path: 'Salary', kind: 'income' }
    ])
  })

  it('counts memorised and investment records rather than dropping them quietly', async () => {
    const document = await read(BOOK)
    expect(document.unsupported).toContainEqual(expect.objectContaining({ kind: 'memorised', count: 1 }))
    expect(document.unsupported).toContainEqual(expect.objectContaining({ kind: 'investment', count: 1 }))
  })

  it('leaves out an account the list named that has no transactions', async () => {
    const document = await read(`!Account\nNEmpty\nTBank\n^\n!Account\nNUsed\nTBank\n^\n!Type:Bank\nD10/3'26\nT1.00\n^\n`)
    expect(document.statements.map(s => s.account.name)).toEqual(['Used'])
  })
})

describe('the dialect', () => {
  it('reports truncated payees, and only then tells the matcher to compare by prefix', () => {
    const cut = [{ account: {}, transactions: [{ date: '2026-10-03', amount: -1, payee: 'Canadian Tire S' }, { date: '2026-10-04', amount: -1, payee: 'Hydro' }] }]
    expect(truncatedAt(cut)).toBe(15)
    expect(dialectOf(cut)).toMatch(/standard dialect/)
    const whole = [{ account: {}, transactions: [{ date: '2026-10-03', amount: -1, payee: 'Canadian Tire Store' }] }]
    expect(truncatedAt(whole)).toBeUndefined()
    expect(dialectOf(whole)).toBe('QIF (Microsoft dialect)')
    // Money's strict export: categories cut, payees whole
    const moneyStrict = [{ account: {}, transactions: [{ date: '2026-10-03', amount: -1, payee: 'Canadian Tire Store', category: 'Utilities & Ser : Electricity Bil' }] }]
    expect(truncatedAt(moneyStrict)).toBeUndefined()
    expect(dialectOf(moneyStrict)).toMatch(/categories cut/)
  })

  it('normalises a category path and drops its class', () => {
    expect(categoryPath('Auto:Fuel/Work')).toBe('Auto : Fuel')
    expect(categoryPath(' Food : Dining ')).toBe('Food : Dining')
  })
})

describe('sniffing', () => {
  it('recognises a control line, a bare record, and nothing else', () => {
    expect(sniffQif(bytes('!Type:Bank\nD1/1/26\n'))).toBe(1)
    expect(sniffQif(bytes('D1/1/26\nT1.00\n^\n'))).toBe(0.5)
    expect(sniffQif(bytes('OFXHEADER:100\n'))).toBe(0)
    expect(sniffQif(bytes('Date,Payee,Amount\n'))).toBe(0)
  })
})

describe('the seeded fixtures', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as {
    statements: { file: string, format: string, account: { name: string, type: string }, rows: number, closingBalance: number }[]
  }
  const fixture = (file: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, file)))

  it('reads the Microsoft-dialect file: every row, the !Account block, and the cleared marks', async () => {
    const entry = manifest.statements.find(s => s.format === 'qif-microsoft')!
    const document = await readQif(fixture(entry.file), { formatId: QIF_FORMAT })
    expect(document.statements).toHaveLength(1)
    expect(document.statements[0].account.name).toBe(entry.account.name)
    expect(document.statements[0].transactions).toHaveLength(entry.rows)
    expect(document.statements[0].transactions.some(t => t.cleared === 'cleared')).toBe(true)
    expect(document.dialect).toBe('QIF (Microsoft dialect)')
    expect(document.truncatedAt).toBeUndefined()
    expect(document.warnings).toEqual([])
  })

  it('reads the standard-dialect file: a credit card, apostrophe dates, names cut at fifteen', async () => {
    const entry = manifest.statements.find(s => s.format === 'qif-standard')!
    const document = await readQif(fixture(entry.file), { formatId: QIF_FORMAT })
    expect(document.statements[0].account.type).toBe('creditCard')
    expect(document.statements[0].transactions).toHaveLength(entry.rows)
    expect(document.statements[0].transactions.every(t => (t.payee ?? '').length <= 15)).toBe(true)
    expect(document.truncatedAt).toBe(15)
    expect(document.dialect).toMatch(/standard dialect/)
  })
})

describe('the anonymised Money exports', () => {
  const file = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'anonymized', name)))

  it('read the loose export: ISO dates, grouped amounts, splits, transfers, cleared marks, an opening balance', async () => {
    const document = await readQif(file('money-chequing-loose.qif'), { formatId: QIF_FORMAT })
    expect(document.statements).toHaveLength(1)
    const [statement] = document.statements
    // 467 records: one is the opening balance, which becomes the closing figure rather than a row
    expect(statement.transactions).toHaveLength(466)
    expect(statement.balances?.ledger?.amount).toBe(statement.transactions.reduce((n, t) => n + t.amount, 0))
    // Sixteen S/E/$ groups: eight transactions split two ways
    const split = statement.transactions.filter(t => t.splits !== undefined)
    expect(split).toHaveLength(8)
    expect(split.flatMap(t => t.splits!)).toHaveLength(16)
    for (const t of split) expect(t.splits!.reduce((n, p) => n + p.amount, 0)).toBe(t.amount)
    expect(statement.transactions.some(t => t.transferAccount !== undefined)).toBe(true)
    // The one reconciled mark in the file is on the opening-balance record, which is not a row
    expect(statement.transactions.some(t => t.cleared === 'cleared')).toBe(true)
    expect(statement.transactions.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true)
    expect(document.warnings).toEqual([])
    expect(document.dialect).toBe('QIF (Microsoft dialect)')
  })

  it('read the strict export as the same statement, seeing its categories cut and its payees whole', async () => {
    const loose = await readQif(file('money-chequing-loose.qif'), { formatId: QIF_FORMAT })
    const strict = await readQif(file('money-chequing-strict.qif'), { formatId: QIF_FORMAT })
    expect(strict.statements[0].transactions).toHaveLength(loose.statements[0].transactions.length)
    expect(strict.statements[0].transactions.map(t => t.amount)).toEqual(loose.statements[0].transactions.map(t => t.amount))
    // Payees are whole in both, so neither tells the matcher to compare by prefix. (The anonymiser's category
    // names never land on exactly fifteen characters, so the cut is not visible in this copy.)
    expect(strict.truncatedAt).toBeUndefined()
    expect(loose.truncatedAt).toBeUndefined()
  })
})
