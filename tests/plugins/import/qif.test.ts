// @vitest-environment node
// QIF files imported (docs/import-formats-design.md, phase F5), with the ledger, accounts, import, OFX and QIF plugins
// activated together, on the sample files: a Money-style account into a new account (its opening balance, its
// categories once the user says so), a Quicken whole-file export (a statement per account), the Money file then the
// bank's OFX (Already imported?, cheques by number), and a bank's card file the wrong way round (Amounts Reversed?,
// kept in the QIF options).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureBytes } from '../../helpers/importFile'
import { ACCOUNTS_DIALOGS, categoryLabel, type AccountInput } from '@tessera/accounts-api'
import { IMPORT_DIALOGS, type AccountDialogInput } from '@tessera/import-api'
import { OPTIONS_DIALOG } from '../../../plugins/format-qif/src/shared/options'
import { describe as describeResult, describeCategories, describeReversed } from '../../../plugins/import/src/renderer/SummaryDialog'
import { describeOffer } from '../../../plugins/import/src/renderer/CategoriesDialog'
import { sample, setupImport, type ImportEnv } from './harness'

const MONEY = sample('maple-trust-chequing-2026-09.qif')
const QUICKEN = sample('household-quicken-export.qif')
const CARD = sample('northwind-visa-2026-09.qif')
const balanceOf = async (env: ImportEnv, accountId: string) => (await env.accounts.chart()).accounts.find(s => s.account.id === accountId)!.balances.current
const preselected = (remember: boolean) => (input: AccountDialogInput) => ({ kind: 'account', accountId: input.preselectedId, remember })

/** Every transaction's payee and category, in register order. */
async function labels(env: ImportEnv, accountId: string) {
  const [payees, categories] = await Promise.all([env.accounts.payees.search('', 1000), env.accounts.categories.list()])
  return (await env.transactions(accountId)).map(t => [t.date, payees.find(p => p.id === t.payeeId)?.name, categoryLabel(categories, t.categoryId), t.memo])
}

describe('a Money-style export of one account', () => {
  it('makes the account from the file: its name, type and opening balance, and asks whether to use the file’s categories', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    const report = await env.manager.importFiles([MONEY])
    expect(env.dialogs(OPTIONS_DIALOG)).toEqual([])
    expect(env.dialogs(IMPORT_DIALOGS.account)[0].input.statement).toMatchObject({ label: 'Maple Trust Chequing', typeLabel: 'Chequing', lineCount: 17 })
    expect(env.dialogs(ACCOUNTS_DIALOGS.account)[0].input.initial).toEqual({
      name: 'Maple Trust Chequing', type: 'chequing', currency: 'CAD', openingDate: '2026-09-01', openingBalance: 72073
    })
    expect(env.dialogs(IMPORT_DIALOGS.categories)[0].input).toMatchObject({ fileName: 'maple-trust-chequing-2026-09.qif', offered: 14, differing: 0 })
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 17 }, categories: { source: 'file', offered: 14 } })
    const account = await env.account('Maple Trust Chequing')
    expect(await balanceOf(env, account.id)).toBe(265838)
    const rows = await labels(env, account.id)
    expect(rows[0]).toEqual(['2026-09-02', 'Landlord', 'Housing : Rent', 'September rent'])
    expect(rows.find(r => r[1] === 'Costco' && r[0] === '2026-09-05')).toEqual(['2026-09-05', 'Costco', undefined, 'Weekly shop · Split: Food:Groceries 64.12 · Household 20.00'])
    expect(rows.find(r => r[0] === '2026-10-05')).toEqual(['2026-10-05', 'Costco', 'Food : Groceries', undefined])
  })

  it('adds nothing when imported again', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    env.answer(IMPORT_DIALOGS.categories, { source: 'payee', remember: true })
    await env.manager.importFiles([MONEY])
    const again = await env.manager.importFiles([MONEY])
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 17 } })
  })

  it('in a ledger where Costco is usually something else: the file’s category is used once the user chooses it', async () => {
    const env = await setupImport({ qif: true })
    const other = await env.accounts.createAccount({ name: 'Other', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 } as AccountInput)
    const categories = await env.accounts.categories.list()
    await env.accounts.transactions(other.id).create({ date: '2026-08-01', amount: -2000, payee: 'Costco', categoryId: categories.find(c => categoryLabel(categories, c.id) === 'Personal : Clothing')!.id })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    await env.manager.importFiles([MONEY])
    expect(env.dialogs(IMPORT_DIALOGS.categories)[0].input.examples[0]).toEqual({ payee: 'Costco', file: 'Food : Groceries', usual: 'Personal : Clothing' })
    const account = await env.account('Maple Trust Chequing')
    expect((await labels(env, account.id)).find(r => r[0] === '2026-10-05')?.[2]).toBe('Food : Groceries')
  })
})

