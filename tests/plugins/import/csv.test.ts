// @vitest-environment node
// CSV statements imported (docs/import-formats-design.md, phase F4), with the ledger, accounts, import, OFX and CSV
// plugins activated together, on the sample statements: the CSV Columns dialog for every file, the Account dialog as a
// weak key asks for it, overlapping exports, an account column found by number, a CSV and an OFX export of one account
// (Already imported?), a card's export the wrong way round (Amounts Reversed?, kept by the layout), and a CSV named .txt.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccountInput } from '@tessera/accounts-api'
import { IMPORT_DIALOGS, type AccountDialogInput } from '@tessera/import-api'
import { LAYOUT_DIALOG, firstLine, type LayoutDialogInput } from '../../../plugins/format-csv/src/shared/dialog'
import { readCsv, valuesOf } from '../../../plugins/format-csv/src/shared/csv'
import { ROLE_NAMES, rolesOf } from '../../../plugins/format-csv/src/shared/layout'
import { readLines } from '../../../plugins/format-csv/src/shared/lines'
import { describe as describeResult } from '../../../plugins/import/src/renderer/SummaryDialog'
import { sample, setupImport, type ImportEnv } from './harness'

const OCTOBER = sample('maple-trust-chequing-2026-10.csv')
const NOVEMBER = sample('maple-trust-chequing-2026-11.csv')
const balanceOf = async (env: ImportEnv, accountId: string) => (await env.accounts.chart()).accounts.find(s => s.account.id === accountId)!.balances.current
/** The Account dialog's answer: the account it chose to begin with. */
const preselected = (remember: boolean) => (input: AccountDialogInput) => ({ kind: 'account', accountId: input.preselectedId, remember })

describe('a CSV export', () => {
  it('shows the CSV Columns dialog, titled with the file, then the Account dialog', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    const report = await env.manager.importFiles([OCTOBER])
    expect(env.shown.map(s => s.id)).toEqual([LAYOUT_DIALOG, IMPORT_DIALOGS.account, 'accounts.dialog.account', IMPORT_DIALOGS.summary])
    const [layout] = env.dialogs(LAYOUT_DIALOG)
    expect(layout.options).toEqual({ title: 'CSV Columns: maple-trust-chequing-2026-10.csv' })
    expect((layout.input as LayoutDialogInput).start).toBe('recognised')
    expect(env.dialogs(IMPORT_DIALOGS.account)[0].input.remember).toEqual({ strength: 'weak', checked: false, label: 'Don\'t ask again for files like this one' })
    expect(report!.results[0]).toMatchObject({
      outcome: 'imported', counts: { lines: 17, added: 17 },
      warnings: ['1 pending transaction was left out; it\'ll come with a later export, once the bank posts it.']
    })
    const [account] = await env.accounts.list()
    expect(await balanceOf(env, account.id)).toBe(467780)
    expect(account.openingBalance).toBe(100000)
  })

  it('asks again the next time, with the account chosen last time and the layout remembered, and adds the overlap once', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    await env.manager.importFiles([OCTOBER])
    const report = await env.manager.importFiles([NOVEMBER])
    const [, asked] = env.dialogs(IMPORT_DIALOGS.account)
    const [account] = await env.accounts.list()
    expect(asked.input.preselectedId).toBe(account.id)
    expect(asked.input.choices[0].hint).toBe('Used last time')
    expect((env.dialogs(LAYOUT_DIALOG)[1].input as LayoutDialogInput).start).toBe('remembered')
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { lines: 10, added: 5, duplicates: 5 } })
    expect(await balanceOf(env, account.id)).toBe(624174)
  })

  it('doesn’t ask which account once told not to, but still shows its columns', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(true))
    await env.manager.importFiles([OCTOBER])
    await env.manager.importFiles([NOVEMBER])
    const again = await env.manager.importFiles([NOVEMBER])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(2)
    expect(env.dialogs(LAYOUT_DIALOG)).toHaveLength(3)
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 10 } })
  })

  it('is skipped, or stops the import, as its CSV Columns dialog says', async () => {
    const env = await setupImport({ csv: true })
    env.answer(LAYOUT_DIALOG, { kind: 'skip' }, undefined)
    const report = await env.manager.importFiles([OCTOBER, NOVEMBER, sample('harbour-bank-2026-10.csv')])
    expect(report!.results.map(r => [r.source, r.outcome])).toEqual([
      ['maple-trust-chequing-2026-10.csv', 'skipped'], ['maple-trust-chequing-2026-11.csv', 'cancelled']
    ])
    expect(await env.accounts.list()).toEqual([])
  })
})

