// @tessera/export-api's helpers: exact amounts, the encodings files need, file names every system accepts, and a
// format's options made whole. See docs/export-design.md, "The contract".
import { describe, expect, it } from 'vitest'
import { canonicalDecimal } from '@tessera/import-api'
import {
  ExportError, encodeText, isExportError, isValidOption, minorToDecimal, optionProblems, resolveOptions, safeFileName,
  toExportResult, withDecimalComma, type ExportOptionField
} from '@tessera/export-api'
import { decode } from '../../plugins/import/src/privileged/files'

describe('minorToDecimal', () => {
  it('writes minor units exactly, with the currency’s decimals', () => {
    expect(minorToDecimal(-8412, 2)).toBe('-84.12')
    expect(minorToDecimal(5, 2)).toBe('0.05')
    expect(minorToDecimal(-5, 2)).toBe('-0.05')
    expect(minorToDecimal(0, 2)).toBe('0.00')
    expect(minorToDecimal(1200, 0)).toBe('1200')
    expect(minorToDecimal(5, 3)).toBe('0.005')
    // Where floating point goes wrong: 0.1 + 0.2, and the largest amounts stored
    expect(minorToDecimal(30, 2)).toBe('0.30')
    expect(minorToDecimal(10 ** 15, 2)).toBe('10000000000000.00')
    expect(() => minorToDecimal(1.5, 2)).toThrow(RangeError)
  })

  it('always reads back as the same amount (checked on thousands of amounts)', () => {
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let i = 0; i < 5000; i++) {
      const digits = i % 4
      const minor = (next() % 2_000_000_000) - 1_000_000_000
      const text = minorToDecimal(minor, digits)
      // A canonical decimal, as import reads amounts, with exactly `digits` decimals…
      expect(canonicalDecimal(text)).toBe(text)
      expect(text.split('.')[1]?.length ?? 0).toBe(digits)
      // …whose digits are the minor units
      expect(Number(text.replace('.', ''))).toBe(minor)
    }
  })

  it('puts a comma where a file wants one', () => {
    expect(withDecimalComma('-1234.56')).toBe('-1234,56')
    expect(withDecimalComma('1200')).toBe('1200')
  })
})

describe('encodeText', () => {
  it('writes UTF-8, with a byte-order mark when asked', () => {
    expect([...encodeText('é', 'utf-8').bytes]).toEqual([0xc3, 0xa9])
    expect([...encodeText('é', 'utf-8', { bom: true }).bytes]).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9])
  })

  it('writes windows-1252, with €, curly quotes and dashes in their own bytes', () => {
    const { bytes, replaced } = encodeText('Café € “quoted” – ok', 'windows-1252')
    expect(replaced).toBe(0)
    expect([...bytes]).toContain(0x80)                       // €
    expect([...bytes]).toContain(0x93)                       // “
    expect([...bytes]).toContain(0x96)                       // –
    expect(decode(bytes, 'windows-1252')).toBe('Café € “quoted” – ok')
  })

  it('replaces what windows-1252 can’t hold by its base letter, else “?”, and counts them', () => {
    const { bytes, replaced } = encodeText('Łódź Őrség 東京', 'windows-1252')
    expect(decode(bytes, 'windows-1252')).toBe('Lódz Orség ??')
    expect(replaced).toBe(5)
  })

  it('counts a character outside the basic plane once, and writes a replacement longer than what it replaces', () => {
    const { bytes, replaced } = encodeText('a😀b\ud800c ﬁ', 'windows-1252')
    expect(decode(bytes, 'windows-1252')).toBe('a?b?c fi')
    expect(replaced).toBe(3)
  })
})

describe('safeFileName', () => {
  it('gives a name Windows, macOS and Linux all accept', () => {
    expect(safeFileName('Chequing 2026-01-01 to 2026-10-31')).toBe('Chequing 2026-01-01 to 2026-10-31')
    expect(safeFileName('A/B: "C" <d>?*|')).toBe('A-B- -C- -d----')
    expect(safeFileName('  Trailing dots... ')).toBe('Trailing dots')
    expect(safeFileName('CON')).toBe('_CON')
    expect(safeFileName('nul.csv')).toBe('_nul.csv')
    expect(safeFileName('')).toBe('Export')
    expect(safeFileName('x'.repeat(300))).toHaveLength(150)
  })
})

describe('options', () => {
  const fields: ExportOptionField[] = [
    { kind: 'choice', key: 'dates', label: 'Dates', default: 'iso', options: [{ value: 'iso', label: 'ISO' }, { value: 'mdy', label: 'US' }] },
    { kind: 'boolean', key: 'guard', label: 'Guard', default: true },
    { kind: 'text', key: 'bank', label: 'Bank number', default: '', required: true, maxLength: 9 }
  ]

  it('makes a format’s options whole: valid values kept, defaults for the rest, unknown keys dropped', () => {
    expect(resolveOptions(fields, undefined)).toEqual({ dates: 'iso', guard: true, bank: '' })
    expect(resolveOptions(fields, { dates: 'mdy', guard: false, bank: '004', other: 1 })).toEqual({ dates: 'mdy', guard: false, bank: '004' })
    expect(resolveOptions(fields, { dates: 'dmy', guard: 'yes', bank: '0123456789' })).toEqual({ dates: 'iso', guard: true, bank: '' })
    expect(isValidOption(fields[0], 'mdy')).toBe(true)
    expect(isValidOption(fields[2], 1)).toBe(false)
  })

  it('says which required text is missing', () => {
    expect(optionProblems(fields, { dates: 'iso', guard: true, bank: '  ' })).toEqual(['Enter the bank number.'])
    expect(optionProblems(fields, { dates: 'iso', guard: true, bank: '004' })).toEqual([])
  })
})

describe('errors', () => {
  it('are known by their shape, so each plugin’s bundled copy is recognised', async () => {
    expect(isExportError(new ExportError('INVALID', 'no'))).toBe(true)
    expect(isExportError({ name: 'ExportError', code: 'BUSY', message: 'wait' })).toBe(true)
    expect(isExportError(new Error('no'))).toBe(false)
    expect(await toExportResult(async () => { throw new ExportError('NOT_FOUND', 'gone') })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } })
    expect(await toExportResult(async () => 3)).toEqual({ ok: true, value: 3 })
    await expect(toExportResult(async () => { throw new TypeError('a bug') })).rejects.toThrow('a bug')
  })
})
