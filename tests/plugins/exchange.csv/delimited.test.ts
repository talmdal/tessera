// @vitest-environment node
// The delimited parser and the guesses made from the bytes alone: encoding, delimiter, where the table starts,
// and whether the first row names the columns.
import { describe, expect, it } from 'vitest'
import {
  decodeCsv, inferDelimiter, inferSkip, normaliseHeader, parseDelimited
} from '../../../plugins/exchange.csv/src/privileged/delimited'

describe('decodeCsv', () => {
  it('drops a UTF-8 byte-order mark, which would otherwise glue itself to the first header name', () => {
    const { text, encoding } = decodeCsv(new TextEncoder().encode('﻿Date,Amount\r\n'))
    expect(text).toBe('Date,Amount\r\n')
    expect(encoding).toBe('utf-8')
    expect(normaliseHeader(text.split(',')[0])).toBe('date')
  })

  it('falls back to Windows-1252 for bytes that are not valid UTF-8, as an older bank export is', () => {
    const { text, encoding } = decodeCsv(Uint8Array.from([0x43, 0x61, 0x66, 0xe9])) // "Café" in cp1252
    expect(text).toBe('Café')
    expect(encoding).toBe('windows-1252')
  })

  it('reads UTF-16LE from its byte-order mark, which is Excel’s “Unicode text”', () => {
    const body = 'Date\tAmount\r\n'
    const bytes = new Uint8Array(2 + body.length * 2)
    bytes[0] = 0xff; bytes[1] = 0xfe
    for (let at = 0; at < body.length; at += 1) bytes[2 + at * 2] = body.charCodeAt(at)
    const { text, encoding } = decodeCsv(bytes)
    expect(text).toBe(body)
    expect(encoding).toBe('utf-16le')
  })
})

describe('parseDelimited', () => {
  it('splits plain rows and cells', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n', ',')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('honours RFC 4180 quoting: the delimiter, a newline and a doubled quote inside a cell', () => {
    const text = '"Smith, John","He said ""hi""","line one\nline two"\r\n'
    expect(parseDelimited(text, ',')).toEqual([['Smith, John', 'He said "hi"', 'line one\nline two']])
  })

  it('keeps an empty cell, which is how a debit/credit pair says which side a row is on', () => {
    expect(parseDelimited('31/10/2026,Saving,,1441.43,132811.51\r\n', ',')).toEqual([
      ['31/10/2026', 'Saving', '', '1441.43', '132811.51']
    ])
  })

  it('does not invent a trailing row for a file that ends in a newline', () => {
    expect(parseDelimited('a,b\r\n', ',')).toHaveLength(1)
    expect(parseDelimited('a,b', ',')).toHaveLength(1)
  })

  it('keeps a ragged row rather than dropping it, leaving the reader to decide', () => {
    expect(parseDelimited('a,b,c\r\nx,y\r\n', ',')).toEqual([['a', 'b', 'c'], ['x', 'y']])
  })

  it('reads tab- and semicolon-delimited files', () => {
    expect(parseDelimited('a\tb\r\n1\t2\r\n', '\t')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a;b\r\n1;2\r\n', ';')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('inferDelimiter', () => {
  it('picks the separator that squares the rows up, not the most frequent character', () => {
    // Every memo holds commas and spaces; only the semicolon gives a consistent four columns.
    const text = [
      'Date;Description;Amount;Balance',
      '2026-10-15;Coffee, milk, and a bun;-4,50;1.234,00',
      '2026-10-16;Books, pens, paper;-9,99;1.224,01'
    ].join('\r\n')
    expect(inferDelimiter(text)).toBe(';')
  })

  it('picks the tab in a tab-separated export', () => {
    expect(inferDelimiter('Date\tPayee\tAmount\r\n2026-01-01\tAcme\t1.00\r\n')).toBe('\t')
  })

  it('defaults to the comma', () => {
    expect(inferDelimiter('Date,Payee,Amount\r\n2026-01-01,Acme,1.00\r\n')).toBe(',')
  })
})

describe('inferSkip', () => {
  it('skips a bank’s title line above the header', () => {
    const rows = parseDelimited([
      'Maple Trust Bank - Savings - 2026-10-01 to 2026-10-31',
      'Date,Description,Debit,Credit,Balance',
      '31/10/2026,Month-end saving,,1441.43,132811.51',
      '31/10/2026,Maple Trust Bank,,309.89,133121.40'
    ].join('\r\n'), ',')
    expect(inferSkip(rows)).toBe(1)
  })

  it('skips nothing when the header is the first row', () => {
    const rows = parseDelimited('Date,Payee,Amount\r\n2026-01-01,Acme,1.00\r\n', ',')
    expect(inferSkip(rows)).toBe(0)
  })
})
