// @vitest-environment node
// Rows and a layout → statements: every way of writing an amount, the rows left out and why, pending rows, several
// accounts, currencies, bank ids that repeat, and the closing balance whichever way round the rows are.
import { describe, expect, it } from 'vitest'
import { amountIn, add, negate, subtract } from '../../../plugins/import-csv/src/shared/cells'
import { parseCsv, valuesOf } from '../../../plugins/import-csv/src/shared/csv'
import type { CsvLayout } from '../../../plugins/import-csv/src/shared/layout'
import { balanceFit, readLines, rowAmount } from '../../../plugins/import-csv/src/shared/lines'

const PIVOT = 2036
const layout = (columns: CsvLayout['columns'], more: Partial<CsvLayout> = {}): CsvLayout =>
  ({ version: 1, delimiter: ',', skip: 0, header: false, columns, dateOrder: 'YMD', decimal: '.', reversed: false, ...more })
const rows = (...lines: string[]) => parseCsv(`${lines.join('\n')}\n`, ',').map(valuesOf)
const read = (l: CsvLayout, ...lines: string[]) => readLines(rows(...lines), l, PIVOT)
const amount = (l: CsvLayout, line: string) => rowAmount(rows(line)[0], l)

describe('amounts', () => {
  const one = layout({ date: 0, amount: 1 })
  it('reads a signed column in every way banks write it', () => {
    const cases: [string, string][] = [
      ['-84.12', '-84.12'], ['84.12-', '-84.12'], ['(84.12)', '-84.12'], ['"($1,200.00)"', '-1200.00'], ['$3000.00', '3000.00'],
      ['"1,234.56"', '1234.56'], ['+12.00', '12.00'], ['84.12 DR', '-84.12'], ['"3,000.00 CR"', '3000.00'], ['DR 5.00', '-5.00'],
      ['-84.12 DR', '-84.12'], ['0.00', '0.00'], ['CAD 12.00', '12.00']
    ]
    for (const [cell, expected] of cases) expect(amount(one, `2026-10-05,${cell}`), cell).toEqual({ kind: 'amount', amount: expected })
  })

  it('reads comma decimals with spaces grouping thousands', () => {
    const french = layout({ date: 0, amount: 1 }, { decimal: ',', delimiter: ';' })
    expect(rowAmount(['2026-10-05', '-1 234,56'], french)).toEqual({ kind: 'amount', amount: '-1234.56' })
    expect(rowAmount(['2026-10-05', '-1\u00a0234,56'], french)).toEqual({ kind: 'amount', amount: '-1234.56' })
  })

  it('reads money out and money in as in − out, whatever sign each is written with', () => {
    const pair = layout({ date: 0, debit: 1, credit: 2 })
    expect(amount(pair, '2026-10-05,84.12,')).toEqual({ kind: 'amount', amount: '-84.12' })
    expect(amount(pair, '2026-10-05,-84.12,')).toEqual({ kind: 'amount', amount: '-84.12' })
    expect(amount(pair, '2026-10-05,,3000')).toEqual({ kind: 'amount', amount: '3000' })
    expect(amount(pair, '2026-10-05,,')).toEqual({ kind: 'none' })
    expect(amount(pair, '2026-10-05,x,')).toEqual({ kind: 'error', reason: '“x” isn\'t an amount' })
  })

  it('signs an unsigned amount by its direction column, and says when the word is neither', () => {
    const direction = layout({ date: 0, amount: 1, direction: { column: 2, debit: ['DR', 'Debit'], credit: ['CR'] } })
    expect(amount(direction, '2026-10-05,84.12,DR')).toEqual({ kind: 'amount', amount: '-84.12' })
    expect(amount(direction, '2026-10-05,84.12,debit')).toEqual({ kind: 'amount', amount: '-84.12' })
    expect(amount(direction, '2026-10-05,-84.12,CR')).toEqual({ kind: 'amount', amount: '84.12' })
    expect(amount(direction, '2026-10-05,84.12,XX')).toEqual({ kind: 'error', reason: '“XX” doesn\'t say debit or credit' })
  })

  it('negates every amount when reversed, whatever the columns', () => {
    expect(amount(layout({ date: 0, amount: 1 }, { reversed: true }), '2026-10-05,84.12')).toEqual({ kind: 'amount', amount: '-84.12' })
    expect(amount(layout({ date: 0, debit: 1, credit: 2 }, { reversed: true }), '2026-10-05,84.12,')).toEqual({ kind: 'amount', amount: '84.12' })
  })

  it('adds, subtracts and negates as whole numbers', () => {
    expect(subtract('0.1', '0.3')).toBe('-0.2')
    expect(add('1200.00', '-0.005')).toBe('1199.995')
    expect(negate('0.00')).toBe('0.00')
    expect(amountIn('12,50', '.')).toBeUndefined()
  })
})

