// Writing QIF (docs/export-design.md, "QIF"): standard QIF, one account or a whole ledger, as the design defines it;
// payees cut to 32 characters and kept whole in the memo; names without QIF's syntax; each option; what is warned
// about; and the round trip: what Tessera writes, this plugin's own reader reads back, opening balances and all.
import { describe, expect, it } from 'vitest'
import { resolveOptions, type ExportAccount, type ExportData, type ExportOptions, type ExportTransaction } from '@tessera/export-api'
import { QIF_EXPORT, QIF_LIMITS, qifExport } from '../../../plugins/format-qif/src/privileged/export'
import { qifDateOrders } from '../../../plugins/format-qif/src/privileged/dates'
import { parseQif } from '../../../plugins/format-qif/src/privileged/qif'
import { collect, readStatement, samplesOf } from '../../../plugins/format-qif/src/privileged/statements'
import { decode } from '../../../plugins/import/src/privileged/files'

const LONG = 'INTERNATIONAL BUSINESS MACHINES CORPORATION CANADA'      // 50 characters

const tx = (over: Partial<ExportTransaction> & Pick<ExportTransaction, 'date' | 'amount'>): ExportTransaction =>
  ({ id: `t${over.date}${over.amount}`, status: 'uncleared', voided: false, balance: '0.00', ...over })

function chequing(over: Partial<ExportAccount> = {}): ExportAccount {
  return {
    id: 'chq', name: 'Chequing', type: 'chequing', currency: 'CAD', digits: 2, closed: false, location: [],
    opening: { date: '2026-10-01', balance: '5000.00' }, closing: { date: '2026-10-31', balance: '5440.51' },
    transactions: [
      tx({ date: '2026-10-01', amount: '-1200.00', payee: 'Landlord', category: ['Housing', 'Rent'], status: 'reconciled' }),
      tx({ date: '2026-10-03', amount: '-84.12', payee: 'Hydro One', number: '101', memo: 'Sept, 2026', status: 'cleared' }),
      tx({ date: '2026-10-05', amount: '2500.00', payee: 'Employer Inc', category: ['Income', 'Salary'], status: 'electronic' }),
      tx({ date: '2026-10-07', amount: '-500.00', payee: 'Transfer', transfer: { account: 'Savings', direction: 'to' } }),
      tx({ date: '2026-10-08', amount: '-75.00', payee: 'Cancelled Order', voided: true }),
      tx({ date: '2026-10-22', amount: '-150.00', payee: LONG, category: ['Shopping'], memo: 'Laptop' }),
      tx({ date: '2026-10-27', amount: '-31.20', payee: 'Łódź Market', memo: 'Line one\nLine two', category: ['Home/Office'] }),
      tx({ date: '2026-10-30', amount: '-55.00', payee: 'Phone Co', number: 'EFT', category: ['Bills', 'Phone'] }),
      tx({ date: '2026-10-31', amount: '-39.17', payee: LONG })
    ],
    ...over
  }
}
const savings = (over: Partial<ExportAccount> = {}): ExportAccount => ({
  id: 'sav', name: 'Savings', type: 'savings', currency: 'CAD', digits: 2, closed: false, location: ['Family'],
  opening: { date: '2026-10-01', balance: '10000.00' }, closing: { date: '2026-10-31', balance: '10500.00' },
  transactions: [tx({ date: '2026-10-07', amount: '500.00', payee: 'Transfer', transfer: { account: 'Chequing', direction: 'from' } })],
  ...over
})

const CATEGORIES: ExportData['categories'] = [
  { path: ['Bills', 'Phone'], kind: 'expense' }, { path: ['Home/Office'], kind: 'expense' },
  { path: ['Income', 'Salary'], kind: 'income' }
]
const data = (accounts: ExportAccount[] = [chequing()], categories = CATEGORIES): ExportData => ({
  ledger: { name: 'Home' }, exportedAt: '2026-11-06T12:00:00.000Z', range: { from: '2026-10-01', to: '2026-10-31' }, accounts, categories
})
const options = (over: ExportOptions = {}) => resolveOptions(QIF_EXPORT.options, over)
const write = async (d: ExportData, over: ExportOptions = {}) => qifExport.write(d, options(over), QIF_EXPORT.id)
const text = async (d: ExportData, over: ExportOptions = {}) => decode((await write(d, over)).bytes, 'auto')
const check = async (d: ExportData, over: ExportOptions = {}) => qifExport.check(d, options(over), QIF_EXPORT.id)

