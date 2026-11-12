// @vitest-environment node
// The anonymiser's CSV handler (scripts/anonymise/csv.ts): cells replaced by what their column holds in the guessed
// layout, every other byte kept. The header, the preamble's shape, the delimiters, quoting, dates and line ends stay;
// payees, memos, account numbers, ids and the preamble's text are replaced; amounts change and a running balance still
// adds up, across files anonymised together; and the scan passes. Every sample and every layout in the corpus keeps
// its layout: the guess of the output is the guess of the input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { anonymise, check, describeCounts, type InputFile } from '../../scripts/anonymise/index'
import { shiftCsvDate } from '../../scripts/anonymise/csv'
import { lineEndOf } from '../../scripts/anonymise/encoding'
import { parseCsv, readCsv, valuesOf } from '../../plugins/import-csv/src/shared/csv'
import { guessLayout } from '../../plugins/import-csv/src/shared/guess'
import { readLines } from '../../plugins/import-csv/src/shared/lines'
import { add, same } from '../../plugins/import-csv/src/shared/cells'
import { SAMPLES } from '../helpers/importFile'
import { setupImport } from '../plugins/import/harness'
import { IMPORT_DIALOGS } from '@tessera/import-api'

const LAYOUTS = path.resolve(__dirname, '../fixtures/import/csv/layouts')
const TODAY = new Date('2026-11-06T12:00:00Z')
const PIVOT = 2036
const input = (name: string, dir = SAMPLES): InputFile => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) })
/**
 * A file's text. Its line ends are whatever git checked out: on Windows, with core.autocrlf, CRLF for every file,
 * whatever it was committed with. So the tests split lines on either.
 */
const text = (name: string, dir = SAMPLES) => fs.readFileSync(path.join(dir, name), 'utf8')
const run = (names: string[], options: Parameters<typeof anonymise>[1] = {}, dir = SAMPLES) =>
  anonymise(names.map(n => input(n, dir)), { seed: 11, today: TODAY, ...options }).outputs

/** How a file is guessed and read. */
const readBack = (body: string) => {
  const { delimiter, rows } = readCsv(body)
  const values = rows.map(valuesOf)
  const guess = guessLayout(values, { delimiter, pivot: PIVOT })
  return { guess, read: readLines(values, guess.layout, PIVOT), values }
}
/** The file's structure: each row's cell count and which cells are quoted, and its line ends. */
const skeleton = (body: string) => ({
  rows: parseCsv(body, readCsv(body).delimiter).map(r => r.cells.map(c => c.quoted ? 'q' : c.text === '' ? '_' : 'v').join('')),
  crlf: (body.match(/\r\n/g) ?? []).length,
  lf: (body.match(/\n/g) ?? []).length
})

/** Each row's balance is the row before's plus its amount, oldest first. */
function addsUp(body: string): boolean {
  const { read } = readBack(body)
  return read.statements.every(s => {
    const rows = s.order === 'oldestFirst' ? s.lines : [...s.lines].reverse()
    return rows.every((l, i) => i === 0 || l.balance === undefined || same(l.balance, add(rows[i - 1].balance!, l.line.amount)))
  })
}