describe('lines', () => {
  it('reads dates in the layout’s order, with month names, two-digit years, and the transaction date when it differs', () => {
    const l = layout({ date: 1, userDate: 0, payee: 2, amount: 3 }, { dateOrder: 'MDY' })
    const { statements: [s] } = read(l, '10/03/2026,10/05/26,COSTCO,-84.12', 'Oct 6 2026,10/06/2026,LOBLAWS,-12.00')
    expect(s.lines.map(x => x.line)).toEqual([
      { date: '2026-10-05', userDate: '2026-10-03', payee: 'COSTCO', amount: '-84.12' },
      { date: '2026-10-06', payee: 'LOBLAWS', amount: '-12.00' }
    ])
  })

  it('joins memos, leaving out empty ones and any that repeat the payee; and keeps numbers, categories and ids', () => {
    const l = layout({ date: 0, payee: 1, memo: [2, 3], number: 4, category: 5, id: 6, amount: 7 })
    const { statements: [s] } = read(l, '2026-10-02,CHEQUE,CHEQUE,Rent,101,Housing,T1,-1200.00', '2026-10-05,COSTCO,,,,,T2,-84.12')
    expect(s.lines.map(x => x.line)).toEqual([
      { date: '2026-10-02', payee: 'CHEQUE', memo: 'Rent', number: '101', category: 'Housing', externalId: 'T1', amount: '-1200.00' },
      { date: '2026-10-05', payee: 'COSTCO', externalId: 'T2', amount: '-84.12' }
    ])
    expect(s.repeatedIds).toBe(false)
  })

  it('leaves out blank rows, balance forward and totals rows quietly, and unreadable rows with a reason', () => {
    const l = layout({ date: 0, payee: 1, debit: 2, credit: 3, balance: 4 }, { header: true })
    const result = read(l, 'Date,Description,Out,In,Balance', ',Balance forward,,,5000.00', '2026-10-02,CHEQUE,1200.00,,3800.00', '',
      'TOTAL,,1200.00,,', ',Total,1200.00,,', '2026-13-45,BAD DATE,1.00,,', '2026-10-06,BAD AMOUNT,abc,,')
    expect(result.firstRow).toBe(1)
    expect(result.statements[0].lines.map(l => l.row)).toEqual([2])
    expect(result.leftOut).toEqual([
      { row: 1, reason: 'It has no amount: a balance forward or totals row.', quiet: true },
      { row: 3, reason: 'It is blank.', quiet: true },
      { row: 4, reason: '“TOTAL” isn\'t a date.', quiet: false },
      { row: 5, reason: 'It is a totals or balance row.', quiet: true },
      { row: 6, reason: '“2026-13-45” isn\'t a date.', quiet: false },
      { row: 7, reason: '“abc” isn\'t an amount.', quiet: false }
    ])
  })

  it('leaves out pending rows, as the status column says, whatever their case', () => {
    const l = layout({ date: 0, payee: 1, amount: 2, status: { column: 3, pending: ['Pending'] } })
    const result = read(l, '2026-10-02,A,-1.00,Posted', '2026-10-03,B,-2.00,PENDING', '2026-10-04,C,-3.00,pending')
    expect(result.statements[0].lines.map(x => x.line.payee)).toEqual(['A'])
    expect(result.leftOut.map(x => [x.row, x.pending])).toEqual([[1, true], [2, true]])
  })

  it('makes one statement per account, in the order they first appear', () => {
    const l = layout({ account: 0, date: 1, payee: 2, amount: 3 })
    const { statements } = read(l, 'XXXX5678,2026-10-02,A,-1.00', 'XXXX 9012,2026-10-03,B,2.00', 'XXXX5678,2026-10-04,C,-3.00')
    expect(statements.map(s => [s.account, s.lines.map(x => x.line.payee)])).toEqual([['XXXX5678', ['A', 'C']], ['XXXX9012', ['B']]])
  })

  it('takes the currency when every row agrees, and lists them when they don’t', () => {
    const l = layout({ date: 0, amount: 1, currency: 2 })
    expect(read(l, '2026-10-02,-1.00,cad', '2026-10-03,-2.00,CAD').statements[0].currency).toBe('CAD')
    expect(read(l, '2026-10-02,-1.00,CAD', '2026-10-03,-2.00,USD').statements[0].currencies).toEqual(['CAD', 'USD'])
  })

  it('notices bank ids that repeat', () => {
    const l = layout({ date: 0, amount: 1, id: 2 })
    expect(read(l, '2026-10-02,-1.00,7', '2026-10-03,-2.00,7').statements[0].repeatedIds).toBe(true)
  })
})

