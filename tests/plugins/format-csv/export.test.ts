// Writing CSV (docs/export-design.md, "CSV"): the header and cells as the design defines them, each option, what is
// warned about, and the round trip: every file Tessera writes is read back by this plugin's own reader, as
// "recognised" (nothing guessed), with the same lines and balance.
import { describe, expect, it } from 'vitest'
import { resolveOptions, type ExportAccount, type ExportData, type ExportOptions, type ExportTransaction } from '@tessera/export-api'
import { CSV_EXPORT, csvExport } from '../../../plugins/format-csv/src/privileged/export'
import { readCsv, valuesOf } from '../../../plugins/format-csv/src/shared/csv'
import { guessLayout } from '../../../plugins/format-csv/src/shared/guess'
import { readLines } from '../../../plugins/format-csv/src/shared/lines'
import { decode } from '../../../plugins/import/src/privileged/files'

const tx = (over: Partial<ExportTransaction> & Pick<ExportTransaction, 'date' | 'amount' | 'balance'>): ExportTransaction =>
  ({ id: `t${over.date}${over.amount}`, status: 'uncleared', voided: false, ...over })

function account(over: Partial<ExportAccount> = {}): ExportAccount {
  return {
    id: 'chq', name: 'Chequing', type: 'chequing', currency: 'CAD', digits: 2, closed: false, location: [],
    opening: { date: '2026-10-01', balance: '5000.00' }, closing: { date: '2026-10-31', balance: '5645.48' },
    transactions: [
      tx({ date: '2026-10-01', amount: '-1200.00', payee: 'Landlord', category: ['Housing', 'Rent'], status: 'reconciled', balance: '3800.00' }),
      tx({ date: '2026-10-03', amount: '-84.12', payee: 'Hydro One', number: '101', memo: 'Sept, 2026 "final"', status: 'cleared', balance: '3715.88' }),
      tx({ date: '2026-10-05', amount: '2500.00', payee: 'Employer Inc', category: ['Income', 'Salary'], status: 'electronic', balance: '6215.88' }),
      tx({ date: '2026-10-07', amount: '-500.00', payee: 'Transfer', transfer: { account: 'Savings', direction: 'to' }, balance: '5715.88' }),
      tx({ date: '2026-10-08', amount: '-75.00', payee: 'Cancelled Order', voided: true, balance: '5715.88' }),
      tx({ date: '2026-10-14', amount: '-23.45', payee: 'Café Dépanneur', category: ['Food', 'Groceries'], balance: '5692.43' }),
      tx({ date: '2026-10-16', amount: '-12.00', payee: 'Łódź Market', memo: 'Line one\nLine two', balance: '5680.43' }),
      tx({ date: '2026-10-20', amount: '-34.95', payee: '=SUM(A1:A9)', balance: '5645.48' })
    ],
    ...over
  }
}

const data = (accounts: ExportAccount[] = [account()]): ExportData => ({
  ledger: { name: 'Home' }, exportedAt: '2026-11-06T12:00:00.000Z', range: { from: '2026-10-01', to: '2026-10-31' }, accounts, categories: []
})
const options = (over: ExportOptions = {}) => resolveOptions(CSV_EXPORT.options, over)
const write = async (d: ExportData, over: ExportOptions = {}) => csvExport.write(d, options(over), CSV_EXPORT.id)
const text = async (d: ExportData, over: ExportOptions = {}) => decode((await write(d, over)).bytes, 'auto')

/** The file read back by this plugin's reader, as an import would: the guess, and the lines. */
function readBack(bytes: Uint8Array) {
  const { delimiter, rows } = readCsv(decode(bytes, 'auto'))
  const values = rows.map(valuesOf)
  const guess = guessLayout(values, { delimiter, pivot: 2036 })
  const read = readLines(values, guess.layout, 2036)
  return { guess, read, lines: read.statements.flatMap(s => s.lines.map(l => l.line)) }
}

