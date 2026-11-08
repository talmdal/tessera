// @vitest-environment node
// Importing the sample statements (samples/statements) with the ledger, accounts, import and OFX plugins activated
// together: the account is found or chosen and remembered, lines are added once, and problems are reported file by
// file. These are the phase's manual checks, automated.
import { describe, expect, it } from 'vitest'
import { ACCOUNTS_DIALOGS, categoryLabel, type AccountInput } from '@tessera/accounts-api'
import { IMPORT_DIALOGS, IMPORT_FORMATS_POINT, IMPORT_STATE_KEYS, isImportError, type AccountDialogInput, type ImportReport } from '@tessera/import-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { sample, setupImport, type ImportEnv } from './harness'

const OCTOBER = sample('maple-trust-chequing-2026-10.ofx')
const NOVEMBER = sample('maple-trust-chequing-2026-11.ofx')
const VISA = sample('northwind-visa-2026-10.qfx')
const HARBOUR = sample('harbour-bank-2026-10.ofx')

const chequing = (over: Partial<AccountInput> = {}): AccountInput =>
  ({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000, ...over })

const outcome = (report: ImportReport | undefined) =>
  report!.results.map(r => ({ source: r.source, outcome: r.outcome, added: r.counts.added, duplicates: r.counts.duplicates, account: r.accountName }))

/** Imports the October chequing statement into a new account made from it, as a first-time user would. */
async function firstImport(env: ImportEnv) {
  env.answer(IMPORT_DIALOGS.account, { kind: 'create' })
  const report = await env.manager.importFiles([OCTOBER])
  return { report, account: await env.account('Maple Trust Bank 5678') }
}

describe('importing a statement for the first time', () => {
  it('asks which account, makes a new one from the statement, and adds every line, electronically cleared', async () => {
    const env = await setupImport()
    const { report, account } = await firstImport(env)

    // The Account dialog said what the file is, and offered to create the account (there was none)
    const [{ input }] = env.dialogs(IMPORT_DIALOGS.account) as { input: AccountDialogInput }[]
    expect(input).toMatchObject({
      fileName: 'maple-trust-chequing-2026-10.ofx', formatLabel: 'OFX / QFX statement (Microsoft Money, Quicken)',
      statement: { institution: 'Maple Trust Bank', accountNumber: '•••• 5678', typeLabel: 'Chequing', currency: 'CAD', lineCount: 17, period: { from: '2026-10-01', to: '2026-10-31' } },
      choices: [], remember: { strength: 'strong', label: 'Remember this account for “Maple Trust Bank •••• 5678”', checked: true }
    })
    // The New Account form started from the statement: its opening balance is what makes the bank's closing one
    const [{ input: form }] = env.dialogs(ACCOUNTS_DIALOGS.account)
    expect(form.initial).toEqual({
      name: 'Maple Trust Bank 5678', type: 'chequing', currency: 'CAD', institution: 'Maple Trust Bank', accountNumber: '8812345678',
      openingDate: '2026-10-01', openingBalance: 100000
    })

    expect(outcome(report)).toEqual([{ source: 'maple-trust-chequing-2026-10.ofx', outcome: 'imported', added: 17, duplicates: 0, account: 'Maple Trust Bank 5678' }])
    const added = await env.transactions(account.id)
    expect(added).toHaveLength(17)
    expect(added.every(t => t.status === 'electronic' && t.externalId !== undefined)).toBe(true)
    expect((await env.accounts.balances(account.id)).current).toBe(467780)      // the bank's closing balance, to the cent
    expect(env.dialogs(IMPORT_DIALOGS.summary)).toHaveLength(1)
  })

  it('names payees tidily, and gives fees and interest their categories', async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    const { rows } = await env.accounts.transactions(account.id).register()
    const row = (id: string) => rows.find(r => r.transaction.externalId === id)!
    expect(row('MT2026100601').payeeName).toBe('Costco Whse')                   // the bank put the city in the memo
    expect(row('MT2026101201').payeeName).toBe('Café Dépôt')
    expect(row('MT2026100201')).toMatchObject({ payeeName: 'Cheque', transaction: { number: '101' } })
    expect(row('MT2026103101').categoryLabel).toBe('Bank fees')
    expect(row('MT2026103102').categoryLabel).toBe('Interest')
    // One payee for the two identical coffees and the two paycheques
    const payees = (await env.accounts.payees.search('', 1000)).map(p => p.name)
    expect(payees.filter(p => p.startsWith('Tim Hortons'))).toEqual(['Tim Hortons'])
    expect(payees.filter(p => p.startsWith('Northern Lights'))).toEqual(['Northern Lights Payroll'])
  })

  it('finds the account by its number, without asking, when one account has it', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing({ accountNumber: '88-1234-5678' }))
    const report = await env.manager.importFiles([OCTOBER])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toEqual([])
    expect(outcome(report)).toMatchObject([{ outcome: 'imported', added: 17, account: 'Chequing' }])
    expect(await env.transactions(mine.id)).toHaveLength(17)
  })

  it('imports a QFX credit card statement into the card, found by the last digits of its masked number', async () => {
    const env = await setupImport()
    const card = await env.accounts.createAccount(chequing({ name: 'Visa', type: 'creditCard', accountNumber: '4500 1234 5678 3456', openingBalance: -54000 }))
    const report = await env.manager.importFiles([VISA])
    expect(outcome(report)).toMatchObject([{ outcome: 'imported', added: 8, account: 'Visa' }])
    expect((await env.accounts.balances(card.id)).current).toBe(-46477)            // owed, as the bank says
    const { rows } = await env.accounts.transactions(card.id).register()
    expect(rows.find(r => r.transaction.externalId === 'NWV20261031F1')?.categoryLabel).toBe('Bank fees')
  })

  it('fills in a new card from a QFX statement as the samples README says: owing what it owed before the statement', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([VISA])
    const [{ input: form }] = env.dialogs(ACCOUNTS_DIALOGS.account)
    expect(form.initial).toEqual({
      name: 'Northwind Card Services 3456', type: 'creditCard', currency: 'CAD', institution: 'Northwind Card Services',
      accountNumber: '3456', openingDate: '2026-10-02', openingBalance: -54000
    })
    expect((await env.accounts.balances((await env.account('Northwind Card Services 3456')).id)).current).toBe(-46477)
  })

  it('asks for each statement in a file with two, and can skip one', async () => {
    const env = await setupImport()
    const chq = await env.accounts.createAccount(chequing({ name: 'Harbour Chequing' }))
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: chq.id, remember: true }, { kind: 'skip' })
    const report = await env.manager.importFiles([HARBOUR])
    expect(env.dialogs(IMPORT_DIALOGS.account).map(d => d.options?.title)).toEqual([
      'Statement 1 of 2: which account is it for?', 'Statement 2 of 2: which account is it for?'
    ])
    expect(outcome(report).map(o => o.outcome)).toEqual(['imported', 'skipped'])
    expect(await env.transactions(chq.id)).toHaveLength(5)
  })
})

