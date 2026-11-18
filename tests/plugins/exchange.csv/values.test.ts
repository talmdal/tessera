// @vitest-environment node
// CSV's dates and amounts, which is where the format's real ambiguity lives: no declaration of either, so both
// are read against the profile and both must refuse rather than guess.
import { describe, expect, it } from 'vitest'
import { expandYear, parseCsvAmount, parseCsvDate } from '../../../plugins/exchange.csv/src/privileged/values'

const minor = (raw: string, decimal: '.' | ',' = '.') => {
  const result = parseCsvAmount(raw, decimal)
  return result.ok ? result.minor : undefined
}

describe('parseCsvDate', () => {
  it('reads a year-first date whatever the profile says, because it is unambiguous', () => {
    for (const format of ['ISO', 'YMD', 'DMY', 'MDY']) {
      expect(parseCsvDate('2026-10-15', format)).toBe('2026-10-15')
    }
    expect(parseCsvDate('2026/10/15', 'ISO')).toBe('2026-10-15')
    expect(parseCsvDate('2026.10.15', 'ISO')).toBe('2026-10-15')
  })

  it('decides the two ambiguous positions from the profile, and the same text means two different days', () => {
    expect(parseCsvDate('03/05/2026', 'DMY')).toBe('2026-05-03')
    expect(parseCsvDate('03/05/2026', 'MDY')).toBe('2026-03-05')
  })

  it('expands a two-digit year the way every finance program does', () => {
    expect(expandYear(26)).toBe(2026)
    expect(expandYear(49)).toBe(2049)
    expect(expandYear(50)).toBe(1950)
    expect(expandYear(99)).toBe(1999)
    expect(parseCsvDate('15/10/26', 'DMY')).toBe('2026-10-15')
  })

  it('accepts a month name under any setting, because the name settles what the order would have decided', () => {
    expect(parseCsvDate('3-May-2026', 'MDY')).toBe('2026-05-03')
    expect(parseCsvDate('3 May 2026', 'DMY')).toBe('2026-05-03')
    expect(parseCsvDate('May 3, 2026', 'DMY')).toBe('2026-05-03')
    expect(parseCsvDate('15-SEP-26', 'MDY')).toBe('2026-09-15')
  })

  it('ignores a time after the date, which some exports write', () => {
    expect(parseCsvDate('2026-10-15 00:00:00', 'ISO')).toBe('2026-10-15')
    expect(parseCsvDate('15/10/2026 14:32', 'DMY')).toBe('2026-10-15')
  })

  it('refuses a date that is not on the calendar, rather than rolling it over', () => {
    // The case that matters: a DMY profile pointed at an MDY column must fail loudly, not silently
    // turn 31 February into 3 March.
    expect(parseCsvDate('31/02/2026', 'DMY')).toBeUndefined()
    expect(parseCsvDate('2026-02-30', 'ISO')).toBeUndefined()
    expect(parseCsvDate('13/13/2026', 'DMY')).toBeUndefined()
  })

  it('refuses anything that is not a date at all', () => {
    expect(parseCsvDate(undefined, 'ISO')).toBeUndefined()
    expect(parseCsvDate('', 'ISO')).toBeUndefined()
    expect(parseCsvDate('Closing balance', 'ISO')).toBeUndefined()
    expect(parseCsvDate('n/a', 'DMY')).toBeUndefined()
  })

  it('falls back on a pattern’s letter order when it is given one rather than a named order', () => {
    expect(parseCsvDate('03/05/2026', 'dd-MM-yyyy')).toBe('2026-05-03')
    expect(parseCsvDate('03/05/2026', 'MM/dd/yyyy')).toBe('2026-03-05')
    expect(parseCsvDate('2026/05/03', 'yyyy-MM-dd')).toBe('2026-05-03')
  })
})

