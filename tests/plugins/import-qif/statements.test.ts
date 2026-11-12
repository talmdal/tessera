// @vitest-environment node
// QIF records → statements: the samples (a Money-style account, a Quicken whole-file export, a bank's card file), then
// each rule: accounts and AutoSwitch lists, investment accounts and lists left out, N, L, splits, the opening balance,
// keys and types, and what is left out of a record.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCanonicalDecimal, type ParseWarning } from '@tessera/import-api'
import { parseQif } from '../../../plugins/import-qif/src/privileged/qif'
import { collect, identify, readStatement, type ReadOptions } from '../../../plugins/import-qif/src/privileged/statements'
import { SAMPLES } from '../../helpers/importFile'

const OPTIONS: ReadOptions = { dateOrder: 'MDY', decimal: '.', pivot: 2036, reversed: false }
function read(text: string, fileName = 'Checking.qif', options: Partial<ReadOptions> = {}) {
  const collected = collect(parseQif(text))
  const warnings: ParseWarning[] = [...collected.warnings]
  const statements = collected.statements.map(raw => {
    const r = readStatement(raw, fileName, { ...OPTIONS, ...options })
    warnings.push(...r.warnings)
    return r.statement
  })
  return { statements, warnings }
}
const sampleText = (name: string) => fs.readFileSync(path.join(SAMPLES, name), 'latin1')

describe('the QIF samples', () => {
  it('a Money-style account: named by its opening-balance record, which is its balance, not a line', () => {
    const { statements: [s], warnings } = read(sampleText('maple-trust-chequing-2026-09.qif'), 'maple-trust-chequing-2026-09.qif')
    expect(warnings).toEqual([])
    expect(s.account).toEqual({ key: 'qif:account:maple trust chequing', keyStrength: 'weak', name: 'Maple Trust Chequing', label: 'Maple Trust Chequing', type: 'chequing' })
    expect(s.lines).toHaveLength(17)
    expect(s.balance).toEqual({ amount: '2658.38', asOf: '2026-10-05' })
    expect(s.lines[0]).toEqual({ date: '2026-09-02', amount: '-1200.00', payee: 'Landlord', number: '100', kind: 'cheque', category: 'Housing:Rent', memo: 'September rent' })
    expect(s.lines[2]).toEqual({ date: '2026-09-05', amount: '-84.12', payee: 'Costco', memo: 'Weekly shop · Split: Food:Groceries 64.12 · Household 20.00' })
    expect(s.lines.find(l => l.payee === 'ATM Withdrawal')).toMatchObject({ kind: 'atm' })
    expect(s.lines.find(l => l.payee === 'Transfer to Maple Savings')).toEqual({ date: '2026-09-22', amount: '-4000.00', payee: 'Transfer to Maple Savings', kind: 'transfer' })
    for (const line of s.lines) expect(isCanonicalDecimal(line.amount)).toBe(true)
  })

  it('a Quicken whole-file export: one statement per account, the list and the RRSP left out', () => {
    const { statements, warnings } = read(sampleText('household-quicken-export.qif'))
    expect(statements.map(s => [s.account.name, s.account.type, s.lines.length, s.balance?.amount])).toEqual([
      ['Everyday Chequing', 'chequing', 10, '2539.45'], ['High Interest Savings', 'savings', 2, '8504.12'], ['Northwind Visa', 'creditCard', 5, '-357.82']
    ])
    expect(warnings).toEqual([{ message: 'An investment account (“RRSP”) was left out: Tessera doesn\'t import investment transactions yet.', line: expect.any(Number) }])
    const [chequing] = statements
    expect(chequing.lines.find(l => l.payee === 'Bytown Bistro')).toMatchObject({ category: 'Food:Dining out', memo: 'Client lunch' })   // the class taken off
    expect(chequing.lines.find(l => l.payee === 'Canadian Tire')?.memo).toBe('Split: Household 85.10 · Transportation:Car maintenance 35.25')
    expect(chequing.lines.find(l => l.payee === 'Cash')).toEqual({ date: '2026-10-09', amount: '-60.00', payee: 'Cash', kind: 'atm' })
    expect(chequing.lines.find(l => l.payee === 'Northwind Visa payment')).toMatchObject({ kind: 'transfer' })
    expect(chequing.lines.find(l => l.payee === 'Northwind Visa payment')).not.toHaveProperty('category')
  })

  it('a bank’s card file: no account name, so known by its file’s name', () => {
    const { statements: [s] } = read(sampleText('northwind-visa-2026-09.qif'), 'northwind-visa-2026-09.qif')
    expect(s.account).toEqual({ key: 'qif:file:northwind-visa', keyStrength: 'weak', label: 'northwind-visa-2026-09.qif (no account name)', type: 'creditCard' })
    expect(s.balance).toBeUndefined()
    expect(s.lines.filter(l => l.amount.startsWith('-')).map(l => l.payee)).toEqual(['PAYMENT - THANK YOU'])
  })
})

