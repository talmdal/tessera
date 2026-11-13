// @vitest-environment node
// Reading QIF records: sections, records, fields with their lines and places, and what real files do: a last record
// without its '^', a '^' alone, blank lines, trailing spaces, every line end, spaces and case in headers, a '!' line
// in the middle of a record.
import { describe, expect, it } from 'vitest'
import { parseQif, sectionName, valueOf } from '../../../plugins/format-qif/src/privileged/qif'

const codes = (text: string) => parseQif(text).map(s => [s.name, s.records.map(r => r.fields.map(f => `${f.code}${f.value}`))])

describe('reading QIF', () => {
  it('reads sections and their records, field by field, in order', () => {
    const text = '!Type:Bank\nD10/05\'26\nT-84.12\nPCostco\nSFood:Groceries\n$-64.12\nSHousehold\n$-20.00\n^\nD10/06\'26\nT-5.00\n^\n'
    expect(codes(text)).toEqual([['!type:bank', [["D10/05'26", 'T-84.12', 'PCostco', 'SFood:Groceries', '$-64.12', 'SHousehold', '$-20.00'], ["D10/06'26", 'T-5.00']]]])
    const [section] = parseQif(text)
    expect(section).toMatchObject({ header: '!Type:Bank', line: 1 })
    expect(section.records.map(r => r.line)).toEqual([2, 10])
    expect(valueOf(section.records[0], 'P')).toBe('Costco')
  })

  it('takes every line end, blank lines, and trailing spaces', () => {
    for (const end of ['\n', '\r\n', '\r']) {
      expect(codes(['!Type:Bank ', '', 'D1/ 5\'26   ', 'T-1.00', '^', '', ''].join(end))).toEqual([['!type:bank', [["D1/ 5'26", 'T-1.00']]]])
    }
  })

  it('keeps a last record without its ^, ends a record at a ! line, and ignores a ^ alone', () => {
    expect(codes('!Type:Bank\nD1/5\'26\nT-1.00')).toEqual([['!type:bank', [["D1/5'26", 'T-1.00']]]])
    expect(codes('!Type:Bank\nD1/5\'26\nT-1.00\n!Type:CCard\n^\nD1/6\'26\nT-2.00\n^')).toEqual([
      ['!type:bank', [["D1/5'26", 'T-1.00']]], ['!type:ccard', [["D1/6'26", 'T-2.00']]]
    ])
  })

  it('compares headers without case or spaces, and keeps records before any header apart', () => {
    expect(sectionName('!Type:Oth A')).toBe('!type:otha')
    expect(sectionName('!type: OthL')).toBe('!type:othl')
    expect(codes('D1/5\'26\nT-1.00\n^\n!Account\nNChequing\n^')).toEqual([['', [["D1/5'26", 'T-1.00']]], ['!account', [['NChequing']]]])
  })

  it('keeps each value’s place in the text, for the anonymiser', () => {
    const text = '!Type:Bank\r\nPCostco  \r\nMa memo\r\n^\r\n'
    const [{ records: [record] }] = parseQif(text)
    expect(record.fields.map(f => text.slice(f.start, f.end))).toEqual(['Costco', 'a memo'])
    expect(record.fields.map(f => f.line)).toEqual([2, 3])
  })

  it('keeps a code with an empty value, and unknown codes', () => {
    expect(codes('!Type:Bank\nD1/5\'26\nT-1.00\nL\nZwhatever\n^')).toEqual([['!type:bank', [["D1/5'26", 'T-1.00', 'L', 'Zwhatever']]]])
  })
})
