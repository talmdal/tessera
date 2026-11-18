// @vitest-environment node
// The CSV writer's fixed column set, its quoting, and the round trip: what CSV claims to carry must survive
// being written and read back, and what it cannot carry must be absent rather than invented.
import { describe, expect, it, vi } from 'vitest'
import type { ExchangeDocument } from '@tessera/exchange-api'
import { CSV_WRITE_COLUMNS } from '@tessera/exchange-api'
import { CSV_FORMAT } from '../../../plugins/exchange.csv/src/privileged/index'
import { csvAmount, csvCell, defuseText, undefuseText, writeCsv } from '../../../plugins/exchange.csv/src/privileged/writer'
import { readCsv } from '../../../plugins/exchange.csv/src/privileged/reader'

/** The BOM is checked as bytes: `TextDecoder` strips it on the way in, so decoded text can never show it. */
const hasBom = (bytes: Uint8Array) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
const text = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)
const lines = (bytes: Uint8Array) => text(bytes).replace(/^﻿/, '').trimEnd().split('\r\n')

const document = (): ExchangeDocument => ({
  formatId: CSV_FORMAT,
  statements: [{
    account: { name: 'Chequing', currency: 'CAD' },
    balances: { ledger: { amount: 100000, asOf: '2026-10-31' } },
    transactions: [
      { date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa', memo: 'November', number: '1042', category: 'Utilities : Electricity', cleared: 'cleared' },
      { date: '2026-10-20', amount: -50000, payee: 'Transfer to savings', transferAccount: 'Savings' },
      { date: '2026-10-25', amount: 214000, payee: 'Acme Widgets', category: 'Salary', cleared: 'reconciled' }
    ]
  }],
  unsupported: [],
  warnings: []
})

describe('csvAmount', () => {
  it('writes a plain signed figure with no grouping, which any locale can parse', () => {
    expect(csvAmount(-14200)).toBe('-142.00')
    expect(csvAmount(214000)).toBe('2140.00')
    expect(csvAmount(0)).toBe('0.00')
    expect(csvAmount(-5)).toBe('-0.05')
  })
})

describe('csvCell', () => {
  it('quotes only what needs it', () => {
    expect(csvCell('Hydro Ottawa', ',')).toBe('Hydro Ottawa')
    expect(csvCell('Smith, John', ',')).toBe('"Smith, John"')
    expect(csvCell('He said "hi"', ',')).toBe('"He said ""hi"""')
    expect(csvCell('two\nlines', ',')).toBe('"two\nlines"')
    expect(csvCell(undefined, ',')).toBe('')
  })

  it('quotes for the file’s structure only, which is not what stops a formula running', () => {
    // Excel strips the quotes and evaluates what is left, so quoting is no defence; see defuseText.
    expect(csvCell('-Acme', ',')).toBe('-Acme')
    expect(csvCell('-142.00', ',')).toBe('-142.00')
  })

  it('does not quote a comma when the delimiter is a semicolon', () => {
    expect(csvCell('Smith, John', ';')).toBe('Smith, John')
    expect(csvCell('a;b', ';')).toBe('"a;b"')
  })
})

describe('writeCsv', () => {
  it('writes the fixed column set as its header', () => {
    expect(lines(writeCsv(document()))[0]).toBe(CSV_WRITE_COLUMNS.join(','))
  })

  it('writes a UTF-8 BOM by default, because Excel mangles a BOM-less file’s non-ASCII payees', () => {
    expect(hasBom(writeCsv(document()))).toBe(true)
    expect(hasBom(writeCsv(document(), { bom: false }))).toBe(false)
  })

  it('ends every line with CRLF', () => {
    expect(text(writeCsv(document(), { bom: false })).endsWith('\r\n')).toBe(true)
    expect(text(writeCsv(document(), { bom: false }))).not.toMatch(/[^\r]\n/)
  })

  it('writes a transfer as [Account] in the category column', () => {
    expect(lines(writeCsv(document()))[2]).toContain('[Savings]')
  })

  it('writes the clearing status as a word, and blank for an uncleared row', () => {
    const rows = lines(writeCsv(document())).slice(1).map(line => line.split(','))
    const status = CSV_WRITE_COLUMNS.indexOf('Status')
    expect(rows.map(r => r[status])).toEqual(['Cleared', '', 'Reconciled'])
  })

  it('runs the balance column up to the statement’s closing balance', () => {
    const rows = lines(writeCsv(document())).slice(1).map(line => line.split(','))
    const balance = CSV_WRITE_COLUMNS.indexOf('Balance')
    expect(rows[rows.length - 1][balance]).toBe('1000.00')
  })

  it('refuses several accounts: a CSV holds one, and its reader could not tell them apart again', () => {
    const two = document()
    two.statements.push({ account: { name: 'Savings' }, transactions: [{ date: '2026-10-01', amount: 100, payee: 'Interest' }] })
    expect(() => writeCsv(two)).toThrow(/holds one account/)
  })

  it('names the one account in the Account column, for a reader in a spreadsheet', () => {
    const rows = lines(writeCsv(document())).slice(1).map(line => line.split(','))
    const account = CSV_WRITE_COLUMNS.indexOf('Account')
    expect(new Set(rows.map(r => r[account]))).toEqual(new Set(['Chequing']))
  })

  it('writes the delimiter it is given', () => {
    expect(lines(writeCsv(document(), { delimiter: ';' }))[0]).toBe(CSV_WRITE_COLUMNS.join(';'))
  })
})

describe('the round trip', () => {
  it('carries what CSV claims to carry, and leaves out what it cannot', async () => {
    const written = writeCsv(document())
    const read = await readCsv(written, {
      formatId: CSV_FORMAT,
      fileName: 'export.csv',
      request: vi.fn(async (q: { suggested?: unknown }) => q.suggested as never)
    })
    const rows = read.statements[0].transactions
    const original = document().statements[0].transactions

    expect(read.warnings).toEqual([])
    expect(rows).toHaveLength(3)
    // Dates, amounts, payees, numbers, memos and categories survive.
    expect(rows.map(r => r.date)).toEqual(original.map(r => r.date))
    expect(rows.map(r => r.amount)).toEqual(original.map(r => r.amount))
    expect(rows.map(r => r.payee)).toEqual(original.map(r => r.payee))
    expect(rows[0].number).toBe('1042')
    expect(rows[0].memo).toBe('November')
    expect(rows[0].category).toBe('Utilities : Electricity')

    // And what CSV has no way to carry is absent, rather than invented by the reader.
    expect(rows.every(r => r.cleared === undefined)).toBe(true)
    expect(rows.every(r => r.transferAccount === undefined)).toBe(true)
    expect(rows.every(r => r.externalId === undefined)).toBe(true)
  })

  it('survives a payee holding the delimiter, a quote and a leading minus', async () => {
    const tricky = document()
    tricky.statements[0].transactions = [
      { date: '2026-10-15', amount: -100, payee: 'Smith, John' },
      { date: '2026-10-16', amount: -200, payee: 'He said "hi"' },
      { date: '2026-10-17', amount: -300, payee: '-Acme' }
    ]
    const read = await readCsv(writeCsv(tricky), {
      formatId: CSV_FORMAT,
      fileName: 'export.csv',
      request: vi.fn(async (q: { suggested?: unknown }) => q.suggested as never)
    })
    expect(read.statements[0].transactions.map(r => r.payee)).toEqual(['Smith, John', 'He said "hi"', '-Acme'])
  })
})

describe('a text cell a spreadsheet would run as a formula', () => {
  it('gets a leading apostrophe, which a spreadsheet shows as text', () => {
    for (const risky of ['=HYPERLINK("x")', '+1 Courier', '-Acme', '@home']) expect(defuseText(risky)).toBe(`'${risky}`)
    expect(defuseText('Hydro Ottawa')).toBe('Hydro Ottawa')
  })

  it('is defused in every text column, and the amounts are left as numbers', () => {
    const risky = document()
    risky.statements[0].transactions = [{ date: '2026-10-15', amount: -14200, payee: '=HYPERLINK("http://x")', memo: '@me' }]
    const [, row] = lines(writeCsv(risky, { bom: false }))
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(row).toContain("'@me")
    // A negative amount is a number, not a formula: no apostrophe, and no quotes either.
    expect(row).toContain(',-142.00,')
  })

  it('reads back as it was written, because the reader takes the apostrophe off again', () => {
    expect(undefuseText(defuseText('=SUM(A1)'))).toBe('=SUM(A1)')
    // An apostrophe that is not defusing anything is the payee's own, and stays.
    expect(undefuseText("'Tis the season")).toBe("'Tis the season")
  })
})