describe('anonymising CSV files', () => {
  const [october, november] = run(['maple-trust-chequing-2026-10.csv', 'maple-trust-chequing-2026-11.csv'])

  it('leaves nothing personal: payees replaced, the scan finds nothing', () => {
    expect(october.error).toBeUndefined()
    expect(october.findings).toEqual([])
    expect(november.findings).toEqual([])
    for (const gone of ['COSTCO', 'LOBLAWS', 'NORTHERN', 'HYDRO', 'KEG', 'SHELL', 'BELL']) expect(october.text, gone).not.toContain(gone)
    expect(describeCounts(october.counts)).toBe('18 payees, 18 amounts replaced; 17 balances worked out again from the changed lines')
  })

  it('keeps the layout: the header, delimiters, quoting, line ends, dates, status, and the bank’s own words', () => {
    const original = text('maple-trust-chequing-2026-10.csv')
    expect(october.text.split(/\r?\n/)[0]).toBe(original.split(/\r?\n/)[0])
    expect(skeleton(october.text)).toEqual(skeleton(original))
    const before = readBack(original)
    const after = readBack(october.text)
    expect(after.guess.layout).toEqual(before.guess.layout)
    expect(after.values.map(v => [v[0], v[5]])).toEqual(before.values.map(v => [v[0], v[5]]))
    expect(after.read.statements[0].lines.map(l => l.line.payee)).toEqual(expect.arrayContaining(['MONTHLY ACCOUNT FEE', 'INTEREST PAID', 'ATM WITHDRAWAL']))
    expect(after.read.statements[0].lines[0].line.payee).toMatch(/^CHEQUE \d{3}$/)
    expect(after.read.statements[0].lines[3].line.payee).toMatch(/^POS PURCHASE [A-Z]+ [A-Z]+ #\d{4}$/)
    // The sample is written with CRLF line ends, but git may have changed them (Windows, with core.autocrlf, commits LF)
    const lineEnd = lineEndOf(original)
    expect(october.sidecar).toEqual(lineEnd === '\n' ? undefined : { encoding: 'utf-8', bom: false, lineEnd })
  })

  it('changes the amounts, keeping equal ones equal, and the running balance still adds up', () => {
    const before = readBack(text('maple-trust-chequing-2026-10.csv')).read.statements[0].lines
    const after = readBack(october.text).read.statements[0].lines
    expect(after.map(l => Math.sign(Number(l.line.amount)))).toEqual(before.map(l => Math.sign(Number(l.line.amount))))
    expect(after.filter((l, i) => l.line.amount !== before[i].line.amount).length).toBeGreaterThan(12)
    expect(after[13].line.amount).toBe(after[14].line.amount)                           // the two coffees
    expect(after[2].line.amount).toBe(after[9].line.amount)                             // the two paycheques
    expect(addsUp(october.text)).toBe(true)
    expect(addsUp(november.text)).toBe(true)
    expect(readBack(october.text).read.statements[0].balance!.amount).not.toBe('4677.80')
  })

  it('anonymises overlapping files the same way: the shared week is the same, balances included', () => {
    const oct = october.text.split(/\r?\n/)
    const nov = november.text.split(/\r?\n/)
    expect(nov.slice(1, 6)).toEqual(oct.slice(13, 18))
  })

  it('imports: October then November end at November’s balance, with the shared week not doubled', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-anon-csv-'))
    const files = [october, november].map(o => { const f = path.join(dir, o.outputName); fs.writeFileSync(f, o.text); return f })
    await env.manager.importFiles([files[0]])
    // A CSV file without an account column is asked about every time, with the account chosen last time preselected
    env.answer(IMPORT_DIALOGS.account, (i: { preselectedId?: string }) => ({ kind: 'account', accountId: i.preselectedId, remember: false }))
    const report = await env.manager.importFiles([files[1]])
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 5, duplicates: 5 } })
    const [account] = await env.accounts.list()
    const [{ balances }] = (await env.accounts.chart()).accounts.filter(s => s.account.id === account.id)
    expect((balances.current / 100).toFixed(2)).toBe(readBack(november.text).read.statements[0].balance!.amount)
  })
})

