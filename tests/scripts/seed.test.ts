// @vitest-environment node
// The seed generator, and the statement fixtures it writes.
//
// The generator is checked directly, because a book whose numbers do not add up is a poor place to test an
// importer: every mismatch would look like the importer's fault. The committed fixtures are checked against
// the generator, so a regenerated seed that quietly stops exercising something — the Windows-1252 bytes, the
// staggered dates, the rows the household has not entered — fails here rather than being noticed much later.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTS, PERIOD, RECONCILED_THROUGH, generate, monthlyBalances, statementRows, type AccountKey
} from '../../scripts/seed/household'
import { fitid, ofxAmount, render, toCp1252, type StatementSpec } from '../../scripts/seed/statements'
import { addDays, monthsBetween } from '../../scripts/seed/random'

const FIXTURES = path.resolve(__dirname, '../fixtures/exchange')
const read = (file: string) => fs.readFileSync(path.join(FIXTURES, file))
const manifest = () => JSON.parse(read('manifest.json').toString('utf8')) as {
  openMonth: string
  seed: number
  statements: {
    file: string
    format: StatementSpec['format']
    account: { name: string, number: string, type: string }
    month: string
    rows: number
    inBook: number
    notInBook: number
    staggered: number
    closingBalance: number
    carriesReferences: boolean
  }[]
}

const ledger = () => generate(manifest().seed, manifest().openMonth)

