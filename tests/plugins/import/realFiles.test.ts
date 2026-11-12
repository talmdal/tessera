// @vitest-environment node
// Real statements, anonymised (tests/fixtures/import/real/, see its README): each bank's own dialect, read by its
// format with its original bytes rebuilt from its sidecar, and imported into a new account. Every line is added, the
// account ends at the bank's balance, and importing the file again adds nothing. A CSV file's layout is guessed as
// expected, so a real bank's export is part of the guesser's corpus too.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IMPORT_DIALOGS, isCanonicalDecimal, type ParseContext, type ParseResult } from '@tessera/import-api'
import { ofxFormat } from '../../../plugins/import-ofx/src/privileged/index'
import { createCsvFormat } from '../../../plugins/import-csv/src/privileged/index'
import { createQifFormat } from '../../../plugins/import-qif/src/privileged/index'
import type { LayoutDialogInput } from '../../../plugins/import-csv/src/shared/dialog'
import type { CsvLayout } from '../../../plugins/import-csv/src/shared/layout'
import { fixtureBytes, fixtureFile } from '../../helpers/importFile'
import { NOW, setupImport } from './harness'

const REAL = path.resolve(__dirname, '../../fixtures/import/real')

interface Expected {
  /** Every statement's lines together. */
  lines: number
  /** How many statements (accounts) the file holds; 1 unless said. */
  statements?: number
  /** The warnings reading it gives (an investment account left out, say); none unless said. */
  warnings?: string[]
  /** The bank's balance (the first statement's), when the file gives one. */
  balance?: string
  from: string
  to: string
  about: string
  /** CSV: the layout the guess should make (the parts given), and whether all of it should be sure. */
  layout?: Partial<CsvLayout>
  sure?: boolean
}

/** What each real file holds, by its folder and name. A new file needs its line here: what its bank says. */
const EXPECTED: Record<string, Expected> = {
  'qif/current_loose.anon.qif': {
    lines: 466, balance: '3179.82', from: '2026-02-26', to: '2026-11-30',
    about: 'Microsoft Money, one chequing account exported as "loose" QIF: !Type:Bank and no !Account, the account named by its opening-balance record (0.00, L[...]); ISO dates; payees as the bank sent them; references in N; cheques; transfers to other accounts; splits to a loan account and its interest; names in full; CRLF (see its sidecar)'
  },
  'qif/current_strict.anon.qif': {
    lines: 466, balance: '3179.82', from: '2026-02-26', to: '2026-11-30',
    about: 'The same account exported by Money as "strict" QIF: the same, but every category and account name cut to 15 characters ([Uginar - Checki…], Credit Card Pay), so the account\'s name, and its key, differ from the loose export\'s'
  },
  'csv/bank1-chequing.anon.csv': {
    lines: 4, balance: '2198.24', from: '2026-10-20', to: '2026-11-06', sure: false,
    layout: { header: false, columns: { date: 0, payee: 1, debit: 2, credit: 3, balance: 4 }, dateOrder: 'YMD', decimal: '.', reversed: false },
    about: 'CSV without a header: date, description, money out, money in, running balance; every cell quoted, ISO dates. The same four transactions as bank1-chequing.anon.qbo, anonymised on their own (so other names and amounts)'
  },
  'csv/bank2-chequing.anon.csv': {
    lines: 63, balance: '6656.91', from: '2026-10-13', to: '2026-11-12', sure: false,
    layout: {
      header: true, columns: { date: 1, memo: [2], payee: 3, direction: { column: 4, debit: ['Debit'], credit: ['Credit'] }, amount: 5, balance: 6 },
      dateOrder: 'YMD', decimal: '.', reversed: false
    },
    about: 'CSV with a header of 7 columns: Filter (text in the first row only), Date, Description (the kind of transaction), Sub-description (who with), Type of Transaction (Debit or Credit, beside signed amounts) and a running balance; newest first; every cell quoted; CRLF line ends (see its sidecar). The same 63 transactions as bank2-chequing.anon.qbo, anonymised on their own'
  },
  'ofx/bank1-chequing.anon.qbo': {
    lines: 4, balance: '1426.41', from: '2026-10-20', to: '2026-11-06',
    about: 'QBO, windows-1252 with CRLF line ends (see its sidecar), one tag per line with closing tags, no bank name (FI), an available balance above the ledger balance'
  },
  'ofx/bank2-chequing.anon.qbo': {
    lines: 63, balance: '8760.46', from: '2026-10-13', to: '2026-11-12',
    about: 'QBO, newest first, a period that ends before it starts (DTSTART after DTEND), values followed by blank lines, transaction ids mixing digits, letters and dashes'
  }
}