/** The file as this plugin's reader reads it: each account's statement, in the order the user chose, with nothing asked. */
function readBack(bytes: Uint8Array, dateOrder: 'MDY' | 'DMY' = 'MDY') {
  const collected = collect(parseQif(decode(bytes, 'auto')))
  const orders = qifDateOrders(samplesOf(collected.statements).dates, 2036)
  const statements = collected.statements.map(raw => readStatement(raw, 'export.qif', { dateOrder, decimal: '.', pivot: 2036, reversed: false }))
  return { warnings: [...collected.warnings, ...statements.flatMap(s => s.warnings)], orders, statements: statements.map(s => s.statement) }
}

describe('writing QIF', () => {
  it('writes standard QIF: the category list, the account, its opening balance, then a record per transaction', async () => {
    expect((await text(data())).split('\r\n')).toEqual([
      '!Type:Cat', 'NBills:Phone', 'E', '^', 'NHome-Office', 'E', '^', 'NIncome:Salary', 'I', '^',
      '!Account', 'NChequing', 'TBank', '^',
      '!Type:Bank',
      'D10/01/2026', 'T5000.00', 'CX', 'POpening Balance', 'L[Chequing]', '^',
      'D10/01/2026', 'T-1200.00', 'CX', 'PLandlord', 'LHousing:Rent', '^',
      'D10/03/2026', 'T-84.12', 'C*', 'N101', 'PHydro One', 'MSept, 2026', '^',
      'D10/05/2026', 'T2500.00', 'C*', 'PEmployer Inc', 'LIncome:Salary', '^',
      'D10/07/2026', 'T-500.00', 'PTransfer', 'L[Savings]', '^',
      'D10/22/2026', 'T-150.00', 'PINTERNATIONAL BUSINESS MACHINES', `M${LONG} · Laptop`, 'LShopping', '^',
      'D10/27/2026', 'T-31.20', 'PLódz Market', 'MLine one Line two', 'LHome-Office', '^',
      'D10/30/2026', 'T-55.00', 'NEFT', 'PPhone Co', 'LBills:Phone', '^',
      'D10/31/2026', 'T-39.17', 'PINTERNATIONAL BUSINESS MACHINES', `M${LONG}`, '^',
      ''
    ])
  })

  it('writes Windows-1252 with CRLF by default, and UTF-8 when asked', async () => {
    const { bytes } = await write(data())
    expect(decode(bytes, 'windows-1252')).toContain('PLódz Market')           // ó is in windows-1252, Ł and ź aren't
    expect([...bytes].filter(b => b === 0x0a).length).toBe([...bytes].filter(b => b === 0x0d).length)
    expect(await text(data(), { encoding: 'utf-8' })).toContain('PŁódź Market')
  })

  it('cuts a payee to 32 characters, trimmed, and keeps it whole at the start of the memo', async () => {
    expect(QIF_LIMITS.payee).toBe(32)
    const payees = (await text(data())).split('\r\n').filter(l => l.startsWith('P'))
    expect(payees.every(p => p.length - 1 <= 32)).toBe(true)
    // The cut ends in a space ('…MACHINES '): it is trimmed, as a reader would trim it
    expect(payees).toContain('PINTERNATIONAL BUSINESS MACHINES')
    expect((await check(data())).warnings).toContain(
      '2 payees longer than 32 characters are cut, as standard QIF has them; the whole payee is kept at the start of the memo.')
  })

  it('keeps the first 15 characters of every category’s and account’s name, as standard QIF does', async () => {
    expect(QIF_LIMITS.name).toBe(15)
    const account = chequing({
      name: 'Maple Trust Chequing Account',
      transactions: [
        tx({ date: '2026-10-14', amount: '-200.00', payee: 'Visa', category: ['Credit Card Payments-Transfers'] }),
        tx({ date: '2026-10-15', amount: '-900.00', payee: 'Bank', category: ['Housing', 'Mortgage interest'] }),
        tx({ date: '2026-10-16', amount: '-500.00', payee: 'Transfer', transfer: { account: 'Northwind Card Services', direction: 'to' } })
      ]
    })
    const lines = (await text(data([account], [{ path: ['Housing', 'Mortgage interest'], kind: 'expense' }]))).split('\r\n')
    // Each level of a category on its own, in the list and on the line; the account in !Account, its opening balance
    // and a transfer; a cut that ends in a space is trimmed ('Northwind Card ')
    expect(lines).toContain('NHousing:Mortgage intere')
    expect(lines).toContain('NMaple Trust Che')
    expect(lines).toContain('L[Maple Trust Che]')
    expect(lines).toContain('LCredit Card Pay')
    expect(lines).toContain('LHousing:Mortgage intere')
    expect(lines).toContain('L[Northwind Card]')
    expect((await check(data([account]))).warnings[0]).toBe('Standard QIF keeps the first 15 characters of a category’s or an account’s name: '
      + '“Maple Trust Chequing Account” is “Maple Trust Che”, “Northwind Card Services” is “Northwind Card”, “Credit Card Payments-Transfers” is “Credit Card Pay”, and 1 more.')
  })

  it('refuses two accounts whose names would be one once cut, even when only a transfer names the second', async () => {
    const english = chequing({ name: 'Maple Trust chequing' })
    const french = savings({ name: 'Maple Trust Chequing - french' })
    const problem = '“Maple Trust chequing” and “Maple Trust Chequing - french” would both be “Maple Trust che” in 15 characters, '
      + 'so a program reading the file would take them for one account. Rename one so the first 15 characters differ.'
    expect((await check(data([english, french]))).problems).toEqual([problem])
    // Exported alone, English still has a transfer to the French one: a reader would put it in the wrong account
    const transfer = chequing({ name: 'Maple Trust chequing', transactions: [tx({ date: '2026-10-07', amount: '-5.00', transfer: { account: 'Maple Trust Chequing - french', direction: 'to' } })] })
    expect((await check(data([transfer]))).problems).toEqual([problem])
    // Names that differ within their first 15 characters are fine
    expect((await check(data([chequing(), savings()]))).problems).toEqual([])
  })

  it('warns when two categories would be one once cut', async () => {
    const account = chequing({
      transactions: [
        tx({ date: '2026-10-14', amount: '-900.00', category: ['Housing', 'Mortgage interest'] }),
        tx({ date: '2026-10-15', amount: '-30.00', category: ['Housing', 'Mortgage interests'] })
      ]
    })
    expect((await check(data([account], []))).warnings).toContain('“Housing:Mortgage interest” and “Housing:Mortgage interests” would be one category in 15 characters, “Housing:Mortgage intere”.')
  })

  it('lists several accounts first, as Quicken does, then each with its own transactions, both sides of a transfer', async () => {
    const one = [tx({ date: '2026-10-15', amount: '-20.00', payee: 'Something' })]
    const lines = (await text(data([chequing(), savings(), chequing({ id: 'loan', name: 'Car Loan', type: 'loan', transactions: one }),
      chequing({ id: 'rrsp', name: 'RRSP', type: 'retirement', transactions: one }), chequing({ id: 'wallet', name: 'Wallet', type: 'cash', transactions: one })]))).split('\r\n')
    const autoSwitch = lines.slice(lines.indexOf('!Option:AutoSwitch'), lines.indexOf('!Clear:AutoSwitch') + 1)
    expect(autoSwitch).toEqual([
      '!Option:AutoSwitch',
      '!Account', 'NChequing', 'TBank', '^', '!Account', 'NSavings', 'TBank', '^', '!Account', 'NCar Loan', 'TOth L', '^',
      '!Account', 'NRRSP', 'TOth A', '^', '!Account', 'NWallet', 'TCash', '^',
      '!Clear:AutoSwitch'
    ])
    expect(lines.filter(l => l.startsWith('!Type:'))).toEqual(['!Type:Cat', '!Type:Bank', '!Type:Bank', '!Type:Oth L', '!Type:Oth A', '!Type:Cash'])
    // Chequing's opening balance, its transfer to Savings; Savings' opening balance, its transfer from Chequing
    expect(lines.filter(l => l === 'L[Savings]' || l === 'L[Chequing]')).toEqual(['L[Chequing]', 'L[Savings]', 'L[Savings]', 'L[Chequing]'])
  })

  it('leaves voided transactions out, leaves the opening balance and category list out when asked, and writes dates day first', async () => {
    const lines = (await text(data(), { opening: false, categories: false, dates: 'dmy' })).split('\r\n')
    expect(lines.slice(0, 6)).toEqual(['!Account', 'NChequing', 'TBank', '^', '!Type:Bank', 'D01/10/2026'])
    expect(lines).not.toContain('POpening Balance')
    expect(lines).not.toContain('PCancelled Order')
    expect(lines).toContain('D22/10/2026')
  })

  it('says what it changes or leaves out, and that a file of days 12 or less needs its date order told', async () => {
    const two = data([chequing(), savings({ currency: 'USD' })])
    expect((await check(two)).warnings).toEqual([
      '2 payees longer than 32 characters are cut, as standard QIF has them; the whole payee is kept at the start of the memo.',
      'QIF uses “:”, “/”, “[” and “]” between names, so they are written as “-” in “Home/Office”.',
      '1 voided transaction is left out.',
      'QIF can’t say which currency an account is in, and these are in CAD and USD: “Chequing” (CAD), “Savings” (USD).',
      '2 characters Windows can’t hold are written as the nearest letter, or “?”.'
    ])
    const early = data([chequing({ transactions: chequing().transactions.filter(t => t.date <= '2026-10-08') })])
    expect((await check(early)).warnings).toContain('Every day in this file is 12 or less, so a program reading it can’t tell the order of its dates: tell it they are month first.')
    expect((await check(early, { dates: 'dmy' })).warnings.at(-1)).toMatch(/tell it they are day first\.$/)
  })

  it('counts what it writes, and leaves out an account with nothing to write; nothing at all is a problem', async () => {
    expect(await check(data())).toMatchObject({ transactions: 8, problems: [] })
    expect((await check(data())).accountsLeftOut).toBeUndefined()
    // Savings has only a voided line in the range: it isn't in the file, and the voided line is counted as left out
    const quiet = data([chequing(), savings({ transactions: [tx({ date: '2026-10-09', amount: '5.00', voided: true })] })])
    expect(await check(quiet)).toMatchObject({ transactions: 8, accountsLeftOut: ['sav'] })
    expect((await check(quiet)).warnings).toContain('2 voided transactions are left out.')
    const lines = (await text(quiet)).split('\r\n')
    expect(lines).not.toContain('NSavings')
    expect(lines).not.toContain('!Option:AutoSwitch')              // one account in the file: no account list
    // Nothing to write, with opening balances or without
    const empty = data([chequing({ transactions: [] })])
    expect(await check(empty)).toMatchObject({ transactions: 0, accountsLeftOut: ['chq'], problems: ['There are no transactions to export in “Chequing” for these dates.'] })
    expect((await check(empty, { opening: false })).problems).toEqual(['There are no transactions to export in “Chequing” for these dates.'])
  })
})