describe('sections and accounts', () => {
  it('sets the account for the sections after !Account, and starts a statement for each account', () => {
    const text = '!Account\nNSavings\nTBank\n^\n!Type:Bank\nD1/5/26\nT1.00\n^\n!Type:Bank\nD1/6/26\nT2.00\n^\n!Account\nNCash box\nTCash\n^\n!Type:Cash\nD1/7/26\nT-3.00\n^\n'
    const { statements } = read(text)
    expect(statements.map(s => [s.account.name, s.account.type, s.lines.length])).toEqual([['Savings', 'savings', 2], ['Cash box', 'cash', 1]])
  })

  it('takes AutoSwitch’s account list as a list: transactions after it belong to no account of it', () => {
    const text = '!Option:AutoSwitch\n!Account\nNChequing\nTBank\n^\nNRRSP\nTInvst\n^\n!Clear:AutoSwitch\n!Type:Bank\nD1/5/26\nT1.00\n^'
    const { statements, warnings } = read(text)
    expect(warnings).toEqual([])
    expect(statements.map(s => [s.account.name, s.lines.length])).toEqual([[undefined, 1]])
  })

  it('takes the type from the section without an !Account, and from other assets and liabilities', () => {
    expect(read('!Type:Oth A\nD1/5/26\nT1.00\n^').statements[0].account.type).toBe('otherAsset')
    expect(read('!Type:Oth L\nD1/5/26\nT-1.00\n^').statements[0].account.type).toBe('otherLiability')
    expect(read('!Type:Cash\nD1/5/26\nT-1.00\n^').statements[0].account.type).toBe('cash')
  })

  it('leaves out lists quietly, and sections it doesn’t know with a warning each', () => {
    const text = '!Type:Cat\nNFood\nE\n^\n!Type:Class\nNWork\n^\n!Type:Memorized\nKC\nT-1.00\n^\n!Type:Security\nNFund\n^\n!Type:Prices\n"FND",1.00," 1/ 5\'26"\n^\n!Option:MDY\n!Type:Weird\nX\n^\n!Type:Weird\nY\n^\n!Type:Bank\nD1/5/26\nT1.00\n^'
    const { statements, warnings } = read(text)
    expect(statements).toHaveLength(1)
    expect(warnings).toEqual([{ message: 'A section Tessera doesn\'t know (!Type:Weird) was left out.', line: 19 }])
  })

  it('leaves out investment accounts, by their section or their type, with one warning each', () => {
    const text = '!Account\nNBroker\nTPort\n^\n!Type:Bank\nD1/5/26\nT1.00\n^\n!Type:Invst\nD1/6/26\nNBuy\n^\n!Account\nN401k\nT401(k)/403(b)\n^\n!Type:Invst\nD1/7/26\n^'
    const { statements, warnings } = read(text)
    expect(statements).toEqual([])
    expect(warnings.map(w => w.message)).toEqual([
      'An investment account (“Broker”) was left out: Tessera doesn\'t import investment transactions yet.',
      'An investment account (“401k”) was left out: Tessera doesn\'t import investment transactions yet.'
    ])
  })

  it('warns about records before any header', () => {
    expect(read('D1/5/26\nT1.00\n^\n!Type:Bank\nD1/5/26\nT1.00\n^').warnings).toEqual([{ message: 'Records before the file\'s first !Type line were left out.', line: 1 }])
  })
})

