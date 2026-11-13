// @vitest-environment node
// Guessing a CSV file's layout. The layout corpus (tests/fixtures/import/csv/layouts, see its README): each file's
// guess equals its expected layout, with the same choices marked as guesses. Then the rules one at a time.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCsv, valuesOf } from '../../../plugins/format-csv/src/shared/csv'
import { guessLayout } from '../../../plugins/format-csv/src/shared/guess'
import { readLines } from '../../../plugins/format-csv/src/shared/lines'

const LAYOUTS = path.resolve(__dirname, '../../fixtures/import/csv/layouts')
const PIVOT = 2036

const guessOf = (text: string) => {
  const { delimiter, rows } = readCsv(text)
  return guessLayout(rows.map(valuesOf), { delimiter, pivot: PIVOT })
}
const marks = (guess: ReturnType<typeof guessOf>) => guess.uncertain.map(u => u.field + (u.column !== undefined ? `:${u.column}` : ''))
const csv = (...lines: string[]) => `${lines.join('\n')}\n`

const corpus = fs.readdirSync(LAYOUTS).filter(name => name.endsWith('.csv')).sort()

describe('the layout corpus', () => {
  it('has an expected layout for every file, and a file for every expected layout', () => {
    const expected = fs.readdirSync(LAYOUTS).filter(name => name.endsWith('.expected.json')).map(name => name.replace('.expected.json', '.csv')).sort()
    expect(expected).toEqual(corpus)
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  })

  it.each(corpus)('%s: the guess is the expected layout, with the expected choices marked as guesses', name => {
    const expected = JSON.parse(fs.readFileSync(path.join(LAYOUTS, name.replace(/\.csv$/, '.expected.json')), 'utf8'))
    const guess = guessOf(fs.readFileSync(path.join(LAYOUTS, name), 'utf8'))
    expect(guess.layout).toEqual(expected.layout)
    expect(marks(guess).sort()).toEqual([...expected.uncertain].sort())
    // Every guess gives a reason in words
    for (const u of guess.uncertain) expect(u.why.length).toBeGreaterThan(20)
  })

  it.each(corpus)('%s: the expected layout reads every transaction row, with no warnings', name => {
    const expected = JSON.parse(fs.readFileSync(path.join(LAYOUTS, name.replace(/\.csv$/, '.expected.json')), 'utf8'))
    const { rows } = readCsv(fs.readFileSync(path.join(LAYOUTS, name), 'utf8'), expected.layout.delimiter)
    const read = readLines(rows.map(valuesOf), expected.layout, PIVOT)
    expect(read.leftOut.filter(l => !l.quiet && !l.pending)).toEqual([])
    expect(read.statements.reduce((n, s) => n + s.lines.length, 0)).toBeGreaterThanOrEqual(3)
  })
})