describe('importing again', () => {
  it('adds nothing from the same file, and says they were already imported, without asking', async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    const again = await env.manager.importFiles([OCTOBER])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(1)                 // only the first time
    expect(outcome(again)).toEqual([{ source: 'maple-trust-chequing-2026-10.ofx', outcome: 'imported', added: 0, duplicates: 17, account: 'Maple Trust Bank 5678' }])
    expect(await env.transactions(account.id)).toHaveLength(17)
  })

  it("adds only the new lines of next month's file, which overlaps this month's", async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    const report = await env.manager.importFiles([NOVEMBER])
    expect(outcome(report)).toMatchObject([{ outcome: 'imported', added: 5, duplicates: 5 }])
    expect(await env.transactions(account.id)).toHaveLength(22)
    expect((await env.accounts.balances(account.id)).current).toBe(624174)
  })

  it('never brings back a transaction the user deleted', async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    const [first] = await env.transactions(account.id)
    await env.accounts.transactions(account.id).delete([first.id])
    const report = await env.manager.importFiles([OCTOBER])
    expect(outcome(report)).toMatchObject([{ added: 0, duplicates: 17 }])
    expect(await env.transactions(account.id)).toHaveLength(16)
  })

  it("asks again when the saved account is closed, saying why, and again every time when the user didn't ask to remember", async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    await env.accounts.closeAccount(account.id, { confirm: ['closeWithBalance'] })
    const other = await env.accounts.createAccount(chequing({ name: 'New Chequing' }))
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: other.id, remember: false })
    await env.manager.importFiles([NOVEMBER])
    const [, second] = env.dialogs(IMPORT_DIALOGS.account)
    expect(second.input.note).toBe('Last time this went to “Maple Trust Bank 5678”, which is closed.')
    expect(second.input.preselectedId).toBe(other.id)
    // Not remembered: the closed account is still the saved one, so the next file asks again
    env.answer(IMPORT_DIALOGS.account, { kind: 'skip' })
    await env.manager.importFiles([NOVEMBER])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(3)
  })

  it('forgets the saved match when its account is deleted', async () => {
    const env = await setupImport()
    const { account } = await firstImport(env)
    await env.accounts.deleteAccount(account.id)
    env.answer(IMPORT_DIALOGS.account, { kind: 'skip' })
    await env.manager.importFiles([OCTOBER])
    const [, again] = env.dialogs(IMPORT_DIALOGS.account)
    expect(again.input.note).toBeUndefined()                                    // nothing to say: it's simply gone
    expect(again.input.choices).toEqual([])
  })
})