describe('the closing balance', () => {
  const l = layout({ date: 0, payee: 1, amount: 2, balance: 3 })
  it('is the last row’s, oldest first', () => {
    const { statements: [s] } = read(l, '2026-10-01,A,-10.00,90.00', '2026-10-02,B,-5.00,85.00', '2026-10-02,C,20.00,105.00')
    expect(s).toMatchObject({ order: 'oldestFirst', balance: { amount: '105.00', asOf: '2026-10-02' } })
  })

  it('is the first row’s, newest first, even when the last day has several rows', () => {
    const { statements: [s] } = read(l, '2026-10-02,C,20.00,105.00', '2026-10-02,B,-5.00,85.00', '2026-10-01,A,-10.00,90.00')
    expect(s).toMatchObject({ order: 'newestFirst', balance: { amount: '105.00', asOf: '2026-10-02' } })
  })

  it('is the amount owed, made negative, for a card whose balance rises with charges written as negatives', () => {
    const { statements: [s] } = read(l, '2026-10-01,A,-10.00,110.00', '2026-10-02,B,-5.00,115.00', '2026-10-03,PAYMENT,50.00,65.00')
    expect(s.balance).toEqual({ amount: '-65.00', asOf: '2026-10-03' })
  })

  it('is signed the Tessera way for a card with charges positive and reversed, whose balance rises with them', () => {
    const { statements: [s] } = read({ ...l, reversed: true }, '2026-10-01,A,10.00,110.00', '2026-10-02,B,5.00,115.00', '2026-10-03,PAYMENT,-50.00,65.00')
    expect(s.lines.map(x => x.line.amount)).toEqual(['-10.00', '-5.00', '50.00'])
    expect(s.balance).toEqual({ amount: '-65.00', asOf: '2026-10-03' })
  })

  it('uses the balances to tell the order when every row is on one day', () => {
    const { statements: [s] } = read(l, '2026-10-02,C,20.00,105.00', '2026-10-02,B,-5.00,85.00', '2026-10-02,A,-10.00,90.00')
    expect(s).toMatchObject({ order: 'newestFirst', balance: { amount: '105.00' } })
  })

  it('fits balances to amounts: which order, which way, and how many pairs agree', () => {
    expect(balanceFit(['-10', '-5', '20'], ['90', '85', '105'])).toEqual({ order: 'oldestFirst', sign: 1, fit: 1, pairs: 2 })
    expect(balanceFit(['20', '-5', '-10'], ['105', '85', '90'])).toEqual({ order: 'newestFirst', sign: 1, fit: 1, pairs: 2 })
    expect(balanceFit(['1'], ['5'])).toBeUndefined()
  })
})