describe('a Quicken whole-file export', () => {
  it('gives a statement per account, asking for each, and leaves the investment account out', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, { kind: 'create', remember: false }, { kind: 'create', remember: false })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'file', remember: true }, { source: 'file', remember: true })
    const report = await env.manager.importFiles([QUICKEN])
    expect(env.dialogs(IMPORT_DIALOGS.account).map(d => [d.options?.title, d.input.statement.label])).toEqual([
      ['Statement 1 of 3: which account is it for?', 'Everyday Chequing'],
      ['Statement 2 of 3: which account is it for?', 'High Interest Savings'],
      ['Statement 3 of 3: which account is it for?', 'Northwind Visa']
    ])
    expect(report!.results.map(r => [r.accountName, r.outcome, r.counts.added])).toEqual([
      ['Everyday Chequing', 'imported', 10], ['High Interest Savings', 'imported', 2], ['Northwind Visa', 'imported', 5]
    ])
    expect(report!.results[0].warnings).toEqual(['Line 214: An investment account (“RRSP”) was left out: Tessera doesn\'t import investment transactions yet.'])
    const balances = await Promise.all(['Everyday Chequing', 'High Interest Savings', 'Northwind Visa'].map(async n => balanceOf(env, (await env.account(n)).id)))
    expect(balances).toEqual([253945, 850412, -35782])
    expect((await env.account('High Interest Savings')).type).toBe('savings')
    expect((await env.account('Northwind Visa')).type).toBe('creditCard')
  })
})

describe('a Money export, then the bank’s OFX for the month it runs into', () => {
  it('proposes the overlap as already imported, the cheque by its number, and ends at the bank’s balance', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(true))
    env.answer(IMPORT_DIALOGS.categories, { source: 'payee', remember: true })
    await env.manager.importFiles([MONEY])
    const report = await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { lines: 17, added: 13, alreadyImported: 4 } })
    expect(describeResult(report!.results[0])).toBe('13 transactions added to “Maple Trust Chequing”, 4 looked like transactions imported before from another file and weren’t added: check them in the register.')
    const account = await env.account('Maple Trust Chequing')
    expect(await balanceOf(env, account.id)).toBe(467780)
  })
})

describe('a bank’s card file with charges positive', () => {
  it('is caught by the sign check on its first import; the answer is kept in the QIF options, so the next is read reversed', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(ACCOUNTS_DIALOGS.account, async (input: { subLedgerId: string | null, initial: Partial<AccountInput> }) =>
      ({ id: (await env.accounts.createAccount({ subLedgerId: input.subLedgerId, ...input.initial, name: 'Northwind Visa', openingBalance: -45000 } as AccountInput)).id }))
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([CARD])
    expect(env.dialogs(OPTIONS_DIALOG)).toEqual([])
    expect(env.dialogs(ACCOUNTS_DIALOGS.account)[0].input.initial).toMatchObject({ type: 'creditCard' })
    expect(env.dialogs(IMPORT_DIALOGS.signs)[0].input.reasons).toEqual(['7 of its 8 lines would lower what you owe, and only 1 would add to it.'])
    expect(report!.results[0]).toMatchObject({ counts: { added: 8 }, reversed: { decidedBy: 'asked', remembered: true } })
    const card = await env.account('Northwind Visa')
    expect(await balanceOf(env, card.id)).toBe(-45000 - 36181 + 45000)
    const again = await env.manager.importFiles([sample('northwind-visa-2026-09.qif')])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 8 } })
    expect(again!.results[0]).not.toHaveProperty('reversed')
  })
})

describe('a QIF file whose dates read two ways', () => {
  it('asks in QIF Options, before the account, and not again for the same source', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
    expect(env.shown.map(s => s.id).slice(0, 2)).toEqual([OPTIONS_DIALOG, IMPORT_DIALOGS.account])
    expect(env.dialogs(OPTIONS_DIALOG)[0].options).toEqual({ title: 'QIF Options: cedar-savings-2026-08-12.qif' })
    await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
    expect(env.dialogs(OPTIONS_DIALOG)).toHaveLength(1)
  })
})

