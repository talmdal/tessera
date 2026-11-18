// @vitest-environment node
// The CSV reader, over hand-built snippets and the two deliberately disagreeing fixtures: one with a BOM, ISO
// dates and a single signed amount; one with a title line to skip, DMY dates, a debit/credit pair, a balance
// and a trailing total. What the reader must get right is that both come out as the same neutral model.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CsvProfile, ExchangeWarning } from '@tessera/exchange-api'
import { csvProfileQuestionId } from '@tessera/exchange-api'
import { CSV_FORMAT } from '../../../plugins/exchange.csv/src/privileged/index'
import { readCsv, readRows } from '../../../plugins/exchange.csv/src/privileged/reader'
import { guessProfile } from '../../../plugins/exchange.csv/src/privileged/profile'
import { decodeCsv } from '../../../plugins/exchange.csv/src/privileged/delimited'

const FIXTURES = path.resolve(__dirname, '../../fixtures/exchange/csv')
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

/** Reads, answering the mapping question with whatever the guess proposed — the “user pressed OK” path. */
async function readAccepting(data: Uint8Array, fileName: string) {
  const request = vi.fn(async (question: { suggested?: unknown }) => question.suggested as never)
  const document = await readCsv(data, { formatId: CSV_FORMAT, fileName, request })
  return { document, request }
}

const profileOf = (data: Uint8Array, name = 'f.csv') => {
  const { text, encoding } = decodeCsv(data)
  return guessProfile(text, encoding, name).profile
}

describe('reading the single-amount fixture', () => {
  it('reads every row, having guessed the columns from the header', async () => {
    const { document } = await readAccepting(fixture('business-tax-2026-10.csv'), 'business-tax-2026-10.csv')
    const rows = document.statements[0].transactions

    expect(document.formatId).toBe(CSV_FORMAT)
    expect(document.warnings).toEqual([])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ date: '2026-10-15', amount: -1069895, payee: 'For the quarterly remittance' })
    expect(rows[1]).toMatchObject({ date: '2026-10-28', amount: 321113, payee: 'Tax set-aside' })
  })

  it('maps “Transaction Date” to the date and “Reference” to the number, not to the payee', async () => {
    const profile = profileOf(fixture('business-tax-2026-10.csv'))
    expect(profile.columns.date).toBe('Transaction Date')
    expect(profile.columns.payee).toBe('Payee')
    expect(profile.columns.memo).toBe('Memo')
    expect(profile.columns.number).toBe('Reference')
    expect(profile.columns.amount).toBe('Amount')
    expect(profile.columns.debit).toBeUndefined()
    expect(profile.dateFormat).toBe('ISO')
    expect(profile.skip).toBe(0)
    expect(profile.header).toBe(true)
  })
})

describe('reading the debit/credit fixture', () => {
  it('skips the title line, reads DMY dates, and signs the pair correctly', async () => {
    const { document } = await readAccepting(fixture('personal-savings-2026-10.csv'), 'personal-savings-2026-10.csv')
    const rows = document.statements[0].transactions

    expect(document.warnings).toEqual([])
    // Credits raise the balance; nothing here is a debit, and nothing came out negative.
    expect(rows[0]).toMatchObject({ date: '2026-10-31', amount: 144143, payee: 'Month-end saving' })
    expect(rows.every(row => row.amount > 0)).toBe(true)
  })

  it('guesses the title line, the DMY order and the debit/credit pair', () => {
    const profile = profileOf(fixture('personal-savings-2026-10.csv'))
    expect(profile.skip).toBe(1)
    expect(profile.dateFormat).toBe('DMY')
    expect(profile.columns.debit).toBe('Debit')
    expect(profile.columns.credit).toBe('Credit')
    expect(profile.columns.amount).toBeUndefined()
    expect(profile.columns.balance).toBe('Balance')
  })

  it('drops the “Closing balance” row but keeps the balance it carries', async () => {
    const { document } = await readAccepting(fixture('personal-savings-2026-10.csv'), 'personal-savings-2026-10.csv')
    const statement = document.statements[0]
    expect(statement.transactions.some(row => row.payee === 'Closing balance')).toBe(false)
    expect(statement.balances?.ledger?.amount).toBe(13312140)
  })
})

describe('the mapping question', () => {
  it('is asked once, with the first rows as a sample and the guess as the suggestion', async () => {
    const { request } = await readAccepting(fixture('business-tax-2026-10.csv'), 'business-tax-2026-10.csv')
    expect(request).toHaveBeenCalledTimes(1)
    const question = request.mock.calls[0][0] as { kind: string, id: string, sample: string[][], suggested: CsvProfile }
    expect(question.kind).toBe('csvProfile')
    expect(question.id).toMatch(/^exchange-csv\.profile:[0-9a-f]{8}$/)
    expect(question.sample[0]).toContain('Transaction Date')
    expect(question.suggested.columns.date).toBe('Transaction Date')
  })

  it('is not asked when a saved profile matches the file’s fingerprint', async () => {
    const data = fixture('business-tax-2026-10.csv')
    const { text, encoding } = decodeCsv(data)
    const guess = guessProfile(text, encoding)
    const request = vi.fn(async () => { throw new Error('should not ask') })

    const document = await readCsv(data, {
      formatId: CSV_FORMAT,
      fileName: 'business-tax-2026-10.csv',
      answers: { [csvProfileQuestionId(guess.fingerprint)]: guess.profile as never },
      request
    })
    expect(request).not.toHaveBeenCalled()
    expect(document.statements[0].transactions[0].date).toBe('2026-10-15')
  })

  it('gives the same fingerprint to next month’s file from the same bank, and a different one to another shape', () => {
    const header = 'Date,Description,Debit,Credit,Balance\r\n'
    const october = guessProfile(`${header}31/10/2026,A,,1.00,10.00\r\n`, 'utf-8')
    const november = guessProfile(`${header}30/11/2026,B,2.00,,8.00\r\n`, 'utf-8')
    const other = guessProfile('Transaction Date,Payee,Memo,Reference,Amount\r\n2026-10-15,A,,,1.00\r\n', 'utf-8')

    expect(november.fingerprint).toBe(october.fingerprint)
    expect(other.fingerprint).not.toBe(october.fingerprint)
  })

  it('refuses an answer that is not a usable mapping rather than reading the file wrongly', async () => {
    await expect(readCsv(fixture('business-tax-2026-10.csv'), {
      formatId: CSV_FORMAT,
      fileName: 'x.csv',
      request: async () => ({ delimiter: ',', columns: {} } as never)
    })).rejects.toThrow(/date/i)
  })
})