const filesIn = (folder: string, pattern: RegExp) =>
  fs.existsSync(path.join(REAL, folder)) ? fs.readdirSync(path.join(REAL, folder)).filter(name => pattern.test(name)).sort().map(name => `${folder}/${name}`) : []
const files = [...filesIn('ofx', /\.(ofx|qfx|qbo)$/i), ...filesIn('csv', /\.csv$/i), ...filesIn('qif', /\.qif$/i)]

/**
 * Reads a real file with its format: for CSV, confirming the layout guessed, and keeping what the dialog was given; for
 * QIF, answering QIF Options as it offers.
 */
async function parse(name: string): Promise<{ result: ParseResult, dialog?: LayoutDialogInput }> {
  const file = fixtureFile(path.join(REAL, name))
  if (name.startsWith('ofx/')) return { result: (await ofxFormat.parse(file, {} as ParseContext)) as ParseResult }
  if (name.startsWith('qif/')) {
    const memory = new Map<string, unknown>()
    const context = {
      memory: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => { memory.set(k, v) } },
      prompt: async (_: string, i: { dates?: { value: string }, decimal?: { value: string } }) => ({ kind: 'options', dateOrder: i.dates?.value, decimal: i.decimal?.value })
    } as unknown as ParseContext
    return { result: (await createQifFormat({ now: NOW }).parse(file, context)) as ParseResult }
  }
  let dialog: LayoutDialogInput | undefined
  const memory = new Map<string, unknown>()
  const context = {
    memory: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => { memory.set(k, v) } },
    prompt: async (_: string, input: LayoutDialogInput) => { dialog = input; return { kind: 'layout', layout: input.layout } }
  } as unknown as ParseContext
  return { result: (await createCsvFormat({ now: NOW }).parse(file, context)) as ParseResult, dialog }
}

describe('the real statements kept as fixtures', () => {
  it('are each described in this test', () => {
    expect([...files].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  describe.each(files)('%s', name => {
    const expected = EXPECTED[name]

    it('reads cleanly: every line, no warnings, the period its lines cover', async () => {
      const { result, dialog } = await parse(name)
      expect((result.warnings ?? []).map(w => w.message)).toEqual(expected.warnings ?? [])
      expect(result.statements).toHaveLength(expected.statements ?? 1)
      const [statement] = result.statements
      const lines = result.statements.flatMap(s => s.lines)
      expect(lines).toHaveLength(expected.lines)
      expect(statement.balance?.amount).toBe(expected.balance)
      for (const line of lines) expect(isCanonicalDecimal(line.amount), line.amount).toBe(true)
      const dates = lines.map(l => l.date).sort()
      expect([dates[0], dates[dates.length - 1]]).toEqual([expected.from, expected.to])
      if (statement.period?.from && statement.period.to) expect(statement.period.from <= statement.period.to).toBe(true)
      if (dialog) {
        expect(dialog.layout).toMatchObject(expected.layout ?? {})
        if (expected.sure !== undefined) expect(dialog.uncertain.length === 0, JSON.stringify(dialog.uncertain)).toBe(expected.sure)
      }
    })

    it('imports into a new account at the bank’s balance, and adds nothing the second time', async () => {
      const env = await setupImport({ csv: true, qif: true })
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-real-')), path.basename(name))
      fs.writeFileSync(file, fixtureBytes(path.join(REAL, name)))                 // the bank's own bytes
      // Each statement into a new account the first time; into the same one, as the dialog offers, after that. A
      // file's categories are taken, where the user is asked
      const count = expected.statements ?? 1
      env.answer(IMPORT_DIALOGS.account, ...Array.from({ length: count }, () => ({ kind: 'create', remember: true })))
      env.answer(IMPORT_DIALOGS.categories, ...Array.from({ length: count }, () => ({ source: 'file', remember: true })))
      const first = await env.manager.importFiles([file])
      expect(first!.results.map(r => r.outcome)).toEqual(Array.from({ length: count }, () => 'imported'))
      expect(first!.results.reduce((n, r) => n + r.counts.added, 0)).toBe(expected.lines)
      const [account] = await env.accounts.list()
      const [{ balances }] = (await env.accounts.chart()).accounts.filter(s => s.account.id === account.id)
      if (expected.balance !== undefined) expect((balances.current / 100).toFixed(2)).toBe(expected.balance)
      // A CSV file without an account column, and a QIF file, are asked about again: into the same accounts
      env.answer(IMPORT_DIALOGS.account, ...Array.from({ length: count }, () => (input: { preselectedId: string }) => ({ kind: 'account', accountId: input.preselectedId, remember: true })))
      const again = await env.manager.importFiles([file])
      expect(again!.results.reduce((n, r) => n + r.counts.added, 0)).toBe(0)
      expect(again!.results.reduce((n, r) => n + r.counts.duplicates, 0)).toBe(expected.lines)
    })
  })
})