describe('guessing, rule by rule', () => {
  it('finds the header after a preamble, and says it skipped the preamble only when there is no header', () => {
    const withHeader = guessOf(csv('Account,Chequing 5678', 'From,2026-10-01', '', 'Date,Description,Amount', '2026-10-05,COSTCO,-84.12', '2026-10-06,LOBLAWS,-12.00'))
    expect(withHeader.layout).toMatchObject({ skip: 3, header: true, columns: { date: 0, payee: 1, amount: 2 } })
    expect(marks(withHeader)).toEqual([])
    const without = guessOf(csv('Chequing 5678', '', '2026-10-05,COSTCO,-84.12', '2026-10-06,LOBLAWS,-12.00'))
    expect(without.layout).toMatchObject({ skip: 2, header: false })
    expect(marks(without)).toEqual(['start'])
  })

  it('takes a header it knows none of the names of from the data, and says so', () => {
    const guess = guessOf(csv('Quand,Quoi,Combien', '2026-10-05,COSTCO,-84.12', '2026-10-06,LOBLAWS,-12.00', '2026-10-07,METRO,-5.00'))
    expect(guess.layout).toMatchObject({ header: true, columns: { date: 0, payee: 1, amount: 2 } })
    expect(marks(guess).sort()).toEqual(['column:0', 'column:1', 'start'])
  })

  it('checks a name against its column: a “Date” column that holds no dates isn’t the date', () => {
    const guess = guessOf(csv('Date,Posted,Description,Amount', 'Mon,2026-10-05,COSTCO,-84.12', 'Tue,2026-10-06,LOBLAWS,-12.00'))
    expect(guess.layout.columns.date).toBe(1)
  })

  it('reads the date order from a day past 12, and guesses it from the shortest span when nothing decides', () => {
    expect(guessOf(csv('Date,Description,Amount', '10/05/2026,A,-1.00', '10/13/2026,B,-2.00')).layout.dateOrder).toBe('MDY')
    expect(guessOf(csv('Date,Description,Amount', '05/10/2026,A,-1.00', '13/10/2026,B,-2.00')).layout.dateOrder).toBe('DMY')
    const ambiguous = guessOf(csv('Date,Description,Amount', '10/01/2026,A,-1.00', '10/05/2026,B,-2.00', '10/09/2026,C,-2.00'))
    expect(ambiguous.layout.dateOrder).toBe('MDY')                       // Oct 1 to Oct 9, not Jan 10 to Sep 10
    expect(ambiguous.uncertain.find(u => u.field === 'dateOrder')?.why).toMatch(/day\/month or month\/day: every day in this file is 12 or less/)
  })

  it('reads the decimal separator, and marks it a guess only when a cell could be read both ways', () => {
    expect(guessOf(csv('Date;Description;Amount', '2026-10-05;A;-84,12', '2026-10-06;B;-1,00')).layout.decimal).toBe(',')
    expect(marks(guessOf(csv('Date,Description,Amount', '2026-10-05,A,-84.12', '2026-10-06,B,"-1,234.00"')))).toEqual([])
    const both = guessOf(csv('Date,Description,Amount', '2026-10-05,A,"-1,234"', '2026-10-06,B,-12'))
    expect(both.layout.decimal).toBe('.')
    expect(marks(both)).toEqual(['decimal'])
  })

  it('guesses amounts reversed when more than two thirds are positive, and never with two columns or a direction', () => {
    const mostlyPositive = (n: number) => guessOf(csv('Date,Description,Amount', ...Array.from({ length: 6 }, (_, i) => `2026-10-0${i + 1},X${i},${i < n ? '' : '-'}5.00`)))
    expect(mostlyPositive(5).layout.reversed).toBe(true)
    expect(mostlyPositive(4).layout.reversed).toBe(false)                 // exactly two thirds isn't more
    expect(mostlyPositive(5).uncertain.find(u => u.field === 'reversed')?.why).toMatch(/^5 of the 6 amounts are positive/)
    expect(guessOf(csv('Date,Description,Debit,Credit', '2026-10-01,A,5.00,', '2026-10-02,B,6.00,')).layout.reversed).toBe(false)
  })

  it('finds a running balance by adding up, oldest first or newest first, rising with the amounts or against them', () => {
    const rising = guessOf(csv('2026-10-01,A,-10.00,90.00', '2026-10-02,B,-5.00,85.00', '2026-10-03,C,20.00,105.00'))
    expect(rising.layout.columns).toMatchObject({ amount: 2, balance: 3 })
    const owed = guessOf(csv('2026-10-01,A,10.00,110.00', '2026-10-02,B,5.00,115.00', '2026-10-03,PAYMENT,-50.00,65.00'))
    expect(owed.layout.columns).toMatchObject({ amount: 2, balance: 3 })
    // Two number columns that don't add up: the first is the amount, and the other isn't a balance
    const neither = guessOf(csv('2026-10-01,A,-10.00,7.00', '2026-10-02,B,-5.00,3.00', '2026-10-03,C,20.00,1.00'))
    expect(neither.layout.columns.balance).toBeUndefined()
  })

  it('tells a pair of money out and money in columns from an amount and a balance', () => {
    const pair = guessOf(csv('2026-10-01,A,10.00,', '2026-10-02,B,,20.00', '2026-10-03,C,5.00,'))
    expect(pair.layout.columns).toMatchObject({ debit: 2, credit: 3 })
    expect(pair.uncertain.find(u => u.column === 2)?.why).toMatch(/left one is taken as money out/)
  })

  it('doesn’t take an account number, a constant or a code for an amount', () => {
    const guess = guessOf(csv('2026-10-01,12345678,A,-10.00', '2026-10-02,12345678,B,-5.00', '2026-10-03,12345678,C,20.00'))
    expect(guess.layout.columns).toMatchObject({ date: 0, account: 1, payee: 2, amount: 3 })
  })

  it('finds currency, status and direction columns without a header', () => {
    const guess = guessOf(csv('2026-10-01,A,10.00,DR,CAD,Posted', '2026-10-02,B,20.00,CR,CAD,Pending', '2026-10-03,C,5.00,DR,CAD,Posted'))
    expect(guess.layout.columns).toMatchObject({ date: 0, payee: 1, amount: 2, direction: { column: 3, debit: ['DR'], credit: ['CR'] }, currency: 4, status: { column: 5, pending: ['Pending'] } })
  })

  it('keeps the fullest of two amount columns a header names (CAD$ and USD$), and makes a second payee a memo', () => {
    const guess = guessOf(csv('Date,Description,Description,CAD$,USD$', '2026-10-01,A,a,,-1.00', '2026-10-02,B,b,,-2.00'))
    expect(guess.layout.columns).toMatchObject({ date: 0, payee: 1, memo: [2], amount: 4 })
  })

  it('works out the posting date of two date columns as the later one, without a header', () => {
    const guess = guessOf(csv('2026-10-01,2026-10-03,A,-1.00', '2026-10-02,2026-10-02,B,-2.00', '2026-10-04,2026-10-06,C,-3.00'))
    expect(guess.layout.columns).toMatchObject({ date: 1, userDate: 0 })
  })

  it('gives a layout that reads nothing, and says why, for a file with no dates and amounts', () => {
    const guess = guessOf(csv('Name,Colour', 'apple,red', 'pear,green'))
    expect(guess.layout.columns).toEqual({})
    expect(marks(guess)).toEqual(['start'])
  })

  it('describes each column’s shape for a headerless file’s signature', () => {
    expect(guessOf(csv('2026-10-01,A,10.00,', '2026-10-02,B,5.00,')).shapes).toEqual(['date', 'text', 'number', 'empty'])
  })
})