describe('files that go wrong', () => {
  it('reports a file it can’t read, a missing file and a file too large, and still imports the others', async () => {
    const env = await setupImport({
      reader: {
        size: async p => p.endsWith('huge.ofx') ? 30 * 1024 * 1024 : p.endsWith('gone.ofx') ? Promise.reject(Object.assign(new Error('no'), { code: 'ENOENT' })) : 100,
        read: async p => p.endsWith('bad.ofx') ? new TextEncoder().encode('not a statement') : new Uint8Array((await import('node:fs')).readFileSync(p))
      }
    })
    const mine = await env.accounts.createAccount(chequing({ accountNumber: '8812345678' }))
    const report = await env.manager.importFiles(['/x/bad.ofx', '/x/gone.ofx', '/x/huge.ofx', OCTOBER])
    expect(report!.results.map(r => [r.source, r.outcome, r.error?.code])).toEqual([
      ['bad.ofx', 'failed', 'UNREADABLE'], ['gone.ofx', 'failed', 'UNREADABLE'], ['huge.ofx', 'failed', 'TOO_LARGE'],
      ['maple-trust-chequing-2026-10.ofx', 'imported', undefined]
    ])
    expect(report!.results[1].error?.message).toBe('gone.ofx no longer exists.')
    expect(await env.transactions(mine.id)).toHaveLength(17)
  })

  it('says when no installed format can read a file', async () => {
    const env = await setupImport()
    const report = await env.manager.importFiles([sample('../../README.md')])
    expect(report!.results[0]).toMatchObject({ outcome: 'failed', error: { code: 'NO_FORMAT', message: "Tessera can't read README.md. It can import: OFX / QFX statement (Microsoft Money, Quicken)." } })
  })

  it('stops at Cancel: the file and those after it are left, what was imported stays', async () => {
    const env = await setupImport()
    const card = await env.accounts.createAccount(chequing({ name: 'Visa', type: 'creditCard', accountNumber: '3456' }))
    env.answer(IMPORT_DIALOGS.account, undefined)                                // Cancel Import
    const report = await env.manager.importFiles([VISA, OCTOBER, NOVEMBER])
    expect(outcome(report).map(o => [o.source, o.outcome])).toEqual([['northwind-visa-2026-10.qfx', 'imported'], ['maple-trust-chequing-2026-10.ofx', 'cancelled']])
    expect(await env.transactions(card.id)).toHaveLength(8)
  })

  it('gives up on a format that takes too long, and asks which format when two could read a file', async () => {
    const env = await setupImport({ parseTimeoutMs: 50 })
    const slow = createPluginContext('slowfmt', env.runtime).context
    slow.services.provide('slowfmt', 'slowfmt.format', { sniff: async () => true, parse: () => new Promise(() => {}) })
    slow.extensions.contribute('slowfmt', IMPORT_FORMATS_POINT, 'slowfmt.ofx', { id: 'slowfmt.ofx', label: 'Slow OFX', extensions: ['ofx'], service: 'slowfmt.format' })
    env.answer(IMPORT_DIALOGS.format, { formatId: 'slowfmt.ofx' })
    const report = await env.manager.importFiles([OCTOBER])
    expect(env.dialogs(IMPORT_DIALOGS.format)[0].input.formats.map((f: { id: string }) => f.id)).toEqual(['import-ofx.ofx', 'slowfmt.ofx'])
    expect(report!.results[0]).toMatchObject({ outcome: 'failed', error: { code: 'UNREADABLE', message: 'maple-trust-chequing-2026-10.ofx took too long to read (more than 0.05 seconds).' } })
  })

  it('runs one import at a time', async () => {
    const env = await setupImport()
    let release: (value: unknown) => void = () => {}
    let asked: () => void = () => {}
    const dialogOpen = new Promise<void>(resolve => { asked = resolve })
    env.answer(IMPORT_DIALOGS.account, () => new Promise(resolve => { release = resolve; asked() }))
    const first = env.manager.importFiles([OCTOBER])
    await dialogOpen                                                            // the first import is waiting on the user
    const second = await env.manager.importFiles([OCTOBER]).catch(err => err)
    expect(isImportError(second) && second.code).toBe('BUSY')
    release({ kind: 'skip' })
    expect(outcome(await first)).toMatchObject([{ outcome: 'skipped' }])
    await expect(env.manager.importFiles([OCTOBER])).resolves.toBeDefined()     // free again
  })
})

