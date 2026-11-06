import { describe, expect, it } from 'vitest'
import { amountToInput, currencyCodes, formatAmount, isCurrencyCode, minorDigits, parseAmount } from '@tessera/accounts-api'

const parse = (text: string, currency = 'CAD', locale = 'en-CA') => {
  const result = parseAmount(text, currency, locale)
  return result.ok ? result.value : result.message
}

describe('parseAmount', () => {
  it('reads what people type into minor units', () => {
    expect(parse('1,234.56')).toBe(123456)
    expect(parse('1234.5')).toBe(123450)
    expect(parse('.5')).toBe(50)
    expect(parse('0')).toBe(0)
    expect(parse('  42  ')).toBe(4200)
    expect(parse('$1,000')).toBe(100000)
    expect(parse('5 CAD')).toBe(500)
  })

  it('reads negatives written with a minus or in parentheses', () => {
    expect(parse('-12')).toBe(-1200)
    expect(parse('(12.00)')).toBe(-1200)
    expect(parse('-$5')).toBe(-500)
    expect(parse('−7')).toBe(-700)     // a typographic minus
    expect(parse('-0')).toBe(0)
  })

  it('never goes through floating point', () => {
    expect(parse('0.1')).toBe(10)
    expect(parse('0.29')).toBe(29)
    expect(parse('1.005', 'BHD')).toBe(1005)
    expect(parse('9007199254740.99')).toBe(900719925474099)
  })

  it('follows the currency\'s decimal places, refusing more rather than rounding', () => {
    expect(minorDigits('CAD')).toBe(2)
    expect(minorDigits('JPY')).toBe(0)
    expect(minorDigits('BHD')).toBe(3)
    expect(parse('1200', 'JPY')).toBe(1200)
    expect(parse('12.5', 'JPY')).toBe('JPY amounts have no decimal places.')
    expect(parse('12.345')).toBe('Use at most 2 decimal places.')
  })

  it('follows the locale\'s separators', () => {
    expect(parse('1 234,56', 'CAD', 'fr-CA')).toBe(123456)
    expect(parse('1\u202f234,56', 'CAD', 'fr-CA')).toBe(123456)
    expect(parse('1.234,56', 'EUR', 'de-DE')).toBe(123456)
  })

  it('says what is wrong with something it can\'t read', () => {
    expect(parse('')).toBe('Enter an amount.')
    expect(parse('abc')).toBe('Enter a number, like 1234.56.')
    expect(parse('1.2.3')).toBe('Enter a number, like 1234.56.')
    expect(parse('99999999999999999')).toBe('That amount is too large.')
  })
})

describe('formatting amounts', () => {
  it('shows balances signed (Money\'s way) and column amounts without a sign', () => {
    expect(formatAmount(-54000, 'CAD', { locale: 'en-CA' })).toBe('-$540.00')
    expect(formatAmount(-54000, 'CAD', { locale: 'en-CA', sign: 'never', currency: false })).toBe('540.00')
    expect(formatAmount(1200, 'JPY', { locale: 'en-US' })).toBe('¥1,200')
  })

  it('writes amounts back the way parseAmount reads them', () => {
    for (const [minor, currency] of [[-54000, 'CAD'], [5, 'CAD'], [1200, 'JPY'], [5, 'BHD'], [0, 'CAD']] as const) {
      const text = amountToInput(minor, currency, 'en-CA')
      expect(parseAmount(text, currency, 'en-CA'), text).toEqual({ ok: true, value: minor })
    }
    expect(amountToInput(123456, 'CAD', 'fr-CA')).toBe('1234,56')
  })
})

describe('currency codes', () => {
  it('knows the real ones, in upper case only', () => {
    expect(isCurrencyCode('CAD')).toBe(true)
    expect(isCurrencyCode('cad')).toBe(false)
    expect(isCurrencyCode('XYZ')).toBe(false)
    expect(isCurrencyCode(42)).toBe(false)
    expect(currencyCodes()).toEqual(expect.arrayContaining(['CAD', 'EUR', 'JPY', 'USD']))
  })
})
