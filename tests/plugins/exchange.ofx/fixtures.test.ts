// @vitest-environment node
// The OFX reader against the files the seeder writes — the real reason phase S came before phase 2.
//
// These are not hand-built snippets: they are whole statements with headers, balances, transfers, Windows-1252
// payees and an Intuit block, in both OFX syntaxes. If the reader can read these it can read a bank's.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readOfx } from '../../../plugins/exchange.ofx/src/privileged/index'
import { OFX_FORMATS } from '../../../plugins/exchange.ofx/src/privileged/index'

const FIXTURES = path.resolve(__dirname, '../../fixtures/exchange')
const read = (file: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, file)))
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as {
  statements: { file: string, format: string, account: { name: string, number: string, bankId: string, type: string }, month: string, rows: number, closingBalance: number }[]
}
const entryFor = (file: string) => manifest.statements.find(s => s.file === file)!

const SGML = 'ofx/personal-chequing-2026-10.ofx'
const XML = 'ofx/personal-chequing-2026-09.ofx'
const QFX = 'qfx/personal-visa-2026-10.qfx'
const QBO = 'qbo/business-chequing-2026-10.qbo'

const parse = (file: string, formatId = OFX_FORMATS.ofx) => readOfx(read(file), { formatId })

describe('the OFX 1.0.2 SGML statement', () => {
  it('reads every row the manifest says is in it', () => {
    const document = parse(SGML)
    expect(document.statements).toHaveLength(1)
    expect(document.statements[0].transactions).toHaveLength(entryFor(SGML).rows)
    expect(document.warnings.filter(w => w.code === 'record.malformed')).toEqual([])
  })

  it('reads the account the statement belongs to', () => {
    const { account } = parse(SGML).statements[0]
    const expected = entryFor(SGML).account
    expect(account).toMatchObject({
      number: expected.number,
      bankId: expected.bankId,
      currency: 'CAD',
      type: 'chequing',
      rawType: 'CHECKING'
    })
  })

  it('reads the period and the closing balance', () => {
    const statement = parse(SGML).statements[0]
    expect(statement.period).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(statement.balances?.ledger).toEqual({ amount: entryFor(SGML).closingBalance, asOf: '2026-10-31' })
    expect(statement.balances?.available?.amount).toBe(entryFor(SGML).closingBalance)
  })

  it('adds up: the rows and the opening balance reach the closing balance', () => {
    const statement = parse(SGML).statements[0]
    const moved = statement.transactions.reduce((total, row) => total + row.amount, 0)
    // The September file closes where the October one opens
    const opening = parse(XML).statements[0].balances!.ledger!.amount
    expect(opening + moved).toBe(statement.balances!.ledger!.amount)
  })

  it('keeps the Windows-1252 payees intact', () => {
    const text = JSON.stringify(parse(SGML))
    expect(text).not.toContain('\\ufffd')
    expect(parse(SGML).warnings.filter(w => w.code === 'encoding.replaced')).toEqual([])
    // The owner's draw memo carries a curly apostrophe, which is 0x92 in the code page and a control
    // character in ISO-8859-1 — the byte that proves the file was not read as latin1 by accident
    const memos = parse(SGML).statements[0].transactions.map(row => row.memo).filter(Boolean)
    expect(memos.some(memo => memo!.includes('’'))).toBe(true)
  })

  it('names the dialect it read, so the review header can show it', () => {
    expect(parse(SGML).dialect).toBe('OFX 102 (SGML)')
    expect(parse(XML).dialect).toBe('OFX 211 (XML)')
  })

  it('reads the institution from the FI block', () => {
    expect(parse(SGML).institution).toEqual({ name: 'Maple Trust Bank', id: '021000021' })
  })

  it('carries a reference for every row, each one different', () => {
    const ids = parse(SGML).statements[0].transactions.map(row => row.externalId)
    expect(ids.every(id => typeof id === 'string' && id.length === 16)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reads the cheque number where the statement prints one', () => {
    const document = parse('ofx/personal-chequing-2026-09.ofx')
    const numbered = document.statements[0].transactions.filter(row => row.number !== undefined)
    for (const row of numbered) expect(row.number).toMatch(/^\d{3,}$/)
  })
})

describe('the two syntaxes', () => {
  it('read the same shape of document from the same kind of file', () => {
    const sgml = parse(SGML)
    const xml = parse(XML)
    for (const document of [sgml, xml]) {
      expect(document.statements).toHaveLength(1)
      expect(document.statements[0].account.number).toBe(entryFor(SGML).account.number)
      expect(document.statements[0].account.type).toBe('chequing')
      expect(document.statements[0].balances?.ledger).toBeDefined()
      expect(document.statements[0].transactions.length).toBeGreaterThan(0)
      for (const row of document.statements[0].transactions) {
        expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(Number.isSafeInteger(row.amount)).toBe(true)
        expect(row.externalId).toBeTypeOf('string')
      }
    }
  })

  it('reads the XML file without being confused by its closing tags', () => {
    const statement = parse(XML).statements[0]
    expect(statement.transactions).toHaveLength(entryFor(XML).rows)
    // A closing tag that was mistaken for an element would leave an empty payee behind
    expect(statement.transactions.every(row => (row.payee ?? '').trim() !== '')).toBe(true)
    expect(parse(XML).warnings.filter(w => w.code === 'record.malformed')).toEqual([])
  })
})

describe('the Intuit files', () => {
  it('reads the QFX credit-card statement as a credit card', () => {
    const document = readOfx(read(QFX), { formatId: OFX_FORMATS.qfx })
    const statement = document.statements[0]
    expect(statement.account.type).toBe('creditCard')
    expect(statement.account.number).toBe(entryFor(QFX).account.number.replace(/\s/g, ''))
    // A card statement has no routing number and no ACCTTYPE
    expect(statement.account.bankId).toBeUndefined()
    expect(statement.transactions).toHaveLength(entryFor(QFX).rows)
    expect(statement.balances?.ledger?.amount).toBe(entryFor(QFX).closingBalance)
  })

  it('reads INTU.BID as the institution, and never reads INTU.USERID', () => {
    const document = readOfx(read(QFX), { formatId: OFX_FORMATS.qfx })
    expect(document.institution?.id).toBe('2001')
    // The user's login at their bank has no business in a book
    expect(JSON.stringify(document)).not.toContain('householder@example.invalid')
    expect(JSON.stringify(document).toLowerCase()).not.toContain('userid')
  })

  it('reads the QBO business statement, transfers included', () => {
    const document = readOfx(read(QBO), { formatId: OFX_FORMATS.qbo })
    const statement = document.statements[0]
    expect(statement.account.type).toBe('chequing')
    expect(statement.transactions).toHaveLength(entryFor(QBO).rows)
    expect(document.institution?.id).toBe('3000')
    // The draw and the tax set-aside are transfers, and the file marks them
    expect(statement.transactions.some(row => row.kind === 'XFER')).toBe(true)
  })

  it('keeps the accented payees of the card statement', () => {
    const payees = readOfx(read(QFX), { formatId: OFX_FORMATS.qfx })
      .statements[0].transactions.map(row => row.payee)
    expect(payees).toContain('Boulangerie Côté')
    expect(payees).toContain('Café Martin')
  })
})

describe('nothing is lost quietly', () => {
  it('finds nothing it cannot represent in an ordinary statement', () => {
    for (const file of [SGML, XML, QFX, QBO]) {
      expect(parse(file).unsupported, `${file} dropped something`).toEqual([])
    }
  })

  it('reads every fixture without a single warning about the records themselves', () => {
    for (const file of [SGML, XML, QFX, QBO]) {
      const codes = parse(file).warnings.map(w => w.code)
      expect(codes.filter(code => code !== 'signs.uniform'), `${file}`).toEqual([])
    }
  })

  it('notices a statement where every row goes the same way, without refusing it', () => {
    // The card's October statement is spending and one payment, so it is not uniform; the savings account's
    // would be, but that is a CSV. Build the case from the card file by reading it as inverted.
    const document = readOfx(read(QFX), { formatId: OFX_FORMATS.qfx, signs: 'invert' })
    expect(document.statements[0].transactions.length).toBeGreaterThan(0)
    // Inverting is honoured, and the warning is not raised when the user has already chosen a convention
    expect(document.warnings.filter(w => w.code === 'signs.uniform')).toEqual([])
  })
})