describe('anonymising other CSV files', () => {
  it('keeps a headerless card export’s shape and signs: charges still positive', () => {
    const [visa] = run(['northwind-visa-2026-10.csv'])
    expect(visa.findings).toEqual([])
    expect(visa.text).not.toMatch(/CANADIAN|NETFLIX|BYTOWN|0142325781/)
    expect(skeleton(visa.text)).toEqual(skeleton(text('northwind-visa-2026-10.csv')))
    const { guess, read } = readBack(visa.text)
    expect(guess.layout).toMatchObject({ header: false, reversed: true, columns: { date: 0, payee: 1, amount: 2 } })
    expect(read.statements[0].lines.map(l => l.line.payee)).toContain('FOREIGN TRANSACTION FEE')
  })

  it('replaces account numbers in their shape, keeping two accounts apart, and each account’s balance adds up', () => {
    const [harbour] = run(['harbour-bank-2026-10.csv'])
    expect(harbour.findings).toEqual([])
    expect(harbour.text).not.toContain('223301')
    const { read } = readBack(harbour.text)
    expect(read.statements.map(s => s.account)).toEqual([expect.stringMatching(/^\d{6}-\d{4}$/), expect.stringMatching(/^\d{6}-\d{4}$/)])
    expect(read.statements[0].account).not.toBe(read.statements[1].account)
    expect(read.statements.map(s => s.lines.length)).toEqual([5, 2])
    expect(addsUp(harbour.text)).toBe(true)
    expect(describeCounts(harbour.counts)).toMatch(/^7 account numbers, 7 payees, 7 amounts replaced; 7 balances/)
  })

  it('keeps a French file’s comma decimals and grouping, its preamble’s shape, and replaces the preamble’s text', () => {
    const [fr] = run(['maple-trust-cheques-2026-10-fr.csv'])
    expect(fr.findings).toEqual([])
    const lines = fr.text.split(/\r?\n/)
    expect(lines[0]).toMatch(/^Compte;[A-Z][a-z]+ \d{4}$/)
    expect(lines[0]).not.toContain('0042')
    expect(lines[3]).toBe('Date;Libelle;Retrait;Depot;Solde')
    expect(lines[4]).toMatch(/^02\/10\/2026;[A-Z]+ [A-Z]+;\d \d{3},\d{2};;\d{3},\d{2}$/)
    expect(addsUp(fr.text)).toBe(true)
    expect(readBack(fr.text).guess.layout).toEqual(readBack(text('maple-trust-cheques-2026-10-fr.csv')).guess.layout)
  })

  it('keeps the header’s words wherever they appear, so a payee sharing one doesn’t leave the header as a leak', () => {
    const body = 'Date,Merchant,Amount\n2026-10-02,MERCHANT SERVICES FEE,-12.00\n2026-10-05,BLUE HERON CAFE,-4.50\n'
    const [output] = anonymise([{ name: 'm.csv', bytes: new TextEncoder().encode(body) }], { seed: 2, today: TODAY }).outputs
    expect(output.findings).toEqual([])
    expect(output.text).toMatch(/^Date,Merchant,Amount\n2026-10-02,MERCHANT [A-Z]+ FEE,/)
    expect(output.text).not.toMatch(/HERON/)
  })

  it('keeps a balance forward row adding up with the rows after it', () => {
    const [totals] = run(['21-balance-forward-totals.csv'], {}, LAYOUTS)
    const balances = totals.text.split(/\r?\n/).slice(1, 5).map(l => l.split(',')[4])
    const amounts = totals.text.split(/\r?\n/).slice(2, 5).map(l => { const c = l.split(','); return c[3] ? c[3] : `-${c[2]}` })
    expect(balances.slice(1).every((b, i) => same(b, add(balances[i], amounts[i])))).toBe(true)
    expect(totals.text).toContain(',Balance forward,')
    expect(totals.text).toContain(',Total,')
  })

  it('moves dates by whole weeks when asked, written as they were', () => {
    const [moved] = run(['maple-trust-chequing-2026-10.csv'], { shiftWeeks: 1 })
    expect(moved.text.split(/\r?\n/)[1]).toMatch(/^10\/09\/2026,/)
    expect(shiftCsvDate('10/2/2026', 'MDY', 7, PIVOT)).toBe('10/9/2026')
    expect(shiftCsvDate('28/10/2026', 'DMY', 7, PIVOT)).toBe('04/11/2026')
    expect(shiftCsvDate('20261028', 'YMD', 7, PIVOT)).toBe('20261104')
    expect(shiftCsvDate('10/28/26', 'MDY', 7, PIVOT)).toBe('11/04/26')
    expect(shiftCsvDate('28-Oct-2026', 'DMY', 7, PIVOT)).toBe('4-Nov-2026')
    expect(shiftCsvDate('28-Oct-2026', 'DMY', 7, PIVOT, true)).toBe('04-Nov-2026')         // the column writes '02-Oct'
    expect(shiftCsvDate('Oct 28, 2026', 'MDY', 7, PIVOT)).toBe('Nov 4, 2026')
    expect(shiftCsvDate('10/28/2026', 'MDY', 7, PIVOT)).toBe('11/04/2026')
    expect(shiftCsvDate('10/28/2026', 'MDY', 7, PIVOT, false)).toBe('11/4/2026')          // the column writes '10/2'
    const [named] = run(['15-month-names.csv'], { shiftWeeks: 1 }, LAYOUTS)
    expect(named.text.split(/\r?\n/).slice(1, 3).map(l => l.split(',')[0])).toEqual(['09-Oct-2026', '12-Oct-2026'])
    expect(shiftCsvDate('December 30 2026', 'MDY', 7, PIVOT)).toBe('January 6 2027')
  })

  it('says so when moving the dates changes whether their order is ambiguous', () => {
    // Every day is 12 or less: moved a week, some pass 12, and the order is no longer in doubt
    const [moved] = run(['16-ambiguous-dates.csv'], { shiftWeeks: 1 }, LAYOUTS)
    expect(moved.notes).toEqual(['Moved, its dates can be read in only one order, as they couldn\'t before: choose another number of weeks to keep them ambiguous.'])
    expect(run(['16-ambiguous-dates.csv'], {}, LAYOUTS)[0].notes).toBeUndefined()
    expect(run(['maple-trust-chequing-2026-10.csv'], { shiftWeeks: 1 })[0].notes).toBeUndefined()
  })

  it('keeps amounts when asked', () => {
    const [kept] = run(['maple-trust-chequing-2026-10.csv'], { keepAmounts: true })
    const amounts = (body: string) => readBack(body).read.statements[0].lines.map(l => [l.line.amount, l.balance])
    expect(amounts(kept.text)).toEqual(amounts(text('maple-trust-chequing-2026-10.csv')))
  })

  it.each(fs.readdirSync(LAYOUTS).filter(n => n.endsWith('.csv')).sort())('keeps the layout of %s, with nothing personal left', name => {
    const [output] = run([name], {}, LAYOUTS)
    expect(output.error).toBeUndefined()
    expect(output.findings).toEqual([])
    const before = readBack(text(name, LAYOUTS))
    const after = readBack(output.text)
    expect(after.guess.layout).toEqual(before.guess.layout)
    expect(after.guess.uncertain.map(u => u.field)).toEqual(before.guess.uncertain.map(u => u.field))
    expect(skeleton(output.text)).toEqual(skeleton(text(name, LAYOUTS)))
    expect(after.read.statements.map(s => s.lines.length)).toEqual(before.read.statements.map(s => s.lines.length))
    expect(after.read.leftOut.map(l => [l.row, l.quiet])).toEqual(before.read.leftOut.map(l => [l.row, l.quiet]))
  })
})