describe('reading an exported QIF back', () => {
  it('reads each account with its type, opening balance and lines, nothing asked and nothing warned about', async () => {
    const { warnings, orders, statements } = readBack((await write(data([chequing(), savings()]))).bytes)
    expect(warnings).toEqual([])
    expect(orders).toEqual(['MDY'])                                  // days past 12 tell the order: QIF Options won't ask
    expect(statements.map(s => [s.account.key, s.account.type, s.balance])).toEqual([
      ['qif:account:chequing', 'chequing', { amount: '5440.51', asOf: '2026-10-31' }],
      ['qif:account:savings', 'savings', { amount: '10500.00', asOf: '2026-10-07' }]
    ])
    const written = chequing().transactions.filter(t => !t.voided)
    // Cheque numbers come back; a code (EFT, ATM, DEP) comes back as the kind of line it says, not as a number
    expect(statements[0].lines.map(l => [l.date, l.amount, l.number])).toEqual(written.map(t => [t.date, t.amount, /^\d+$/.test(t.number ?? '') ? t.number : undefined]))
    expect(statements[0].lines.map(l => l.category)).toEqual(['Housing:Rent', undefined, 'Income:Salary', undefined, 'Shopping', 'Home-Office', 'Bills:Phone', undefined])
    expect(statements[0].lines.map(l => l.kind)).toEqual([undefined, 'cheque', undefined, 'transfer', undefined, undefined, 'transfer', undefined])
  })

  it('reads a cut payee back cut, with the whole of it at the start of the memo: it won’t match the original by name', async () => {
    const { statements } = readBack((await write(data())).bytes)
    const long = statements[0].lines.filter(l => l.amount === '-150.00' || l.amount === '-39.17')
    expect(long.map(l => [l.payee, l.memo])).toEqual([
      ['INTERNATIONAL BUSINESS MACHINES', `${LONG} · Laptop`],
      ['INTERNATIONAL BUSINESS MACHINES', LONG]
    ])
    expect(long[0].payee).not.toBe(LONG)
  })

  it('reads dates day first, and UTF-8, as written', async () => {
    const dmy = readBack((await write(data(), { dates: 'dmy' })).bytes, 'DMY')
    expect(dmy.orders).toEqual(['DMY'])
    expect(dmy.statements[0].lines[0].date).toBe('2026-10-01')
    const utf8 = readBack((await write(data(), { encoding: 'utf-8' })).bytes)
    expect(utf8.statements[0].lines.find(l => l.amount === '-31.20')?.payee).toBe('Łódź Market')
  })

  it('writes no account with nothing in the range, which the import would only leave out', async () => {
    const { statements, warnings } = readBack((await write(data([chequing(), savings({ transactions: [] })]))).bytes)
    expect(statements.map(s => s.account.key)).toEqual(['qif:account:chequing'])
    expect(warnings).toEqual([])
  })
})
