// @tessera/import-api's behaviour: the helpers format plugins use to turn a bank's text into canonical amounts and
// ISO dates, and the error helpers. A helper must refuse text it can't read unambiguously: a wrong amount or date
// imported silently is worse than a line left out with a warning.
import { describe, expect, it } from 'vitest'
import { parseAmount } from '@tessera/accounts-api'
import {
  ImportError, canonicalDecimal, isCanonicalDecimal, isImportError, isoDate, toImportResult
} from '@tessera/import-api'

describe('canonicalDecimal', () => {
  it('reads plain and grouped amounts with a decimal point', () => {
    const cases: [string, string][] = [
      ['84.12', '84.12'],
      ['-84.12', '-84.12'],
      ['1,234.56', '1234.56'],
      ['1,234,567.89', '1234567.89'],
      ['12,34,567.00', '1234567.00'],     // lakh grouping
      ['1234', '1234'],
      ['1,234', '1234'],
      ['0.5', '0.5'],
      ['.5', '0.5'],
      ['12.', '12'],
      ['007.50', '7.50'],
      ['+12.00', '12.00'],
      ['  42.00  ', '42.00']
    ]
    for (const [text, expected] of cases) expect(canonicalDecimal(text), text).toBe(expected)
  })

  it('reads amounts with a decimal comma', () => {
    const cases: [string, string][] = [
      ['84,12', '84.12'],
      ['1.234,56', '1234.56'],
      ['-1.234.567,89', '-1234567.89'],
      ['1 234,56', '1234.56'],
      ['1\u00a0234,56', '1234.56'],       // no-break space
      ['1\u202f234,56', '1234.56']        // narrow no-break space, as French locales write it
    ]
    for (const [text, expected] of cases) expect(canonicalDecimal(text, { decimal: ',' }), text).toBe(expected)
  })

  it('understands the ways banks write negatives', () => {
    expect(canonicalDecimal('(12.00)')).toBe('-12.00')
    expect(canonicalDecimal('12.00-')).toBe('-12.00')
    expect(canonicalDecimal('−12.00')).toBe('-12.00')      // U+2212 minus sign
    expect(canonicalDecimal('( 1,234.56 )')).toBe('-1234.56')
  })

  it('drops a currency sign or code before or after the number', () => {
    expect(canonicalDecimal('$12.00')).toBe('12.00')
    expect(canonicalDecimal('-$12.00')).toBe('-12.00')
    expect(canonicalDecimal('$-12.00')).toBe('-12.00')
    expect(canonicalDecimal('12.00 CAD')).toBe('12.00')
    expect(canonicalDecimal('CAD 1,200.00')).toBe('1200.00')
    expect(canonicalDecimal('1.200,00 €', { decimal: ',' })).toBe('1200.00')
    expect(canonicalDecimal("1'234.56")).toBe('1234.56')   // Swiss grouping
  })

  it('keeps trailing zeros, for the import manager to check against the currency', () => {
    expect(canonicalDecimal('-12.3400')).toBe('-12.3400')
    expect(canonicalDecimal('1200')).toBe('1200')
  })

  it('never writes a negative zero', () => {
    expect(canonicalDecimal('-0.00')).toBe('0.00')
    expect(canonicalDecimal('(0)')).toBe('0')
    expect(canonicalDecimal('000')).toBe('0')
  })

  it('refuses a decimal separator that looks wrong, instead of misreading it', () => {
    // A European amount read as if '.' were the decimal point: irregular grouping, so not 1250
    expect(canonicalDecimal('12,50')).toBeUndefined()
    expect(canonicalDecimal('1,2345.00')).toBeUndefined()
    expect(canonicalDecimal('1.234.56')).toBeUndefined()
    // And the other way round
    expect(canonicalDecimal('1,234.56', { decimal: ',' })).toBeUndefined()
    // Spaces and apostrophes group by the same rule
    expect(canonicalDecimal('12 50')).toBeUndefined()
    expect(canonicalDecimal('1 2345,00', { decimal: ',' })).toBeUndefined()
  })

  it('refuses what is not an amount', () => {
    for (const text of ['', '   ', '-', '.', ',', 'abc', 'abc12', '12abc', '1e5', '0x10', '12.34.56', '--5', '12 .00', 'CR']) {
      expect(canonicalDecimal(text), JSON.stringify(text)).toBeUndefined()
    }
  })

  it('produces exactly what accounts reads back, with no floating point', () => {
    for (const text of ['84.12', '-1,234.56', '(0.10)', '0.20', '9,007,199,254,740.99']) {
      const canonical = canonicalDecimal(text)!
      expect(isCanonicalDecimal(canonical), canonical).toBe(true)
      const parsed = parseAmount(canonical, 'CAD', 'en-US')
      expect(parsed.ok, canonical).toBe(true)
    }
    expect(parseAmount(canonicalDecimal('(0.10)')!, 'CAD', 'en-US')).toEqual({ ok: true, value: -10 })
  })
})

