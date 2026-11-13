// @vitest-environment node
// The anonymiser's QIF handler (scripts/anonymise/qif.ts): values replaced by their codes, every other byte kept.
// Headers, codes, dates, N, C and Tessera's starter categories stay; payees, memos, addresses, account names (the same
// way everywhere, transfers too), other categories and classes are replaced; amounts change, and a split still adds up
// to its total. Read back by the QIF format, the files give the same statements, lines, dates and kinds.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ParseContext, ParseResult } from '@tessera/import-api'
import { anonymise, check, describeCounts, type InputFile } from '../../scripts/anonymise/index'
import { shiftQifDate } from '../../scripts/anonymise/qif'
import { createQifFormat } from '../../plugins/format-qif/src/privileged/index'
import { parseQif, valueOf } from '../../plugins/format-qif/src/privileged/qif'
import { importFile, SAMPLES } from '../helpers/importFile'

const TODAY = new Date('2026-11-06T12:00:00Z')
const PIVOT = 2036
const input = (name: string): InputFile => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(SAMPLES, name))) })
const text = (name: string) => fs.readFileSync(path.join(SAMPLES, name), 'latin1')
const run = (names: string[], options: Parameters<typeof anonymise>[1] = {}) => anonymise(names.map(input), { seed: 5, today: TODAY, ...options }).outputs
const bytes = (body: string) => new TextEncoder().encode(body)

/** The file's structure: its headers, and each record's codes, in order. */
const skeleton = (body: string) => parseQif(body).map(s => [s.header, s.records.map(r => r.fields.map(f => f.code).join(''))])
/** The values of one code in transaction sections (`!Type:…` but lists), in file order. */
const LISTS = new Set(['!account', '!type:cat', '!type:class', '!type:memorized'])
const values = (body: string, code: string) => parseQif(body).filter(s => !LISTS.has(s.name))
  .flatMap(s => s.records.flatMap(r => r.fields.filter(f => f.code === code).map(f => f.value)))
/** As the QIF format reads it, the dates answered as offered. */
async function read(name: string, body: string): Promise<ParseResult> {
  const memory = new Map<string, unknown>()
  const context = {
    memory: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => { memory.set(k, v) } },
    prompt: async (_: string, i: { dates?: { value: string } }) => ({ kind: 'options', dateOrder: i.dates?.value })
  } as unknown as ParseContext
  return (await createQifFormat({ now: () => TODAY }).parse(importFile(name, body), context)) as ParseResult
}