describe('a CSV export beside other exports of the same accounts', () => {
  it('with an account number column: each statement goes to the account with that number, without asking', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true }, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('harbour-bank-2026-10.ofx')])
    env.shown.length = 0
    const report = await env.manager.importFiles([sample('harbour-bank-2026-10.csv')])
    expect(env.shown.map(s => s.id)).toEqual([LAYOUT_DIALOG, IMPORT_DIALOGS.summary])
    // The same lines, from the bank's OFX export: proposed as already imported, nothing added
    expect(report!.results.map(r => [r.outcome, r.accountName, r.counts.added, r.counts.alreadyImported])).toEqual([
      ['imported', 'Harbour Bank 4410', 0, 5], ['imported', 'Harbour Bank 4411', 0, 2]
    ])
  })

  it('a CSV export, then the OFX one overlapping it: the overlap is proposed as already imported', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    await env.manager.importFiles([OCTOBER])
    const report = await env.manager.importFiles([sample('maple-trust-chequing-2026-11.ofx')])
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { lines: 10, added: 5, alreadyImported: 5 } })
  })
})

describe('a card’s CSV export with charges positive', () => {
  it('confirmed without “amounts reversed” into a card: Amounts Reversed? asks, and the layout keeps the answer', async () => {
    const env = await setupImport({ csv: true })
    const card = await env.accounts.createAccount({ name: 'Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000 } as AccountInput)
    env.answer(LAYOUT_DIALOG, (input: LayoutDialogInput) => ({ kind: 'layout', layout: { ...input.layout, reversed: false } }))
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: card.id, remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    expect(env.dialogs(IMPORT_DIALOGS.signs)[0].input.reasons).toEqual(['6 of its 8 lines would lower what you owe, and only 2 would add to it.'])
    expect(report!.results[0]).toMatchObject({ counts: { added: 8 }, reversed: { decidedBy: 'asked', remembered: true } })
    expect(await balanceOf(env, card.id)).toBe(-46477)
    // The CSV format kept the correction in the layout: the next CSV Columns dialog shows it, and nothing is asked
    const again = await env.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    expect(env.dialogs(LAYOUT_DIALOG)[1].input).toMatchObject({ start: 'remembered', layout: { reversed: true } })
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 8 } })
    expect(again!.results[0]).not.toHaveProperty('reversed')
  })

  it('confirmed as the guess says, reversed: imported right, with no question', async () => {
    const env = await setupImport({ csv: true })
    const card = await env.accounts.createAccount({ name: 'Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000 } as AccountInput)
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: card.id, remember: true })
    await env.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toEqual([])
    expect(await balanceOf(env, card.id)).toBe(-46477)
  })
})

describe('a CSV export named .txt', () => {
  it('isn’t listed as a statement, and imports through All files: sniffed as CSV', async () => {
    const env = await setupImport({ csv: true })
    expect(env.manager.formats().find(f => f.id === 'format-csv.csv')?.extensions).toEqual(['csv'])
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-txt-')), 'export.txt')
    fs.copyFileSync(sample('northwind-visa-2026-10.csv'), file)
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const report = await env.manager.importFiles([file])
    expect(env.dialogs(IMPORT_DIALOGS.format)).toEqual([])
    expect(env.dialogs(LAYOUT_DIALOG)).toHaveLength(1)
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 8 } })
  })
})