describe('writing CSV', () => {
  it('writes the design’s header and one row per transaction, in UTF-8 with a byte-order mark and CRLF', async () => {
    const { bytes } = await write(data())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(await text(data())).toBe([
      'Date,Cheque number,Payee,Category,Memo,Amount,Status,Balance',
      '2026-10-01,,Landlord,Housing : Rent,,-1200.00,R,3800.00',
      '2026-10-03,101,Hydro One,,"Sept, 2026 ""final""",-84.12,C,3715.88',
      '2026-10-05,,Employer Inc,Income : Salary,,2500.00,E,6215.88',
      '2026-10-07,,Transfer,Transfer to: Savings,,-500.00,,5715.88',
      '2026-10-14,,Café Dépanneur,Food : Groceries,,-23.45,,5692.43',
      '2026-10-16,,Łódź Market,,"Line one\nLine two",-12.00,,5680.43',
      "2026-10-20,,'=SUM(A1:A9),,,-34.95,,5645.48",
      ''
    ].join('\r\n'))
  })

  it('says how many transactions, what it leaves out and what it changes; nothing to export is a problem', async () => {
    const check = await csvExport.check(data(), options(), CSV_EXPORT.id)
    expect(check).toEqual({
      transactions: 7, problems: [],
      warnings: ['1 cell starting like a spreadsheet formula is written with a \' in front.', '1 voided transaction is left out.']
    })
    const empty = await csvExport.check(data([account({ transactions: [] })]), options(), CSV_EXPORT.id)
    expect(empty).toEqual({ transactions: 0, accountsLeftOut: ['chq'], problems: ['There are no transactions to export in “Chequing” for these dates.'], warnings: [] })
  })

  it('writes Money out and Money in columns, comma decimals with semicolons, and the date orders asked for', async () => {
    const outIn = (await text(data(), { amounts: 'outIn' })).split('\r\n')
    expect(outIn[0]).toBe('Date,Cheque number,Payee,Category,Memo,Money out,Money in,Status,Balance')
    expect(outIn[1]).toBe('2026-10-01,,Landlord,Housing : Rent,,1200.00,,R,3800.00')
    expect(outIn[3]).toBe('2026-10-05,,Employer Inc,Income : Salary,,,2500.00,E,6215.88')

    const comma = (await text(data(), { decimal: ',' })).split('\r\n')
    expect(comma[0]).toBe('Date;Cheque number;Payee;Category;Memo;Amount;Status;Balance')
    expect(comma[2]).toBe('2026-10-03;101;Hydro One;;"Sept, 2026 ""final""";-84,12;C;3715,88')

    expect((await text(data(), { dates: 'mdy' })).split('\r\n')[5]).toMatch(/^10\/14\/2026,/)
    expect((await text(data(), { dates: 'dmy' })).split('\r\n')[5]).toMatch(/^14\/10\/2026,/)
  })

  it('writes Windows-1252 without a byte-order mark, replacing what it can’t hold, and says so', async () => {
    const { bytes, warnings } = await write(data(), { encoding: 'windows-1252' })
    expect([...bytes.slice(0, 4)]).toEqual([...'Date'].map(c => c.charCodeAt(0)))
    const back = decode(bytes, 'auto')
    expect(back).toContain('Café Dépanneur')                  // é is in windows-1252
    expect(back).toContain('Lódz Market')                      // Ł and ź aren't: their base letters
    expect(warnings).toContain('2 characters Windows can’t hold are written as the nearest letter, or “?”.')
  })

  it('includes voided transactions when asked, marked V and out of the balance; leaves the formula guard off when asked', async () => {
    const lines = (await text(data(), { includeVoided: true, formulaGuard: false })).split('\r\n')
    expect(lines).toContain('2026-10-08,,Cancelled Order,,,-75.00,V,5715.88')
    expect(lines).toContain('2026-10-20,,=SUM(A1:A9),,,-34.95,,5645.48')
    expect((await csvExport.check(data(), options({ includeVoided: true }), CSV_EXPORT.id)).transactions).toBe(8)
  })

  it('adds an Account column for several accounts, and a Currency column for several currencies, with warnings', async () => {
    const yen = account({
      id: 'jpy', name: 'Tokyo', currency: 'JPY', digits: 0, opening: { date: '2026-10-01', balance: '100000' }, closing: { date: '2026-10-31', balance: '98800' },
      transactions: [tx({ date: '2026-10-15', amount: '-1200', payee: 'Ramen', balance: '98800' })]
    })
    const lines = (await text(data([account(), yen]))).split('\r\n')
    expect(lines[0]).toBe('Account,Date,Cheque number,Payee,Category,Memo,Amount,Currency,Status,Balance')
    expect(lines[1]).toBe('Chequing,2026-10-01,,Landlord,Housing : Rent,,-1200.00,CAD,R,3800.00')
    expect(lines).toContain('Tokyo,2026-10-15,,Ramen,,,-1200,JPY,,98800')
    const { warnings } = await csvExport.check(data([account(), yen]), options(), CSV_EXPORT.id)
    expect(warnings).toContain('Several accounts in one CSV file suit a spreadsheet. Tessera would import the file back as a single account.')
    expect(warnings).toContain('The accounts are in more than one currency (CAD, JPY): a Currency column says which, and Tessera can’t import the file back.')
  })
})

describe('reading an exported CSV back', () => {
  const variants: [string, ExportOptions][] = [
    ['the defaults', {}],
    ['Money out and Money in', { amounts: 'outIn' }],
    ['comma decimals', { decimal: ',' }],
    ['Windows-1252', { encoding: 'windows-1252' }],
    ['month first', { dates: 'mdy' }],
    ['day first', { dates: 'dmy' }]
  ]
  it.each(variants)('reads %s as recognised, with the same lines and balance', async (_, over) => {
    const d = data()
    const { bytes } = await write(d, over)
    const { guess, read, lines } = readBack(bytes)
    expect(guess.uncertain).toEqual([])
    expect(read.leftOut).toEqual([])
    const written = d.accounts[0].transactions.filter(t => !t.voided)
    expect(lines.map(l => [l.date, l.amount, l.number])).toEqual(written.map(t => [t.date, t.amount, t.number]))
    // The formula guard's ' is taken off again; 1252 replaces what it can't hold
    const payees = written.map(t => over.encoding === 'windows-1252' ? t.payee!.replace('Łódź', 'Lódz') : t.payee)
    expect(lines.map(l => l.payee)).toEqual(payees)
    expect(read.statements[0].balance).toEqual({ amount: d.accounts[0].closing.balance, asOf: '2026-10-20' })
  })

  it('reads every category and transfer label as the register writes it', async () => {
    const { lines } = readBack((await write(data())).bytes)
    expect(lines.map(l => l.category)).toEqual(['Housing : Rent', undefined, 'Income : Salary', 'Transfer to: Savings', 'Food : Groceries', undefined, undefined])
  })
})