describe('the samples README’s walkthrough (samples/statements, “Bringing accounts over from Money or Quicken”)', () => {
  it('one account from Money, then the bank’s own file', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    const money = await env.manager.importFiles([MONEY])
    expect(env.dialogs(OPTIONS_DIALOG)).toEqual([])
    expect(env.dialogs(IMPORT_DIALOGS.account)[0].input.statement).toMatchObject({ label: 'Maple Trust Chequing', typeLabel: 'Chequing' })
    expect(env.dialogs(ACCOUNTS_DIALOGS.account)[0].input.initial).toMatchObject({ name: 'Maple Trust Chequing', openingDate: '2026-09-01', openingBalance: 72073 })
    const asked = env.dialogs(IMPORT_DIALOGS.categories)[0].input
    expect(describeOffer(asked)).toBe('maple-trust-chequing-2026-09.qif gives a category for 14 new transactions, and your ledger has them.')
    expect(asked.examples.slice(0, 2)).toEqual([{ payee: 'Landlord', file: 'Housing : Rent' }, { payee: 'Northern Lights Payroll', file: 'Salary' }])
    expect(describeResult(money!.results[0])).toBe('17 transactions added to “Maple Trust Chequing”.')
    expect(describeCategories(money!.results[0].categories!)).toBe('14 new transactions took their categories from the file, as you chose for “Maple Trust Chequing”.')
    const account = await env.account('Maple Trust Chequing')
    expect(await balanceOf(env, account.id)).toBe(265838)
    expect((await labels(env, account.id)).find(r => r[0] === '2026-09-05')?.slice(2)).toEqual([undefined, 'Weekly shop · Split: Food:Groceries 64.12 · Household 20.00'])

    const ofx = await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    expect(describeResult(ofx!.results[0])).toBe('13 transactions added to “Maple Trust Chequing”, 4 looked like transactions imported before from another file and weren’t added: check them in the register.')
    expect(await balanceOf(env, account.id)).toBe(467780)
  })

  it('a whole Quicken file', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, { kind: 'create', remember: false }, { kind: 'create', remember: false })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'file', remember: true }, { source: 'file', remember: true })
    const report = await env.manager.importFiles([QUICKEN])
    expect(report!.results.map(describeResult)).toEqual([
      '10 transactions added to “Everyday Chequing”.', '2 transactions added to “High Interest Savings”.', '5 transactions added to “Northwind Visa”.'
    ])
    expect(report!.results[0].warnings[0]).toMatch(/An investment account \(“RRSP”\) was left out: Tessera doesn't import investment transactions yet\.$/)
  })

  it('a bank’s card file, the wrong way round', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(ACCOUNTS_DIALOGS.account, async (input: { subLedgerId: string | null, initial: Partial<AccountInput> }) =>
      ({ id: (await env.accounts.createAccount({ subLedgerId: input.subLedgerId, ...input.initial, name: 'Northwind Visa', openingBalance: -45000 } as AccountInput)).id }))
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([CARD])
    expect(describeReversed(report!.results[0].reversed!)).toBe('Amounts reversed, as you chose; files like this one will be too.')
    expect(await balanceOf(env, (await env.account('Northwind Visa')).id)).toBe(-36181)
  })

  it('a file whose dates read two ways', async () => {
    const env = await setupImport({ qif: true })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
    const dates = env.dialogs(OPTIONS_DIALOG)[0].input.dates
    expect(dates.value).toBe('DMY')
    expect(dates.choices.find((c: { value: string }) => c.value === 'DMY').label).toBe('Day/Month/Year: 01/08/2026 is Aug 1, 2026')
    await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
    expect(env.dialogs(OPTIONS_DIALOG)).toHaveLength(1)
  })
})

describe('a real Money account, exported loose and strict (tests/fixtures/import/real/qif)', () => {
  it('imported one after the other, adds nothing twice: the strict export’s lines are known, its cut split memos proposed', async () => {
    const env = await setupImport({ qif: true })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-money-'))
    const [loose, strict] = ['current_loose.anon.qif', 'current_strict.anon.qif'].map(name => {
      const file = path.join(dir, name)
      fs.writeFileSync(file, fixtureBytes(path.resolve(__dirname, '../../fixtures/import/real/qif', name)))
      return file
    })
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false }, preselected(false))
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'file', remember: true })
    const first = await env.manager.importFiles([loose])
    expect(first!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 466 } })
    // The strict export names the account cut to 15 characters: another source, so the Account dialog asks
    const second = await env.manager.importFiles([strict])
    expect(env.dialogs(IMPORT_DIALOGS.account)[1].input.statement.label).not.toBe(env.dialogs(IMPORT_DIALOGS.account)[0].input.statement.label)
    expect(second!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 0, duplicates: 458, alreadyImported: 8 } })
  })
})