describe('isCanonicalDecimal', () => {
  it('accepts only the canonical form', () => {
    for (const text of ['0', '0.00', '12', '-12.5', '1234567.89']) expect(isCanonicalDecimal(text), text).toBe(true)
    for (const text of ['', '-0', '-0.00', '012', '1,234', '12.', '.5', '+1', ' 1', '1e5', 'NaN']) {
      expect(isCanonicalDecimal(text), JSON.stringify(text)).toBe(false)
    }
    expect(isCanonicalDecimal(12)).toBe(false)
    expect(isCanonicalDecimal(undefined)).toBe(false)
  })
})

describe('isoDate', () => {
  it('reads each order', () => {
    expect(isoDate('2026-10-05', 'YMD')).toBe('2026-10-05')
    expect(isoDate('2026/10/5', 'YMD')).toBe('2026-10-05')
    expect(isoDate('20261005', 'YMD')).toBe('2026-10-05')
    expect(isoDate('10/05/2026', 'MDY')).toBe('2026-10-05')
    expect(isoDate('1/5/2026', 'MDY')).toBe('2026-01-05')
    expect(isoDate('05/10/2026', 'DMY')).toBe('2026-10-05')
    expect(isoDate('05.10.2026', 'DMY')).toBe('2026-10-05')
    expect(isoDate('5-10-2026', 'DMY')).toBe('2026-10-05')
  })

  it('gives the same date a different meaning in each order, as it should', () => {
    expect(isoDate('03/04/2026', 'MDY')).toBe('2026-03-04')
    expect(isoDate('03/04/2026', 'DMY')).toBe('2026-04-03')
  })

  it('ignores a time of day, without shifting the date', () => {
    expect(isoDate('2026-10-05T23:30:00Z', 'YMD')).toBe('2026-10-05')
    expect(isoDate('2026-10-05T23:30:00-05:00', 'YMD')).toBe('2026-10-05')
    expect(isoDate('2026-10-05 00:15', 'YMD')).toBe('2026-10-05')
    expect(isoDate('10/05/2026 11:59 PM', 'MDY')).toBe('2026-10-05')
  })

  it('refuses two-digit years: the century would be a guess', () => {
    expect(isoDate('10/05/26', 'MDY')).toBeUndefined()
    expect(isoDate('26-10-05', 'YMD')).toBeUndefined()
  })

  it('refuses dates that do not exist, or are in another order', () => {
    for (const [text, order] of [
      ['2026-02-30', 'YMD'], ['2026-13-01', 'YMD'], ['13/05/2026', 'MDY'], ['05/13/2026', 'DMY'], ['2025-02-29', 'YMD'],
      ['2026-10-05', 'MDY'], ['2026-10-05', 'DMY'], ['10/05/2026', 'YMD'], ['2026105', 'YMD'], ['202610050', 'YMD']
    ] as const) {
      expect(isoDate(text, order), `${text} ${order}`).toBeUndefined()
    }
    expect(isoDate('2024-02-29', 'YMD')).toBe('2024-02-29')   // a leap year
  })

  it('refuses what is not a date', () => {
    for (const text of ['', 'yesterday', 'Oct 5, 2026', '2026-10', '2026-10-05-01', '2026-10-05T', '10/05/2026 noon']) {
      expect(isoDate(text, 'YMD'), text).toBeUndefined()
      expect(isoDate(text, 'MDY'), text).toBeUndefined()
    }
  })
})

describe('import errors', () => {
  it('are recognised by shape, so a copy from another plugin counts', () => {
    expect(isImportError(new ImportError('UNREADABLE', 'Not an OFX file.'))).toBe(true)
    expect(isImportError({ name: 'ImportError', code: 'TOO_LARGE', message: 'Too large' })).toBe(true)
    expect(isImportError(new Error('boom'))).toBe(false)
    expect(isImportError({ name: 'AccountsError', code: 'NOT_FOUND', message: 'x' })).toBe(false)
    expect(isImportError(null)).toBe(false)
  })

  it('become results for views, while bugs are still thrown', async () => {
    await expect(toImportResult(async () => 3)).resolves.toEqual({ ok: true, value: 3 })
    await expect(toImportResult(async () => { throw new ImportError('BUSY', 'Another import is running.') }))
      .resolves.toEqual({ ok: false, error: { code: 'BUSY', message: 'Another import is running.' } })
    await expect(toImportResult(async () => { throw new TypeError('bug') })).rejects.toThrow('bug')
  })
})
