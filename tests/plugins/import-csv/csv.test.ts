// @vitest-environment node
// Reading a CSV file's rows: RFC 4180, what banks' exports do beyond it, and detecting the delimiter.
import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseCsv, readCsv, unmarked, valuesOf } from '../../../plugins/import-csv/src/shared/csv'

const rows = (text: string, delimiter: ',' | ';' | '\t' | '|' = ',') => parseCsv(text, delimiter).map(valuesOf)

describe('reading rows', () => {
  it('splits plain rows, whatever the line ends, with no row for a trailing line end', () => {
    expect(rows('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    expect(rows('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(rows('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(rows('')).toEqual([])
    expect(rows('a,b')).toEqual([['a', 'b']])
  })

  it('reads quoted cells: delimiters, doubled quotes and line breaks inside, spaces around them', () => {
    expect(rows('"COSTCO, OTTAWA","say ""hi""",3\n')).toEqual([['COSTCO, OTTAWA', 'say "hi"', '3']])
    expect(rows('"two\nlines",x\nnext,y\n')).toEqual([['two\nlines', 'x'], ['next', 'y']])
    expect(rows('"two\r\nlines",x\r\nnext,y\r\n')).toEqual([['two\r\nlines', 'x'], ['next', 'y']])
    expect(rows(' "a" , "b" ,c')).toEqual([['a', 'b', 'c']])
    expect(rows('"unclosed,x')).toEqual([['unclosed,x']])
  })

  it('keeps where each row starts, and where each cell is written', () => {
    const text = '"a\nb",c\nd,"e"\n'
    const parsed = parseCsv(text, ',')
    expect(parsed.map(r => r.line)).toEqual([1, 3])
    expect(parsed[1].cells.map(c => text.slice(c.start, c.end))).toEqual(['d', '"e"'])
    expect(parsed[1].cells.map(c => c.quoted)).toEqual([false, true])
  })

  it('keeps blank lines and ragged rows as they are, trimming cells', () => {
    expect(rows('a,b,c\n\n1,2\n1,2,3,4\n ,\n')).toEqual([['a', 'b', 'c'], [''], ['1', '2'], ['1', '2', '3', '4'], ['', '']])
    expect(rows('  12.50 ,x  ')).toEqual([['12.50', 'x']])
    expect(rows('a,\n')).toEqual([['a', '']])
  })

  it("takes off Excel's marks for keeping leading zeros, and nothing else", () => {
    expect(rows('="00123",x\n"=""00456""",y\n\'00789,\'-12.50\n')).toEqual([['00123', 'x'], ['00456', 'y'], ['00789', '-12.50']])
    expect(unmarked("'Til Midnight")).toBe("'Til Midnight")
    expect(unmarked('=SUM(A1)')).toBe('=SUM(A1)')
  })

  it('splits on semicolons, tabs and bars', () => {
    expect(rows('2026-10-05;COSTCO;-84,12\n', ';')).toEqual([['2026-10-05', 'COSTCO', '-84,12']])
    expect(rows('2026-10-05\tCOSTCO\t-84.12\n', '\t')).toEqual([['2026-10-05', 'COSTCO', '-84.12']])
    expect(rows('a|b\n', '|')).toEqual([['a', 'b']])
  })
})

describe('detecting the delimiter', () => {
  it('finds each delimiter', () => {
    expect(detectDelimiter('Date,Description,Amount\n2026-10-05,COSTCO,-84.12\n')).toBe(',')
    expect(detectDelimiter('Date;Libellé;Montant\n05/10/2026;COSTCO;-84,12\n')).toBe(';')
    expect(detectDelimiter('Date\tDescription\tAmount\n2026-10-05\tCOSTCO\t-84.12\n')).toBe('\t')
    expect(detectDelimiter('Date|Description|Amount\n2026-10-05|COSTCO|-84.12\n')).toBe('|')
  })

  it('is not fooled by comma decimals in a semicolon file, even where every line has the same commas', () => {
    expect(detectDelimiter('05/10/2026;COSTCO;-84,12;1 234,56\n06/10/2026;LOBLAWS;-12,00;1 222,56\n')).toBe(';')
    expect(detectDelimiter('05/10/2026;COSTCO;-84,12\n06/10/2026;LOBLAWS;-12,00\n')).toBe(';')
  })

  it('counts only delimiters outside quotes, and ignores a preamble', () => {
    const text = 'Account: Chequing 5678\nFrom 2026-10-01 to 2026-10-31\n\nDate,Description,Amount\n2026-10-05,"COSTCO, OTTAWA",-84.12\n2026-10-06,"A; B",-1.00\n'
    expect(detectDelimiter(text)).toBe(',')
    expect(readCsv(text).rows.map(valuesOf).slice(3)).toEqual([['Date', 'Description', 'Amount'], ['2026-10-05', 'COSTCO, OTTAWA', '-84.12'], ['2026-10-06', 'A; B', '-1.00']])
  })

  it('says comma when nothing splits', () => {
    expect(detectDelimiter('just one column\nand another line\n')).toBe(',')
    expect(detectDelimiter('')).toBe(',')
  })
})