describe('anonymising QIF files', () => {
  const [money, quicken] = run(['maple-trust-chequing-2026-09.qif', 'household-quicken-export.qif'])

  it('leaves nothing personal: payees, memos and account names replaced, and the scan finds nothing', () => {
    expect([money.error, quicken.error]).toEqual([undefined, undefined])
    expect(money.findings).toEqual([])
    expect(quicken.findings).toEqual([])
    for (const gone of ['Landlord', 'Costco', 'Loblaws', 'Northern', 'Hydro', 'Maple', 'Shell', 'Horton']) expect(money.text, gone).not.toContain(gone)
    for (const gone of ['Everyday', 'Harbourview', 'Metro', 'Bytown', 'Northwind', 'Joint', 'lunch', 'Paint', 'Household', 'Wipers']) expect(quicken.text, gone).not.toContain(gone)
    expect(describeCounts(money.counts)).toBe('18 payees, 5 memos, 18 other text values, 20 amounts replaced')
  })

  it('keeps the dialect: headers, codes, dates, numbers, cleared marks and line ends, byte for byte', () => {
    for (const [output, name] of [[money, 'maple-trust-chequing-2026-09.qif'], [quicken, 'household-quicken-export.qif']] as const) {
      const original = text(name)
      expect(skeleton(output.text)).toEqual(skeleton(original))
      for (const code of ['D', 'N', 'C', 'K']) expect(values(output.text, code), code).toEqual(values(original, code))
      expect((output.text.match(/\r\n/g) ?? []).length).toBe((original.match(/\r\n/g) ?? []).length)
    }
    expect(money.text.startsWith('!Type:Bank \r\nD8/31\'26\r\n') || money.text.startsWith('!Type:Bank \nD8/31\'26\n')).toBe(true)
  })

  it('keeps Tessera’s starter categories, and replaces the rest and classes, part by part', () => {
    expect(values(money.text, 'L')).toEqual(expect.arrayContaining(['Housing:Rent', 'Salary', 'Food:Groceries', 'Utilities:Electricity', 'Bank fees']))
    const split = values(money.text, 'S')
    expect(split[0]).toBe('Food:Groceries')
    expect(split[1]).toMatch(/^[A-Z][a-z]+$/)                                          // 'Household', made up
    expect(values(quicken.text, 'L').find(l => l.startsWith('Food:Dining out/'))).toMatch(/^Food:Dining out\/[A-Z][a-z]+$/)
    expect(values(quicken.text, 'S')).toContain('Transportation:Car maintenance')
  })

  it('replaces an account’s name the same way wherever it appears: its !Account, and transfers to it', () => {
    const names = parseQif(quicken.text).filter(s => s.name === '!account').flatMap(s => s.records.map(r => valueOf(r, 'N')))
    expect(names).toHaveLength(8)                                                      // the list, then each account
    const transfers = values(quicken.text, 'L').filter(l => l.startsWith('['))
    for (const transfer of transfers) expect(names).toContain(transfer.slice(1, -1))
    expect(values(money.text, 'L')[0]).toMatch(/^\[[A-Z][a-z]+ [A-Z][a-z]+ Chequing\]$/)
  })

  it('changes amounts, and a split still adds up to its total', () => {
    expect(values(money.text, 'T')).not.toEqual(values(text('maple-trust-chequing-2026-09.qif'), 'T'))
    for (const output of [money, quicken]) {
      for (const section of parseQif(output.text)) {
        for (const record of section.records) {
          const parts = record.fields.filter(f => f.code === '$').map(f => Math.round(Number(f.value.replace(/,/g, '')) * 100))
          if (parts.length === 0 || section.name === '!account') continue
          expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(Number(valueOf(record, 'T')!.replace(/,/g, '')) * 100))
          expect(valueOf(record, 'U') ?? valueOf(record, 'T')).toBe(valueOf(record, 'T'))
        }
      }
    }
  })

  it('reads back as the same statements: accounts, lines, dates, kinds, numbers and signs', async () => {
    for (const [output, name] of [[money, 'maple-trust-chequing-2026-09.qif'], [quicken, 'household-quicken-export.qif']] as const) {
      const before = await read(name, text(name))
      const after = await read(name, output.text)
      expect(after.warnings).toEqual((before.warnings ?? []).map(w => ({ ...w, message: expect.any(String) })))
      expect(after.statements.map(s => [s.account.type, s.lines.length])).toEqual(before.statements.map(s => [s.account.type, s.lines.length]))
      const shape = (r: ParseResult) => r.statements.flatMap(s => s.lines.map(l => [l.date, l.kind, l.number, Math.sign(Number(l.amount))]))
      expect(shape(after)).toEqual(shape(before))
    }
  })

  it('replaces a security’s name, and keeps quantities and prices', () => {
    expect(values(quicken.text, 'Y')).not.toContain('Maple Index Fund')
    expect(values(quicken.text, 'Q')).toEqual(['10'])
    expect(values(quicken.text, 'I')).toEqual(['25.00'])
  })

  it('moves dates by whole weeks when asked, written as Quicken writes them', () => {
    const [moved] = run(['maple-trust-chequing-2026-09.qif'], { shiftWeeks: 1 })
    expect(values(moved.text, 'D').slice(0, 3)).toEqual(["9/ 7'26", "9/ 9'26", "9/11'26"])
    expect(shiftQifDate("9/26'26", 'MDY', 7, PIVOT)).toBe("10/ 3'26")
    expect(shiftQifDate("12/30'26", 'MDY', 7, PIVOT)).toBe("1/ 6'27")
    expect(shiftQifDate('09/26/2026', 'MDY', 7, PIVOT)).toBe('10/03/2026')
    expect(shiftQifDate('26.09.2026', 'DMY', 7, PIVOT)).toBe('03.10.2026')
    expect(shiftQifDate('2026-09-26', 'MDY', 7, PIVOT)).toBe('2026-10-03')
  })

  it('keeps amounts when asked', () => {
    const [kept] = run(['household-quicken-export.qif'], { keepAmounts: true })
    expect(values(kept.text, 'T')).toEqual(values(text('household-quicken-export.qif'), 'T'))
    expect(values(kept.text, '$')).toEqual(values(text('household-quicken-export.qif'), '$'))
  })
})

