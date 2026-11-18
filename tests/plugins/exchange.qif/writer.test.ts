// @vitest-environment node
// The QIF writer: both flavours, the whole-book form, splits and transfers, and that what it writes reads back.
import { describe, expect, it } from 'vitest'
import type { ExchangeDocument } from '@tessera/exchange-api'
import { QIF_FORMAT, readQif, writeQif } from '../../../plugins/exchange.qif/src/privileged/index'
import { qifAmount, qifDate } from '../../../plugins/exchange.qif/src/privileged/writer'

const document = (): ExchangeDocument => ({
  formatId: QIF_FORMAT,
  statements: [
    {
      account: { name: 'Chequing', type: 'chequing' },
      transactions: [
        { date: '2026-10-03', amount: -14200, payee: 'Hydro Ottawa Electricity Co', memo: 'November bill', number: '1042', category: 'Utilities : Electricity', cleared: 'cleared' },
        { date: '2026-10-10', amount: -50000, payee: 'Transfer', transferAccount: 'Savings' },
        { date: '2026-10-20', amount: -125000, payee: 'Rideau Property', splits: [{ amount: -120000, category: 'Housing : Rent', memo: 'Rent' }, { amount: -5000, category: 'Housing : Parking' }] }
      ]
    },
    { account: { name: 'Savings', type: 'savings' }, transactions: [{ date: '2026-10-10', amount: 50000, transferAccount: 'Chequing', cleared: 'reconciled' }] }
  ],
  categories: [{ path: 'Utilities : Electricity', kind: 'expense' }, { path: 'Salary', kind: 'income' }],
  unsupported: [],
  warnings: []
})

const text = (bytes: Uint8Array) => new TextDecoder('windows-1252').decode(bytes)

describe('writing QIF', () => {
  it('writes dates and amounts the way Quicken and Money do', () => {
    expect(qifDate('2026-10-03', 'microsoft')).toBe('10/3/2026')
    expect(qifDate('2026-10-03', 'standard')).toBe("10/3'26")
    expect(qifDate('1999-12-31', 'standard')).toBe('12/31/99')
    expect(qifAmount(-123456)).toBe('-1,234.56')
    expect(qifAmount(5)).toBe('0.05')
  })

  it('writes the whole-book form: the category list, an !Account block per account, transfers as [Account]', () => {
    const out = text(writeQif(document(), 'microsoft'))
    expect(out.startsWith('!Type:Cat\r\nNUtilities:Electricity\r\nE\r\n^\r\nNSalary\r\nI\r\n^\r\n!Account\r\nNChequing\r\nTBank\r\n^\r\n!Type:Bank\r\n')).toBe(true)
    expect(out).toContain('\r\nL[Savings]\r\n')
    expect(out).toContain('\r\n!Account\r\nNSavings\r\nTBank\r\n^\r\n!Type:Bank\r\n')
    expect(out).toContain('\r\nPHydro Ottawa Electricity Co\r\n')
    expect(out).toContain('\r\nC*\r\n')
    expect(out).toContain('\r\nCX\r\n')
    expect(out).toContain('\r\nSHousing:Rent\r\nERent\r\n$-1,200.00\r\nSHousing:Parking\r\n$-50.00\r\n^')
    expect(out).toMatch(/\r\nT-142\.00\r\nU-142\.00\r\n/)
  })

  it('cuts names at fifteen and uses apostrophe dates in the standard flavour', () => {
    const out = text(writeQif(document(), 'standard'))
    expect(out).toContain("\r\nD10/3'26\r\n")
    expect(out).toContain('\r\nPHydro Ottawa El\r\n')
    expect(out).toContain('\r\nLUtilities:Electricity\r\n')   // each segment within fifteen already
    for (const line of out.split('\r\n').filter(l => /^[PME]/.test(l))) expect(line.length - 1).toBeLessThanOrEqual(15)
  })

  it('writes a single unnamed statement as a bare !Type list', () => {
    const bare: ExchangeDocument = { formatId: QIF_FORMAT, statements: [{ account: {}, transactions: [{ date: '2026-10-03', amount: -100 }] }], unsupported: [], warnings: [] }
    expect(text(writeQif(bare)).startsWith('!Type:Bank\r\nD10/3/2026\r\n')).toBe(true)
  })

  it('reads back what it wrote, both flavours', async () => {
    for (const flavour of ['microsoft', 'standard'] as const) {
      const back = await readQif(writeQif(document(), flavour), { formatId: QIF_FORMAT })
      expect(back.statements.map(s => s.account.name)).toEqual(['Chequing', 'Savings'])
      expect(back.statements[0].transactions.map(t => t.amount)).toEqual([-14200, -50000, -125000])
      expect(back.statements[0].transactions[1].transferAccount).toBe('Savings')
      expect(back.statements[0].transactions[2].splits).toHaveLength(2)
      expect(back.statements[0].transactions[0].cleared).toBe('cleared')
      expect(back.categories).toEqual([{ path: 'Utilities : Electricity', kind: 'expense' }, { path: 'Salary', kind: 'income' }])
      expect(back.statements[0].transactions[0].payee).toBe(flavour === 'standard' ? 'Hydro Ottawa El' : 'Hydro Ottawa Electricity Co')
    }
  })

  it('writes Windows-1252, with a question mark for what the page cannot hold', () => {
    const doc: ExchangeDocument = { formatId: QIF_FORMAT, statements: [{ account: {}, transactions: [{ date: '2026-10-03', amount: -100, payee: 'Café 漢' }] }], unsupported: [], warnings: [] }
    const bytes = writeQif(doc)
    expect([...bytes.subarray(bytes.indexOf(0x50))].slice(0, 7)).toEqual([0x50, 0x43, 0x61, 0x66, 0xe9, 0x20, 0x3f])
  })
})

describe('values the writer must keep on one line', () => {
  // A QIF record is one field per line: a line break in a value used to end the field and start new ones.
  it('flattens a line break in a payee or memo, so it cannot end the record early', () => {
    const doc = {
      formatId: 'exchange-qif.qif', unsupported: [], warnings: [],
      statements: [{ account: {}, transactions: [{ date: '2026-10-15', amount: -100, payee: 'A\nT-999.00\n^', memo: 'two\r\nlines' }] }]
    }
    const text = new TextDecoder('windows-1252').decode(writeQif(doc, 'microsoft'))
    expect(text).toContain('PA T-999.00 ^')
    expect(text).toContain('Mtwo lines')
    expect(text).not.toMatch(/^T-999\.00$/m)
  })
})

describe('years the two-digit forms cannot say', () => {
  it('writes a year before 1950 in full in the standard flavour, so it is not read back as 20xx', () => {
    expect(qifDate('1949-05-01', 'standard')).toBe('5/1/1949')
    expect(qifDate('1950-05-01', 'standard')).toBe("5/1/50")
    expect(qifDate('2026-05-01', 'standard')).toBe("5/1'26")
    expect(qifDate('2100-05-01', 'standard')).toBe('5/1/2100')
  })
})