describe('rows the reader cannot use', () => {
  const profile: CsvProfile = {
    name: 'test', delimiter: ',', quote: '"', skip: 0, header: true, encoding: 'utf-8',
    columns: { date: 'Date', payee: 'Payee', amount: 'Amount' }, dateFormat: 'ISO', decimal: '.'
  }
  const read = (text: string) => {
    const warnings: ExchangeWarning[] = []
    const { transactions } = readRows(text, profile, warnings)
    return { transactions, warnings }
  }

  it('skips a row whose date cannot be read, and says which line it was', () => {
    const { transactions, warnings } = read('Date,Payee,Amount\r\n2026-10-15,A,1.00\r\nnot a date,B,2.00\r\n')
    expect(transactions).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('date.unparsable')
    // 1-based and counting the header, so it names the line the user sees in a spreadsheet.
    expect(warnings[0].source?.line).toBe(3)
  })

  it('skips a row whose amount cannot be read', () => {
    const { transactions, warnings } = read('Date,Payee,Amount\r\n2026-10-15,A,n/a\r\n')
    expect(transactions).toHaveLength(0)
    expect(warnings[0].code).toBe('amount.unparsable')
  })

  it('ignores a blank row without complaining about it', () => {
    const { transactions, warnings } = read('Date,Payee,Amount\r\n2026-10-15,A,1.00\r\n,,\r\n')
    expect(transactions).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('counts the skipped rows when numbering a line, so the warning still points at the right one', () => {
    const warnings: ExchangeWarning[] = []
    readRows('Title line\r\nDate,Payee,Amount\r\nbad,B,2.00\r\n', { ...profile, skip: 1 }, warnings)
    expect(warnings[0].source?.line).toBe(3)
  })
})

describe('a file with no header', () => {
  it('maps the columns by what their cells parse as', async () => {
    const text = '2026-10-15,Coffee,-4.50\r\n2026-10-16,Books,-9.99\r\n'
    const guess = guessProfile(text, 'utf-8')
    expect(guess.profile.header).toBe(false)
    expect(guess.profile.columns.date).toBe(0)
    expect(guess.profile.columns.payee).toBe(1)
    expect(guess.profile.columns.amount).toBe(2)

    const { document } = await readAccepting(new TextEncoder().encode(text), 'nohdr.csv')
    expect(document.statements[0].transactions[0]).toMatchObject({ date: '2026-10-15', payee: 'Coffee', amount: -450 })
  })
})

describe('an empty file', () => {
  it('reads as no statements rather than throwing, and asks nothing', async () => {
    const request = vi.fn(async () => { throw new Error('should not ask') })
    const document = await readCsv(new TextEncoder().encode('   \r\n'), { formatId: CSV_FORMAT, fileName: 'empty.csv', request })
    expect(document.statements).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})

describe('the closing balance', () => {
  const profile: CsvProfile = {
    name: 'x', delimiter: ',', quote: '"', skip: 0, header: true, encoding: 'utf-8',
    columns: { date: 'Date', payee: 'Payee', amount: 'Amount', balance: 'Balance' }, dateFormat: 'ISO', decimal: '.'
  }
  const closing = (text: string) => readRows(text, profile, []).closingBalance

  it('is the latest row’s, oldest first', () => {
    expect(closing('Date,Payee,Amount,Balance\n2026-10-01,A,-1.00,97.00\n2026-10-02,B,-1.00,96.00\n2026-10-03,C,-1.00,95.00\n')).toBe(9500)
  })

  it('is still the latest row’s when the bank lists newest first', () => {
    // Taking the last line here reported 97.00 — the oldest balance — against the newest date.
    expect(closing('Date,Payee,Amount,Balance\n2026-10-03,C,-1.00,95.00\n2026-10-02,B,-1.00,96.00\n2026-10-01,A,-1.00,97.00\n')).toBe(9500)
  })

  it('takes the file’s own last row of the day, in either direction', () => {
    expect(closing('Date,Payee,Amount,Balance\n2026-10-03,C,-1.00,95.00\n2026-10-03,D,-1.00,94.00\n2026-10-01,A,-1.00,97.00\n')).toBe(9500)
    expect(closing('Date,Payee,Amount,Balance\n2026-10-01,A,-1.00,97.00\n2026-10-03,C,-1.00,95.00\n2026-10-03,D,-1.00,94.00\n')).toBe(9400)
  })
})