describe('the samples README’s walkthrough (samples/statements, “CSV files”)', () => {
  const layoutInput = (env: ImportEnv, n = 0) => env.dialogs(LAYOUT_DIALOG)[n].input as LayoutDialogInput
  const read = (input: LayoutDialogInput) => {
    const { rows } = readCsv(input.text, input.layout.delimiter)
    return readLines(rows.map(valuesOf), input.layout, input.pivot)
  }

  it('two months of a chequing account', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    const october = await env.manager.importFiles([OCTOBER])
    const first = layoutInput(env)
    expect(firstLine(first)).toBe('Tessera recognised these columns. Check the preview, then Import: they’ll be remembered for files like this.')
    expect(rolesOf(first.layout, 6).map(r => r && ROLE_NAMES[r])).toEqual(['Date', 'Payee', 'Money out', 'Money in', 'Balance', 'Status'])
    expect(first.layout.dateOrder).toBe('MDY')
    const preview = read(first)
    expect([preview.statements[0].lines.length, preview.statements[0].balance]).toEqual([17, { amount: '4677.80', asOf: '2026-10-31' }])
    expect(preview.leftOut.filter(l => !l.quiet).map(l => `Row ${l.row + 1}: ${l.reason}`)).toEqual(['Row 19: It is pending: it will come with a later export, once the bank posts it.'])
    expect(env.dialogs(IMPORT_DIALOGS.account)[0].input.statement.label).toBe('CSV file with columns Date, Description, Withdrawals, Deposits, Balance, Status')
    expect(env.dialogs('accounts.dialog.account')[0].input.initial).toEqual({ currency: 'CAD', openingDate: '2026-10-01', openingBalance: 100000 })
    expect(describeResult(october!.results[0])).toBe('17 transactions added to “Chequing”.')
    expect(october!.results[0].warnings).toEqual(['1 pending transaction was left out; it\'ll come with a later export, once the bank posts it.'])

    const november = await env.manager.importFiles([NOVEMBER])
    expect(firstLine(layoutInput(env, 1))).toMatch(/^Same columns as last time \(files like this one, last imported 6 Nov 2026\)/)
    expect(env.dialogs(IMPORT_DIALOGS.account)[1].input.choices[0]).toMatchObject({ account: { name: 'Chequing' }, hint: 'Used last time' })
    expect(env.dialogs(IMPORT_DIALOGS.account)[1].input.remember.label).toBe('Don\'t ask again for files like this one')
    expect(describeResult(november!.results[0])).toBe('5 transactions added to “Chequing”, 5 already imported.')
    const [account] = await env.accounts.list()
    expect(await balanceOf(env, account.id)).toBe(624174)
    expect((await env.transactions(account.id)).filter(t => t.date === '2026-11-02' && t.amount === -9136)).toHaveLength(1)
  })

  it('a CSV export, then the bank’s OFX', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    await env.manager.importFiles([OCTOBER])
    const report = await env.manager.importFiles([sample('maple-trust-chequing-2026-11.ofx')])
    expect(describeResult(report!.results[0])).toBe('5 transactions added to “Chequing”, 5 looked like transactions imported before from another file and weren’t added: check them in the register.')
    const [account] = await env.accounts.list()
    expect(await balanceOf(env, account.id)).toBe(624174)
  })

  it('in French', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    const report = await env.manager.importFiles([sample('maple-trust-cheques-2026-10-fr.csv')])
    const input = layoutInput(env)
    expect(input.start).toBe('recognised')
    expect(input.layout).toMatchObject({ skip: 3, header: true, delimiter: ';', dateOrder: 'DMY', decimal: ',' })
    const preview = read(input)
    expect([preview.statements[0].lines.length, preview.statements[0].balance?.amount]).toEqual([8, '4717.71'])
    expect(describeResult(report!.results[0])).toBe('8 transactions added to “Chequing”.')
    const [account] = await env.accounts.list()
    expect(await balanceOf(env, account.id)).toBe(471771)
  })

  it('a card’s export, without a header, charges positive; and the sign check catching it instead', async () => {
    const createCard = (env: ImportEnv) => async (input: { subLedgerId: string | null, initial: Partial<AccountInput> }) =>
      ({ id: (await env.accounts.createAccount({ subLedgerId: input.subLedgerId, ...input.initial, name: 'Northwind Visa', type: 'creditCard', openingBalance: -54000 } as AccountInput)).id })
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    env.answer('accounts.dialog.account', createCard(env))
    const report = await env.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    const input = layoutInput(env)
    expect(firstLine(input)).toMatch(/^Tessera guessed these columns\. Check the highlighted ones and the preview/)
    expect(rolesOf(input.layout, 3).map(r => r && ROLE_NAMES[r])).toEqual(['Date', 'Payee', 'Amount'])
    expect(input.layout.reversed).toBe(true)
    expect(input.uncertain[0].why).toMatch(/^6 of the 8 amounts are positive\. Most lines in an account are money out, so money out is probably shown as positive here\./)
    expect(read(input).statements[0].lines[0].line).toMatchObject({ payee: 'AIR CANADA 0142325781', amount: '-128.44' })
    expect(describeResult(report!.results[0])).toBe('8 transactions added to “Northwind Visa”.')
    const [card] = await env.accounts.list()
    expect(await balanceOf(env, card.id)).toBe(-46477)

    // Unticked: the sign check asks, and the layout keeps the answer
    const other = await setupImport({ csv: true })
    other.answer(LAYOUT_DIALOG, (i: LayoutDialogInput) => ({ kind: 'layout', layout: { ...i.layout, reversed: false } }))
    other.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    other.answer('accounts.dialog.account', createCard(other))
    other.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    await other.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    expect(other.dialogs(IMPORT_DIALOGS.signs)[0].input.reasons).toEqual(['6 of its 8 lines would lower what you owe, and only 2 would add to it.'])
    const [otherCard] = await other.accounts.list()
    expect(await balanceOf(other, otherCard.id)).toBe(-46477)
    await other.manager.importFiles([sample('northwind-visa-2026-10.csv')])
    expect(layoutInput(other, 1)).toMatchObject({ start: 'remembered', layout: { reversed: true } })
    expect(other.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)
  })

  it('two accounts in one file', async () => {
    const env = await setupImport({ csv: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true }, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('harbour-bank-2026-10.ofx')])
    const report = await env.manager.importFiles([sample('harbour-bank-2026-10.csv')])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(2)
    expect(report!.results.map(describeResult)).toEqual([
      'Nothing added to “Harbour Bank 4410”, 5 looked like transactions imported before from another file and weren’t added: check them in the register.',
      'Nothing added to “Harbour Bank 4411”, 2 looked like transactions imported before from another file and weren’t added: check them in the register.'
    ])
  })
})