describe('parseCsvAmount', () => {
  it('reads the ordinary signed shapes', () => {
    expect(minor('12.34')).toBe(1234)
    expect(minor('-12.34')).toBe(-1234)
    expect(minor('+12.34')).toBe(1234)
    expect(minor('0.00')).toBe(0)
  })

  it('reads the shapes banks and spreadsheets write for a negative', () => {
    expect(minor('(12.34)')).toBe(-1234)
    expect(minor('12.34-')).toBe(-1234)
    expect(minor('12.34 DR')).toBe(-1234)
    expect(minor('CR 12.34')).toBe(1234)
  })

  it('strips grouping and currency without going through parseFloat', () => {
    expect(minor('$1,234.56')).toBe(123456)
    expect(minor('-$1,234.56')).toBe(-123456)
    expect(minor('1,234,567.89')).toBe(123456789)
    expect(minor('£1 234.56')).toBe(123456)
  })

  it('reads a European figure against a comma decimal, and does not lose three orders of magnitude', () => {
    // The whole reason this is read as text: parseFloat('1.234,56') is 1.234.
    expect(minor('1.234,56', ',')).toBe(123456)
    expect(minor('-1.234,56', ',')).toBe(-123456)
    expect(minor('1234,56', ',')).toBe(123456)
  })

  it('treats whichever separator the profile did not name as grouping, and never guesses between them', () => {
    expect(minor('1,234')).toBe(123400)
    expect(minor('1.234', ',')).toBe(123400)
    // The same text, read against the other profile, is a fraction — which is the point of asking.
    expect(minor('1.234')).toBe(123)
    expect(minor('1,234', ',')).toBe(123)
  })

  it('refuses a figure with two decimal points, which is a misread column', () => {
    expect(minor('1.2.3')).toBeUndefined()
  })

  it('pads the fraction to minor units, and rounds one that is too long', () => {
    expect(minor('12.3')).toBe(1230)
    expect(minor('12')).toBe(1200)
    expect(minor('12.345')).toBe(1235)
  })

  it('refuses a cell that is not a number', () => {
    expect(minor('')).toBeUndefined()
    expect(minor(undefined as unknown as string)).toBeUndefined()
    expect(minor('n/a')).toBeUndefined()
    expect(minor('--')).toBeUndefined()
  })

  it('never produces a negative zero, which would print as “-0.00”', () => {
    expect(Object.is(minor('-0.00'), -0)).toBe(false)
    expect(minor('-0.00')).toBe(0)
  })
})

describe('parseCsvAmount: what it must not misread', () => {
  // Each of these was read with the wrong sign or magnitude, silently, before review.
  const minorOf = (raw: string, decimal: '.' | ',' = '.') => {
    const result = parseCsvAmount(raw, decimal)
    return result.ok ? result.minor : undefined
  }

  it('reads a DR or CR touching the figure the same as one set apart from it', () => {
    expect(minorOf('12.34DR')).toBe(-1234)
    expect(minorOf('12.34 DR')).toBe(-1234)
    expect(minorOf('DR 12.34')).toBe(-1234)
    expect(minorOf('12.34CR')).toBe(1234)
  })

  it('reads a Unicode minus or an en dash as a minus, not as noise', () => {
    expect(minorOf('−12.34')).toBe(-1234)
    expect(minorOf('–12.34')).toBe(-1234)
  })

  it('refuses a cell with letters it does not understand, rather than dropping them', () => {
    expect(minorOf('5e3')).toBeUndefined()
    expect(minorOf('abc12')).toBeUndefined()
    expect(minorOf('12.34 approx')).toBeUndefined()
  })

  it('still accepts a currency code or symbol beside the figure', () => {
    expect(minorOf('USD 12.34')).toBe(1234)
    expect(minorOf('12.34 CAD')).toBe(1234)
    expect(minorOf('£1 234.56')).toBe(123456)
    expect(minorOf('1 234,56', ',')).toBe(123456)
  })

  it('rounds extra decimals half away from zero rather than cutting them', () => {
    expect(minorOf('12.345')).toBe(1235)
    expect(minorOf('12.344')).toBe(1234)
    expect(minorOf('-12.345')).toBe(-1235)
    expect(Object.is(minorOf('-0.004'), -0)).toBe(false)
  })
})