describe('checking QIF files', () => {
  it('finds what looks personal in a raw QIF, and in an anonymised one only where the anonymiser keeps the original', () => {
    const raw = '!Type:Bank\nD1/5/26\nT-1.00\nPE-TRANSFER jane.doe@example.com\nN4111 1111 1111 1111\n^\n'
    expect(check([{ name: 'x.qif', bytes: bytes(raw) }])[0].findings.map(f => f.kind)).toEqual(['email address', 'card number'])
    const [output] = run(['household-quicken-export.qif'])
    expect(check([{ name: output.outputName, bytes: bytes(output.text) }])[0].findings).toEqual([])
    const planted = output.text.replace(/^CR(?=\r?$)/m, 'C613-555-0199')                        // a kept field
    expect(check([{ name: output.outputName, bytes: bytes(planted) }])[0].findings.map(f => f.kind)).toEqual(['phone number'])
  })

  it('refuses to write an output with something personal left where it keeps the original, saying which field', () => {
    const [output] = anonymise([{ name: 'z.qif', bytes: bytes('!Type:Bank\nD1/5/26\nT-1.00\nPCoffee\nC613-555-0199\n^\n') }], { seed: 1, today: TODAY }).outputs
    expect(output.findings.map(f => [f.kind, f.where, f.shape])).toEqual([['phone number', 'the C field (cleared)', '999-999-9999']])
  })
})

describe('what a Money export keeps in its N field, and the starter categories', () => {
  it('replaces a reference in N with one of its shape, keeping cheque numbers and words', () => {
    const body = '!Type:Bank\nD1/5/26\nT-1.00\nNCA12345678\nPE-Transfer\n^\nD1/6/26\nT-2.00\nN101\nPLandlord\n^\nD1/7/26\nT-3.00\nNATM\nPCash\n^\nD1/8/26\nT-4.00\nNTo Print\nPRent\n^\n'
    const [output] = anonymise([{ name: 'money.qif', bytes: bytes(body) }], { seed: 3, today: TODAY }).outputs
    expect(output.findings).toEqual([])
    const numbers = values(output.text, 'N')
    expect(numbers[0]).toMatch(/^[A-Z]{2}\d{8}$/)
    expect(numbers[0]).not.toBe('CA12345678')
    expect(numbers.slice(1)).toEqual(['101', 'ATM', 'To Print'])
    expect(describeCounts(output.counts)).toMatch(/\b1 id\b/)
  })

  it('keeps a starter category’s words in payees too, so the kept category gives nothing away', () => {
    const body = '!Type:Bank\nD1/5/26\nT-1.00\nPFresh Groceries Market\nLFood:Groceries\n^\nD1/6/26\nT-2.00\nPDental Clinic Smith\nLHealth:Dental\n^\n'
    const [output] = anonymise([{ name: 'money.qif', bytes: bytes(body) }], { seed: 3, today: TODAY }).outputs
    expect(output.findings).toEqual([])
    const payees = values(output.text, 'P')
    expect(payees[0]).toMatch(/^[A-Z][a-z]+ Groceries [A-Z][a-z]+$/)
    expect(payees[1]).toMatch(/^Dental [A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(output.text).not.toMatch(/Fresh|Market|Smith|Clinic/)
  })
})