describe('the file dialog and the service', () => {
  it('opens in Downloads the first time, then where the last files were, showing only importable files', async () => {
    const env = await setupImport()
    env.files.showOpenFilesDialog.mockResolvedValueOnce([VISA])
    await env.manager.importFiles()
    const [options] = env.files.showOpenFilesDialog.mock.calls[0] as unknown as [{ defaultPath: string, filters: unknown[] }]
    expect(options.defaultPath).toBe(env.files.downloadsPath())
    expect(options.filters[0]).toEqual({ name: 'All supported statements', extensions: ['ofx', 'qfx'] })
    // Kept in the import's context.state, stored as import.lastFolder in app.state
    expect(await env.appState.get(`import.${IMPORT_STATE_KEYS.lastFolder}`)).toBe(sample('').replace(/\/$/, ''))
    // Cancelling the file dialog imports nothing, and shows no summary
    env.files.showOpenFilesDialog.mockResolvedValueOnce([])
    expect(await env.manager.importFiles()).toBeUndefined()
    expect(env.dialogs(IMPORT_DIALOGS.summary)).toHaveLength(1)
  })

  it('lets a plugin import statements it already has, and says when it can’t tell the account without asking', async () => {
    const env = await setupImport()
    const statement = { account: { key: 'bank:conn:1', label: 'Connected account' }, currency: 'CAD', lines: [{ date: '2026-10-05', amount: '-10.00', payee: 'SHOP', externalId: 'C1' }] }
    const alone = await env.manager.importStatements([statement], { label: 'Bank connection' }, { interactive: false })
    expect(alone.results[0]).toMatchObject({ outcome: 'needsAccount' })
    expect(env.dialogs(IMPORT_DIALOGS.account)).toEqual([])
    const mine = await env.accounts.createAccount(chequing())
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: mine.id, remember: true })
    const asked = await env.manager.importStatements([statement], { label: 'Bank connection' })
    expect(asked.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 1 } })
    expect(env.manager.formats()).toEqual([{ id: 'import-ofx.ofx', label: 'OFX / QFX statement (Microsoft Money, Quicken)', extensions: ['ofx', 'qfx'], description: 'The statement files banks offer for Microsoft Money and Quicken.' }])
  })

  it("remembers a statement that doesn't name its account by its file's name, and suggests it next time", async () => {
    const env = await setupImport()
    const fmt = createPluginContext('plainfmt', env.runtime).context
    fmt.services.provide('plainfmt', 'plainfmt.format', { parse: async () => ({ statements: [{ account: {}, lines: [{ date: '2026-10-05', amount: '-1.00', payee: 'X' }] }] }) })
    fmt.extensions.contribute('plainfmt', IMPORT_FORMATS_POINT, 'plainfmt.txt', { id: 'plainfmt.txt', label: 'Plain', extensions: ['md'], service: 'plainfmt.format' })
    const mine = await env.accounts.createAccount(chequing())
    const readme = sample('../../README.md')
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: mine.id, remember: false })
    await env.manager.importFiles([readme])
    env.answer(IMPORT_DIALOGS.account, { kind: 'skip' })
    await env.manager.importFiles([readme])
    const [first, second] = env.dialogs(IMPORT_DIALOGS.account)
    expect(first.input.remember).toEqual({ strength: 'weak', label: 'Don\'t ask again for files named like “README.md”', checked: false })
    expect(second.input.choices[0]).toMatchObject({ account: { id: mine.id }, hint: 'Used last time' })
  })
})

describe('categories the ledger knows', () => {
  it('are the starter categories a new ledger has', async () => {
    const env = await setupImport()
    const categories = await env.accounts.categories.list()
    expect(categories.map(c => categoryLabel(categories, c.id))).toEqual(expect.arrayContaining(['Bank fees', 'Interest', 'Interest paid']))
  })
})
