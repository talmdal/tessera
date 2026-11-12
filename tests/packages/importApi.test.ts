// @tessera/import-api's behaviour: the helpers format plugins use to turn a bank's text into canonical amounts and
// ISO dates, and the error helpers. A helper must refuse text it can't read unambiguously: a wrong amount or date
// imported silently is worse than a line left out with a warning.
import { describe, expect, it } from 'vitest'
import { parseAmount } from '@tessera/accounts-api'
import {
  ImportError, canonicalDecimal, fileNameStem, guessDateOrder, guessDecimal, isCanonicalDecimal, isImportError, isoDate, monthOf, toImportResult
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

describe('isoDate, with two-digit years', () => {
  it('reads them only with a pivot, as the latest year ending so that is not after it', () => {
    expect(isoDate('10/05/26', 'MDY')).toBeUndefined()
    expect(isoDate('10/05/26', 'MDY', { pivot: 2036 })).toBe('2026-10-05')
    expect(isoDate('05/10/36', 'DMY', { pivot: 2036 })).toBe('2036-10-05')
    expect(isoDate('05/10/37', 'DMY', { pivot: 2036 })).toBe('1937-10-05')
    expect(isoDate('05/10/00', 'DMY', { pivot: 2036 })).toBe('2000-10-05')
    expect(isoDate('26-10-05', 'YMD', { pivot: 2036 })).toBeUndefined()          // only a year written last
    expect(guessDateOrder(['10/05/26', '03/04/26'], { pivot: 2036 })).toEqual(['MDY', 'DMY'])
    expect(isoDate('02/29/28', 'MDY', { pivot: 2036 })).toBe('2028-02-29')          // leap years still checked
    expect(isoDate('02/29/27', 'MDY', { pivot: 2036 })).toBeUndefined()
  })

  it('still refuses years of one or three digits', () => {
    expect(isoDate('10/05/6', 'MDY', { pivot: 2036 })).toBeUndefined()
    expect(isoDate('10/05/026', 'MDY', { pivot: 2036 })).toBeUndefined()
  })
})

describe('isoDate, with months by name', () => {
  it('reads English and French names, in full or cut short, wherever they stand', () => {
    const cases: [string, string][] = [
      ['5 Oct 2026', '2026-10-05'],
      ['05-Oct-2026', '2026-10-05'],
      ['Oct 5, 2026', '2026-10-05'],
      ['October 5 2026', '2026-10-05'],
      ['2026-Oct-05', '2026-10-05'],
      ['5 octobre 2026', '2026-10-05'],
      ['5 oct. 2026', '2026-10-05'],
      ['1 févr. 2026', '2026-02-01'],
      ['14 août 2026', '2026-08-14'],
      ['3 Sept 2026', '2026-09-03'],
      ['3 déc 2026', '2026-12-03'],
      ['Oct 5, 2026 10:30 AM', '2026-10-05']
    ]
    for (const [text, iso] of cases) expect(isoDate(text, 'DMY', { monthNames: true }), text).toBe(iso)
  })

  it('lets the name say the order, whatever order is given', () => {
    expect(isoDate('Oct 5, 2026', 'DMY', { monthNames: true })).toBe('2026-10-05')
    expect(isoDate('5 Oct 2026', 'MDY', { monthNames: true })).toBe('2026-10-05')
  })

  it('reads two-digit years only with a pivot, and refuses names it can’t tell apart, or none', () => {
    expect(isoDate('5-Oct-26', 'DMY', { monthNames: true })).toBeUndefined()
    expect(isoDate('5-Oct-26', 'DMY', { monthNames: true, pivot: 2036 })).toBe('2026-10-05')
    expect(isoDate('5 jui 2026', 'DMY', { monthNames: true })).toBeUndefined()   // juin or juillet
    expect(isoDate('5 Oct 2026', 'DMY')).toBeUndefined()                          // names only when asked
    expect(isoDate('31 Feb 2026', 'DMY', { monthNames: true })).toBeUndefined()
    expect(isoDate('Oct Nov 2026', 'DMY', { monthNames: true })).toBeUndefined()
    expect(isoDate('5 Octopus 2026', 'DMY', { monthNames: true })).toBeUndefined()
  })

  it('knows a month by the start of its name when only one month starts so', () => {
    expect([monthOf('Jan'), monthOf('janv.'), monthOf('MAR'), monthOf('mai'), monthOf('Jul'), monthOf('juil'), monthOf('aout')]).toEqual([1, 1, 3, 5, 7, 7, 8])
    expect([monthOf('ju'), monthOf('jui'), monthOf('xyz'), monthOf('12')]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('guessDateOrder', () => {
  it('says which orders read every date in a file: one decides, several are ambiguous', () => {
    expect(guessDateOrder(['03/04/2026', '13/04/2026'])).toEqual(['DMY'])
    expect(guessDateOrder(['04/13/2026', '03/04/2026'])).toEqual(['MDY'])
    expect(guessDateOrder(['03/04/2026', '05/06/2026'])).toEqual(['MDY', 'DMY'])
    expect(guessDateOrder(['2026-10-05', '2026-10-31'])).toEqual(['YMD'])
    expect(guessDateOrder(['20261005'])).toEqual(['YMD'])
    expect(guessDateOrder(['13/04/2026', '04/13/2026'])).toEqual([])              // no one order reads both
    expect(guessDateOrder(['TOTAL'])).toEqual([])
  })

  it('ignores empty samples, and has nothing to say without any', () => {
    expect(guessDateOrder(['', '  ', '13/04/2026'])).toEqual(['DMY'])
    expect(guessDateOrder([])).toEqual([])
  })

  it('takes two-digit years and names only when asked, a name allowing only the order it is written in', () => {
    expect(guessDateOrder(['13/04/26'])).toEqual([])
    expect(guessDateOrder(['13/04/26'], { pivot: 2036 })).toEqual(['DMY'])
    expect(guessDateOrder(['5 Oct 2026', '12 Oct 2026'], { monthNames: true })).toEqual(['DMY'])
    expect(guessDateOrder(['Oct 5, 2026'], { monthNames: true })).toEqual(['MDY'])
    expect(guessDateOrder(['5 Oct 2026', 'Oct 5, 2026'], { monthNames: true })).toEqual([])
    expect(guessDateOrder(['5 Oct 2026', '03/04/2026'], { monthNames: true })).toEqual(['DMY'])
  })
})

describe('guessDecimal', () => {
  it('says which separators read every amount: grouping alone fits both', () => {
    expect(guessDecimal(['1,234', '12'])).toEqual(['.', ','])
    expect(guessDecimal(['1,234.56', '12.00'])).toEqual(['.'])
    expect(guessDecimal(['12,50', '1 234,56'])).toEqual([','])
    expect(guessDecimal(['12,50', '1,234.56'])).toEqual([])
    expect(guessDecimal(['', '-84.12'])).toEqual(['.'])
    expect(guessDecimal([])).toEqual([])
  })
})

describe('fileNameStem', () => {
  it('keeps what names the source, without dates, numbers, copies or the extension', () => {
    expect(fileNameStem('Checking 2026-10 (2).qif')).toBe('checking')
    expect(fileNameStem('Checking 2026-11 - Copy.qif')).toBe('checking')
    expect(fileNameStem('Visa_Card-Export.CSV')).toBe('visa-card-export')
    expect(fileNameStem('Épargne 2026.qif')).toBe('épargne')
    expect(fileNameStem('2026-10.qif')).toBe('')
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