describe('checking CSV files', () => {
  const body = 'Date,Description,Amount\n2026-10-05,E-TRANSFER jane.doe@example.com,-84.12\n2026-10-06,CARD 4111 1111 1111 1111,-1.00\n'

  it('finds what looks personal in a raw CSV, and nothing in dates and amounts', () => {
    expect(check([{ name: 'x.csv', bytes: new TextEncoder().encode(body) }])[0].findings.map(f => f.kind)).toEqual(['email address', 'card number'])
    expect(check([{ name: 'y.csv', bytes: new TextEncoder().encode('Date,Description,Amount\n2026-10-05,COFFEE,-1234567.00\n') }])[0].findings).toEqual([])
  })

  it('checks its own output (named *.anon.*) only where it keeps the original: the header and codes', () => {
    const [output] = run(['harbour-bank-2026-10.csv'])
    const bytes = new TextEncoder().encode(output.text)
    expect(check([{ name: output.outputName, bytes }])[0].findings).toEqual([])
    const planted = output.text.replace('Account Number,', 'Account Number 613-555-0199,')
    expect(check([{ name: output.outputName, bytes: new TextEncoder().encode(planted) }])[0].findings.map(f => f.kind)).toEqual(['phone number'])
  })

  it('refuses to write an output where something personal was left in a cell it keeps', () => {
    const [output] = anonymise([{ name: 'z.csv', bytes: new TextEncoder().encode('Date,Description,Amount,Status\n2026-10-05,COFFEE,-1.00,call 613-555-0199\n2026-10-06,TEA,-2.00,Posted\n') }], { seed: 1, today: TODAY }).outputs
    expect(output.findings.map(f => f.kind)).toEqual(['phone number'])
  })
})