describe('the generated household', () => {
  it('is the same book every time, from the same seed', () => {
    const first = generate(1234, '2026-10')
    const second = generate(1234, '2026-10')
    expect(second.entries).toEqual(first.entries)
    expect(generate(4321, '2026-10').entries).not.toEqual(first.entries)
  })

  it('covers the whole period and nothing outside it', () => {
    const { entries } = ledger()
    expect(entries.length).toBeGreaterThan(1000)
    for (const entry of entries) {
      expect(entry.date >= PERIOD.from).toBe(true)
      expect(entry.date <= PERIOD.to).toBe(true)
    }
    expect(entries).toEqual([...entries].sort((a, b) => a.date.localeCompare(b.date)))
  })

  it('closes at the balance its own month-by-month figures reach', () => {
    const built = ledger()
    const months = monthsBetween(PERIOD.from.slice(0, 7), PERIOD.to.slice(0, 7))
    const last = monthlyBalances(built).get(months[months.length - 1])!
    for (const account of ACCOUNTS) expect(last[account.key]).toBe(built.closing[account.key])
  })

  it('keeps every account’s balance plausible, so the book reads like a household’s', () => {
    const { closing } = ledger()
    // The chequing accounts are swept to a float, so neither hoards four years of income
    expect(closing['personal.chequing']).toBeGreaterThan(0)
    expect(closing['personal.chequing']).toBeLessThan(2_000_000)
    expect(closing['business.chequing']).toBeGreaterThan(0)
    expect(closing['business.chequing']).toBeLessThan(2_500_000)
    // The card is paid off monthly, so it never runs away
    expect(closing['personal.visa']).toBeLessThanOrEqual(0)
    expect(closing['personal.visa']).toBeGreaterThan(-800_000)
    // The set-aside is paid out quarterly, so it holds roughly a quarter's tax, not four years of it
    expect(closing['business.tax']).toBeGreaterThan(0)
    expect(closing['business.tax']).toBeLessThan(3_000_000)
    // Savings is the only one that should have grown a lot
    expect(closing['personal.savings']).toBeGreaterThan(1_200_000)
  })

  it('never lets the household or the business run out of money', () => {
    const { entries } = ledger()
    const running: Record<string, number> = {}
    for (const account of ACCOUNTS) running[account.key] = account.openingBalance

    for (const entry of entries) {
      running[entry.account] += entry.amount
      if (entry.transferTo !== undefined) running[entry.transferTo] -= entry.amount
      for (const key of ['personal.chequing', 'business.chequing', 'personal.savings', 'business.tax'] as AccountKey[]) {
        expect(running[key], `${key} went overdrawn on ${entry.date}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('pays the card off, so the Visa payment matches what the last statement asked for', () => {
    const { entries } = ledger()
    const payments = entries.filter(e => e.transferTo === 'personal.visa')
    expect(payments.length).toBeGreaterThan(40)
    for (const payment of payments) expect(payment.amount).toBeLessThan(0)
  })

  it('sets tax aside every month and pays it out every quarter', () => {
    const { entries } = ledger()
    const aside = entries.filter(e => e.transferTo === 'business.tax')
    const remitted = entries.filter(e => e.account === 'business.tax' && e.transferTo === 'business.chequing')
    const paid = entries.filter(e => e.payee === 'Canada Revenue Agency')

    expect(aside.length).toBeGreaterThan(40)
    expect(remitted.length).toBeGreaterThanOrEqual(14)
    // Every remittance taken out of the set-aside is paid straight to the taxman, for the same amount
    expect(paid).toHaveLength(remitted.length)
    for (const [at, payment] of paid.entries()) expect(payment.amount).toBe(remitted[at].amount)
  })

  it('pays the owner from the business into the personal chequing account', () => {
    const draws = ledger().entries.filter(e => e.account === 'business.chequing' && e.transferTo === 'personal.chequing')
    expect(draws.length).toBeGreaterThan(40)
    for (const draw of draws) expect(draw.amount).toBeLessThan(0)
  })

  it('holds back only the open month’s discretionary rows, so earlier months agree with the bank exactly', () => {
    const { openMonth } = manifest()
    const held = ledger().entries.filter(entry => !entry.inBook)
    expect(held.length).toBeGreaterThan(5)
    for (const entry of held) expect(entry.date.startsWith(openMonth)).toBe(true)
  })

  it('staggers some of the open month’s rows, and never past the month end', () => {
    const { openMonth } = manifest()
    const staggered = ledger().entries.filter(entry => entry.postedDate !== undefined && entry.date.startsWith(openMonth))
    expect(staggered.length).toBeGreaterThanOrEqual(3)
    for (const entry of staggered) {
      expect(entry.postedDate! > entry.date).toBe(true)
      expect(entry.postedDate! <= addDays(entry.date, 3)).toBe(true)
      expect(entry.postedDate!.slice(0, 7)).toBe(openMonth)
    }
  })
})

describe('the committed statement fixtures', () => {
  it('are exactly what the generator writes today', () => {
    const built = ledger()
    const byMonth = monthlyBalances(built)

    for (const entry of manifest().statements) {
      const account = ACCOUNTS.find(a => a.name === entry.account.name)!
      const spec: StatementSpec = {
        file: entry.file,
        format: entry.format,
        account,
        month: entry.month,
        rows: statementRows(built, account.key, entry.month),
        closingBalance: byMonth.get(entry.month)![account.key],
        note: entry.note ?? ''
      }
      expect(render(spec), `${entry.file} is stale: run \`npm run seed:book\``).toEqual(read(entry.file))
    }
  })

  it('cover every format the design names, in both OFX syntaxes', () => {
    const formats = new Set(manifest().statements.map(s => s.format))
    expect(formats).toEqual(new Set(['ofx-sgml', 'ofx-xml', 'qfx', 'qbo', 'csv-debit-credit', 'csv-signed', 'qif-standard', 'qif-microsoft']))
  })

  it('give the importer something to find: rows in the book, rows not in it, and rows posted late', () => {
    const statements = manifest().statements
    expect(statements.some(s => s.notInBook >= 2)).toBe(true)
    expect(statements.some(s => s.staggered >= 3)).toBe(true)
    // The already-reconciled month is entirely in the book: importing it must write nothing
    const reconciled = statements.find(s => s.month < manifest().openMonth)!
    expect(reconciled.notInBook).toBe(0)
    expect(reconciled.inBook).toBe(reconciled.rows)
  })

  it('carry a stable reference per row in every format that has one, and none twice in a file', () => {
    const built = ledger()
    for (const entry of manifest().statements.filter(s => s.carriesReferences)) {
      const account = ACCOUNTS.find(a => a.name === entry.account.name)!
      const rows = statementRows(built, account.key, entry.month)
      const ids = rows.map(row => fitid(account, row))
      expect(new Set(ids).size, `${entry.file} repeats a reference`).toBe(ids.length)
      for (const id of ids) expect(id).toMatch(/^[0-9A-F]{16}$/)
    }
  })

  it('write the SGML files as Windows-1252, with bytes a UTF-8 reader would mangle', () => {
    for (const file of ['ofx/personal-chequing-2026-10.ofx', 'qfx/personal-visa-2026-10.qfx', 'qbo/business-chequing-2026-10.qbo']) {
      const bytes = read(file)
      const high = [...bytes].filter(byte => byte > 0x7f)
      expect(high.length, `${file} has no high bytes left to test the code page with`).toBeGreaterThan(0)
      // Every one of them is a character Windows-1252 has and UTF-8 would read differently
      expect(() => new TextDecoder('windows-1252', { fatal: true }).decode(bytes)).not.toThrow()
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    }
  })

  it('write the OFX 1.x header the specification asks for, and leave its leaf tags unclosed', () => {
    const text = new TextDecoder('windows-1252').decode(read('ofx/personal-chequing-2026-10.ofx'))
    expect(text.startsWith('OFXHEADER:100\r\n')).toBe(true)
    expect(text).toContain('DATA:OFXSGML')
    expect(text).toContain('CHARSET:1252')
    // A blank line separates the header from the body, and the body is SGML no XML parser can read
    expect(text).toMatch(/NEWFILEUID:NONE\r\n\r\n<OFX>/)
    expect(text).toMatch(/<TRNAMT>-?\d+\.\d\d\r\n/)
    expect(text).not.toContain('</TRNAMT>')
  })

  it('write the OFX 2.x file as well-formed XML with the processing instruction', () => {
    const text = read('ofx/personal-chequing-2026-09.ofx').toString('utf8')
    expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"/)
    expect(text).toContain('<?OFX OFXHEADER="200" VERSION="211"')
    expect(text).toContain('</TRNAMT>')
    // Every tag that opens, closes
    const opened = [...text.matchAll(/<([A-Z][A-Z.]*)>/g)].map(m => m[1])
    const closed = [...text.matchAll(/<\/([A-Z][A-Z.]*)>/g)].map(m => m[1])
    expect(opened.sort()).toEqual(closed.sort())
  })

  it('mark the Intuit files with the tags that tell them apart from plain OFX', () => {
    const qfx = new TextDecoder('windows-1252').decode(read('qfx/personal-visa-2026-10.qfx'))
    const qbo = new TextDecoder('windows-1252').decode(read('qbo/business-chequing-2026-10.qbo'))
    expect(qfx).toContain('<INTU.BID>')
    expect(qbo).toContain('<INTU.BID>')
    // The card statement is a credit-card response, not a bank one
    expect(qfx).toContain('<CCSTMTRS>')
    expect(qfx).toContain('<CCACCTFROM>')
    expect(qbo).toContain('<BANKACCTFROM>')
  })

  it('write two CSV shapes that disagree, as two banks' + '’ exports do', () => {
    const debitCredit = read('csv/personal-savings-2026-10.csv').toString('utf8')
    const signed = read('csv/business-tax-2026-10.csv').toString('utf8')

    // A title line above the header, D/M/Y dates, separate columns, and a total below
    expect(debitCredit.split('\r\n')[1]).toBe('Date,Description,Debit,Credit,Balance')
    expect(debitCredit).toMatch(/\r\n\d\d\/\d\d\/\d{4},/)
    expect(debitCredit).toContain('Closing balance')

    // A BOM for Excel, ISO dates, one signed column
    expect(signed.charCodeAt(0)).toBe(0xfeff)
    expect(signed).toContain('Transaction Date,Payee,Memo,Reference,Amount')
    expect(signed).toMatch(/\r\n2026-10-\d\d,/)
  })

  it('write QIF in both dialects: Money’s full names and !Account block, and the standard fifteen-character cut', () => {
    const microsoft = new TextDecoder('windows-1252').decode(read('qif/personal-chequing-2026-10.qif'))
    const standard = read('qif/personal-visa-2026-10.qif').toString('ascii')

    expect(microsoft.startsWith('!Account\r\nN')).toBe(true)
    expect(microsoft).toMatch(/\r\n!Type:Bank\r\n/)
    expect(microsoft).toMatch(/\r\nD\d{1,2}\/\d{1,2}\/2026\r\n/)
    expect(microsoft).toContain('\r\nPMaple Ridge Properties\r\n')   // longer than 15, written whole
    expect(microsoft).toContain('\r\nC*\r\n')
    expect(microsoft).toMatch(/\r\nL[^\r]+:[^\r]+\r\n/)             // Parent:Child, no spaces round the colon

    expect(standard.startsWith('!Type:CCard\r\n')).toBe(true)
    expect(standard).toMatch(/\r\nD\d{1,2}\/\d{1,2}'26\r\n/)
    for (const line of standard.split('\r\n').filter(l => /^[PML]/.test(l))) expect(line.length - 1).toBeLessThanOrEqual(15)
    expect(standard).not.toContain('!Account')
    // Every record ends with a caret, and there are as many as the manifest says rows
    const entry = manifest().statements.find(s => s.file === 'qif/personal-visa-2026-10.qif')!
    expect(standard.split('\r\n').filter(l => l === '^')).toHaveLength(entry.rows)
  })

  it('balance: each statement’s closing figure is its rows added to what came before', () => {
    const built = ledger()
    const byMonth = monthlyBalances(built)
    const months = monthsBetween(PERIOD.from.slice(0, 7), PERIOD.to.slice(0, 7))

    for (const entry of manifest().statements) {
      const account = ACCOUNTS.find(a => a.name === entry.account.name)!
      const previous = months[months.indexOf(entry.month) - 1]
      const opening = previous === undefined ? account.openingBalance : byMonth.get(previous)![account.key]
      const moved = statementRows(built, account.key, entry.month).reduce((total, row) => total + row.amount, 0)
      expect(opening + moved).toBe(entry.closingBalance)
    }
  })
})

describe('writing money and dates the way a bank does', () => {
  it('writes amounts as a plain signed decimal, never grouped', () => {
    expect(ofxAmount(-14_200)).toBe('-142.00')
    expect(ofxAmount(1_234_567)).toBe('12345.67')
    expect(ofxAmount(5)).toBe('0.05')
    expect(ofxAmount(0)).toBe('0.00')
  })

  it('encodes Windows-1252, including the punctuation ISO-8859-1 does not have', () => {
    expect([...toCp1252('Café')]).toEqual([0x43, 0x61, 0x66, 0xe9])
    // The curly apostrophe is 0x92 in Windows-1252 and a control character in ISO-8859-1: writing it as
    // `latin1` corrupts the file silently, which is the bug this encoder exists to avoid
    expect([...toCp1252('’')]).toEqual([0x92])
    expect([...toCp1252('—')]).toEqual([0x97])
    expect([...toCp1252('€')]).toEqual([0x80])
    // Anything the code page cannot hold becomes a question mark, as a real encoder does
    expect([...toCp1252('漢')]).toEqual([0x3f])
  })

  it('gives the same row the same reference every time, and different rows different ones', () => {
    const account = ACCOUNTS[0]
    const row = { date: '2026-10-01', account: account.key, amount: -1000, payee: 'A', inBook: true, inStatement: true }
    expect(fitid(account, row)).toBe(fitid(account, { ...row }))
    expect(fitid(account, row)).not.toBe(fitid(account, { ...row, amount: -1001 }))
    expect(fitid(account, row)).not.toBe(fitid(ACCOUNTS[1], row))
  })
})

describe('what the seed promises the rest of the repository', () => {
  it('reconciles through the date the design names, leaving the open month alone', () => {
    expect(RECONCILED_THROUGH < PERIOD.to).toBe(true)
    expect(RECONCILED_THROUGH.slice(0, 7)).not.toBe(manifest().openMonth)
  })

  it('keeps no real money in the fixtures: every file is generated and committed deliberately', () => {
    // The anonymised real statements live in their own folder, with their own manifest, and are checked by the
    // anonymiser's tests rather than regenerated
    const committed = fs.readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(FIXTURES, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .filter(file => !file.startsWith('anonymized/'))
      .sort()
    const named = ['manifest.json', ...manifest().statements.map(s => s.file)].sort()
    expect(committed, 'a file in the fixtures folder that the seed did not write').toEqual(named)
  })
})