describe('fields', () => {
  const one = (fields: string, options: Partial<ReadOptions> = {}) => read(`!Type:Bank\n${fields}\n^`, 'Checking.qif', options).statements[0]?.lines[0]

  it('reads N as a cheque number or a kind', () => {
    expect(one('D1/5/26\nT-1.00\nN0042')).toMatchObject({ number: '0042', kind: 'cheque' })
    for (const [n, kind] of [['ATM', 'atm'], ['DEP', 'deposit'], ['Deposit', 'deposit'], ['EFT', 'transfer'], ['XFER', 'transfer'], ['TXFR', 'transfer']]) {
      expect(one(`D1/5/26\nT-1.00\nN${n}`)).toMatchObject({ kind })
    }
    expect(one('D1/5/26\nT-1.00\nNPrint')).toEqual({ date: '2026-01-05', amount: '-1.00' })
  })

  it('reads L as a category hint, without its class, or a transfer, which has none', () => {
    expect(one('D1/5/26\nT-1.00\nLFood:Groceries/Home')).toMatchObject({ category: 'Food:Groceries' })
    expect(one('D1/5/26\nT-1.00\nL[Savings]/Home')).toEqual({ date: '2026-01-05', amount: '-1.00', kind: 'transfer' })
    expect(one('D1/5/26\nT-1.00\nL/Home')).toEqual({ date: '2026-01-05', amount: '-1.00' })
    expect(one('D1/5/26\nT-1.00\nN101\nL[Savings]')).toMatchObject({ kind: 'cheque' })      // a cheque to a transfer
  })

  it('keeps a split’s total, its parts in the memo, and no category hint', () => {
    expect(one('D1/5/26\nT-30.00\nL--Split--\nSFood\nEapples\n$-10.00\nS[Savings]\n$-20.00')).toEqual({ date: '2026-01-05', amount: '-30.00', memo: 'Split: Food 10.00 · [Savings] 20.00' })
    // Quicken may give a split the first part's category as its L: the total still has none
    expect(one('D1/5/26\nT-30.00\nLFood\nSFood\n$-10.00\nSHousehold\n$-20.00')).toEqual({ date: '2026-01-05', amount: '-30.00', memo: 'Split: Food 10.00 · Household 20.00' })
    const long = one(`D1/5/26\nT-1.00\nM${'m'.repeat(480)}\nSFood\n$-1.00\nSFood:Groceries\n$-0.00`)!
    expect(long.memo!.length).toBe(500)
    expect(long.memo!.endsWith('…')).toBe(true)
  })

  it('takes U when T is missing, and leaves out a record without a date or amount, saying why', () => {
    expect(one('D1/5/26\nU-1.00')).toMatchObject({ amount: '-1.00' })
    const { statements, warnings } = read('!Type:Bank\nT-1.00\n^\nD1/5/26\n^\nD13/45/26\nT-1.00\n^\nD1/6/26\nTabc\n^\nD1/7/26\nT-2.00\n^')
    expect(statements[0].lines).toHaveLength(1)
    expect(warnings).toEqual([
      { message: 'Left out: a transaction without a date.', line: 2 },
      { message: 'Left out: a transaction without an amount.', line: 4 },
      { message: 'Left out: its date “13/45/26” can\'t be read.', line: 6 },
      { message: 'Left out: its amount “abc” can\'t be read.', line: 9 }
    ])
  })

  it('reads amounts with the file’s decimal separator, and negates them when reversed', () => {
    expect(one('D1/5/26\nT-1.234,56', { decimal: ',' })).toMatchObject({ amount: '-1234.56' })
    expect(one('D1/5/26\nT-12.00', { reversed: true })).toMatchObject({ amount: '12.00' })
  })
})

describe('the opening balance', () => {
  it('is the first record when it says so and names an account; later ones are lines', () => {
    const text = '!Type:Bank\nD1/1/26\nT100.00\nPOpening Balance\nL[Chequing]\n^\nD1/5/26\nT-10.00\n^\nD1/6/26\nT5.00\nPOpening Balance\nL[Chequing]\n^'
    const { statements: [s] } = read(text)
    expect(s.account.name).toBe('Chequing')
    expect(s.lines).toHaveLength(2)
    expect(s.balance).toEqual({ amount: '95.00', asOf: '2026-01-06' })
  })

  it('isn’t one without its account, and is reversed with the rest', () => {
    expect(read('!Type:Bank\nD1/1/26\nT100.00\nPOpening Balance\n^').statements[0].lines).toHaveLength(1)
    const { statements: [s] } = read('!Type:CCard\nD1/1/26\nT100.00\nPOpening Balance\nL[Visa]\n^\nD1/5/26\nT20.00\n^', 'v.qif', { reversed: true })
    expect(s.balance).toEqual({ amount: '-120.00', asOf: '2026-01-05' })
  })

  it('gives the balance at its own date when the account has no other line', () => {
    const raw = collect(parseQif('!Type:Bank\nD1/1/26\nT100.00\nPOpening Balance\nL[Chequing]\n^')).statements[0]
    expect(readStatement(raw, 'x.qif', OPTIONS).statement).toMatchObject({ lines: [], balance: { amount: '100.00', asOf: '2026-01-01' } })
  })
})

describe('keys', () => {
  it('are weak, by the account’s name (normalised) or by the file’s name', () => {
    const raw = (text: string) => collect(parseQif(text)).statements[0]
    expect(identify(raw('!Account\nNMy   Chequing\nTBank\n^\n!Type:Bank\n'), 'x.qif').key).toBe('qif:account:my chequing')
    expect(identify(raw('!Type:Bank\nD1/5/26\nT1.00\n^'), 'Chequing 2026-10 (2).qif').key).toBe('qif:file:chequing')
    expect(identify(raw('!Type:Bank\nD1/5/26\nT1.00\n^'), '2026-10.qif').key).toBe('qif:file:statement')
  })
})
