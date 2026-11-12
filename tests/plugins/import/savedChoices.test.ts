// @vitest-environment node
// Saved Import Choices (docs/import-formats-design.md, phase F6): everything imports remember, listed in one place
// through the import plugin's channels, each changed or forgotten. Forgetting a CSV layout makes the next file start
// from a guess; a QIF option brings its question back; a category choice brings Categories from the File back; a sign
// correction makes the next file be read as it is, and checked. A format that doesn't describe what it keeps has
// nothing listed, and forgetting one thing leaves the rest.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_DIALOGS, type AccountInput } from '@tessera/accounts-api'
import {
  IMPORT_CHANNELS, IMPORT_COMMANDS, IMPORT_DIALOGS,
  type ImportResult, type PayeeAliasView, type RememberedChoice, type SavedLinks
} from '@tessera/import-api'
import { PayeeAliases } from '../../../plugins/import/src/privileged/aliases'
import { DIALOGS, MENUS } from '../../../plugins/import/src/privileged/contributions'
import { collectionsOf } from '../../../plugins/import/src/privileged/store'
import { LAYOUT_DIALOG, type LayoutDialogInput } from '../../../plugins/import-csv/src/shared/dialog'
import { OPTIONS_DIALOG } from '../../../plugins/import-qif/src/shared/options'
import { sample, setupImport, type ImportEnv } from './harness'

/** Asks the import plugin, as the dialog does; a failure throws its message. */
async function ask<T>(env: ImportEnv, channel: string, data?: unknown): Promise<T> {
  const reply = await env.runtime.ipc.dispatch({ channel, data })
  if (!reply.ok) throw new Error(`IPC failed: ${JSON.stringify(reply)}`)
  const result = reply.data as ImportResult<T>
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}
const remembered = (env: ImportEnv) => ask<RememberedChoice[]>(env, IMPORT_CHANNELS.remembered)
const db = (env: ImportEnv) => env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE).database('import')
const preselected = (input: { preselectedId?: string }) => ({ kind: 'account', accountId: input.preselectedId, remember: false })
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, err => err as Error & { code?: string })

/** A ledger where each kind of thing has been remembered once. */
async function ledgerWithChoices() {
  const env = await setupImport({ csv: true, qif: true })
  // A CSV layout, and its account asked about
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: false })
  await env.manager.importFiles([sample('maple-trust-chequing-2026-10.csv')])
  // QIF options (the dates read two ways), and its account, which the file doesn't name
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  env.answer(ACCOUNTS_DIALOGS.account, async (input: { subLedgerId: string | null, initial: Partial<AccountInput> }) =>
    ({ id: (await env.accounts.createAccount({ subLedgerId: input.subLedgerId, ...input.initial, name: 'Cedar Savings', type: 'savings' } as AccountInput)).id }))
  await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
  // A category choice, from a Money export
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
  await env.manager.importFiles([sample('maple-trust-chequing-2026-09.qif')])
  // A sign correction the import manager keeps, as OFX can't
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
  await env.manager.importFiles([sample('northwind-visa-2026-10-reversed.qfx')])
  // A payee name learnt from the bank's text
  await new PayeeAliases(() => db(env), () => '2026-11-06T12:00:00.000Z').learn('POS PURCHASE COSTCO WHSE #0123', 'Costco')
  return env
}

describe('File › Saved Import Choices…', () => {
  it('is a command in the File menu, beside Import…, opening its dialog', async () => {
    expect(MENUS.find(m => m.id === 'import.file.saved')).toMatchObject({ label: 'Saved Import &Choices…', group: 'import.file', command: IMPORT_COMMANDS.manageLinks })
    expect(DIALOGS.find(d => d.id === IMPORT_DIALOGS.links)).toEqual({ id: IMPORT_DIALOGS.links, title: 'Saved Import Choices', module: './SavedChoicesDialog', size: 'lg' })
    const env = await setupImport()
    await env.runtime.commands.execute(IMPORT_COMMANDS.manageLinks)
    expect(env.dialogs(IMPORT_DIALOGS.links)).toHaveLength(1)
  })
})

describe('what imports remember, in one place', () => {
  it('lists every source’s file settings and choices, described, by source, the format’s first', async () => {
    const env = await ledgerWithChoices()
    const choices = await remembered(env)
    const QIF = 'QIF file (Quicken, Microsoft Money)'
    expect(choices.map(({ what, source, detail, owner, categories }) => ({ what, source, detail, owner, ...(categories && { categories }) }))).toEqual([
      { what: 'QIF options', source: 'cedar-savings-2026-08-12', detail: 'Dates day first · a point for decimals', owner: QIF },
      { what: 'How its amounts usually run', source: 'cedar-savings-2026-08-12.qif (no account name)', detail: '50% money out, over 4 lines into “Cedar Savings”: for the sign check', owner: 'Import' },
      { what: 'How its amounts usually run', source: 'CSV file with columns Date, Description, Withdrawals, Deposits, Balance, Status', detail: '82% money out, over 17 lines into “Chequing”: for the sign check', owner: 'Import' },
      {
        what: 'CSV columns', source: 'Date, Description, Withdrawals, Deposits, Balance, Status', owner: 'CSV file (comma-separated values)',
        detail: 'Dates month first · last imported 6 Nov 2026'
      },
      { what: 'QIF options', source: 'Maple Trust Chequing', detail: 'Dates month first · a point for decimals', owner: QIF },
      { what: 'Categories from the file', source: 'Maple Trust Chequing', detail: 'The file\'s categories are used', owner: 'Import', categories: 'file' },
      { what: 'How its amounts usually run', source: 'Maple Trust Chequing', detail: '76% money out, over 17 lines into “Maple Trust Chequing”: for the sign check', owner: 'Import' },
      { what: 'Amounts reversed', source: 'Northwind Card Services •••• 3456', detail: 'Files from it are read the other way round into “Northwind Card Services 3456”', owner: 'Import' }
    ])
  })

  it('lists the saved account matches with the open accounts, and the payee names learnt', async () => {
    const env = await ledgerWithChoices()
    const { links, accounts } = await ask<SavedLinks>(env, IMPORT_CHANNELS.links)
    expect(links.map(l => [l.label, l.accountName, l.autoApply, l.formatLabel])).toEqual(expect.arrayContaining([
      ['Northwind Card Services •••• 3456', 'Northwind Card Services 3456', true, 'OFX / QFX / QBO statement (Microsoft Money, Quicken, QuickBooks)'],
      ['CSV file with columns Date, Description, Withdrawals, Deposits, Balance, Status', 'Chequing', false, 'CSV file (comma-separated values)']
    ]))
    expect(accounts.map(a => a.name).sort()).toEqual(['Cedar Savings', 'Chequing', 'Maple Trust Chequing', 'Northwind Card Services 3456'])
    expect(await ask<PayeeAliasView[]>(env, IMPORT_CHANNELS.aliases)).toEqual([{ id: expect.any(String), bankText: 'costco whse', payeeName: 'Costco', uses: 0, createdAt: '2026-11-06T12:00:00.000Z' }])
  })

  it('lists nothing a format doesn’t describe, nor what a format no longer installed kept', async () => {
    const env = await setupImport()
    const memory = collectionsOf(db(env)).memory
    await memory.insert({ formatId: 'import-ofx.ofx', key: 'anything', value: { x: 1 } })
    await memory.insert({ formatId: 'gone.format', key: 'layout:1', value: {} })
    expect(await remembered(env)).toEqual([])
  })
})

describe('forgetting', () => {
  it('a CSV layout: the next file’s CSV Columns starts from a guess, and the rest is kept', async () => {
    const env = await ledgerWithChoices()
    const before = await remembered(env)
    const layout = before.find(c => c.what === 'CSV columns')!
    await ask(env, IMPORT_CHANNELS.forgetRemembered, { id: layout.id })
    expect((await remembered(env)).map(c => c.id)).toEqual(before.filter(c => c.id !== layout.id).map(c => c.id))
    env.answer(IMPORT_DIALOGS.account, preselected)
    await env.manager.importFiles([sample('maple-trust-chequing-2026-11.csv')])
    expect((env.dialogs(LAYOUT_DIALOG).at(-1)!.input as LayoutDialogInput).start).toBe('recognised')
  })

  it('a QIF option: its question comes back', async () => {
    const env = await ledgerWithChoices()
    const options = (await remembered(env)).find(c => c.source === 'cedar-savings-2026-08-12')!
    await ask(env, IMPORT_CHANNELS.forgetRemembered, { id: options.id })
    await env.manager.importFiles([sample('cedar-savings-2026-08-12.qif')])
    expect(env.dialogs(OPTIONS_DIALOG)).toHaveLength(2)
  })

  it('a category choice: Categories from the File asks again; changed in place, the new answer is used', async () => {
    const env = await ledgerWithChoices()
    const choice = (await remembered(env)).find(c => c.what === 'Categories from the file')!
    await ask(env, IMPORT_CHANNELS.updateRemembered, { id: choice.id, categories: 'payee' })
    expect((await remembered(env)).find(c => c.id === choice.id)).toMatchObject({ categories: 'payee', detail: 'Your usual category for each payee is used' })
    await ask(env, IMPORT_CHANNELS.forgetRemembered, { id: choice.id })
    // The account's next export from Money, with a category the ledger has: asked again
    const next = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-saved-')), 'maple-trust-chequing-2026-10.qif')
    fs.writeFileSync(next, "!Type:Bank\nD10/ 1'26\nT2658.38\nPOpening Balance\nL[Maple Trust Chequing]\n^\nD10/20'26\nT-48.20\nPShell\nLTransportation:Fuel\n^\n")
    env.answer(IMPORT_DIALOGS.account, preselected)
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    await env.manager.importFiles([next])
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toHaveLength(2)
  })

  it('a sign correction: the next file is read as it is, and checked', async () => {
    const env = await ledgerWithChoices()
    const correction = (await remembered(env)).find(c => c.what === 'Amounts reversed')!
    await ask(env, IMPORT_CHANNELS.forgetRemembered, { id: correction.id })
    env.answer(IMPORT_DIALOGS.signs, { reverse: false, remember: true })
    const report = await env.manager.importFiles([sample('northwind-visa-2026-11.qfx')])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)          // only October's: November is right, and isn't reversed
    expect(report!.results[0]).not.toHaveProperty('reversed')
  })

  it('a saved account match: pointed elsewhere, or set to ask, it is used so; forgotten, it isn’t offered', async () => {
    const env = await ledgerWithChoices()
    const { links, accounts } = await ask<SavedLinks>(env, IMPORT_CHANNELS.links)
    const card = links.find(l => l.label.startsWith('Northwind'))!
    const other = accounts.find(a => a.name === 'Maple Trust Chequing')!
    await ask(env, IMPORT_CHANNELS.updateLink, { id: card.id, autoApply: false })
    expect((await ask<SavedLinks>(env, IMPORT_CHANNELS.links)).links.find(l => l.id === card.id)!.autoApply).toBe(false)
    await ask(env, IMPORT_CHANNELS.updateLink, { id: card.id, accountId: other.id, autoApply: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: false, remember: false })
    const pointed = await env.manager.importFiles([sample('northwind-visa-2026-10.qfx')])
    expect(pointed!.results[0].accountName).toBe('Maple Trust Chequing')
    // Forgotten, the CSV file's account isn't offered as the one used last time
    const csv = links.find(l => l.label.startsWith('CSV file'))!
    await ask(env, IMPORT_CHANNELS.forgetLink, { id: csv.id })
    env.answer(IMPORT_DIALOGS.account, { kind: 'skip' })
    await env.manager.importFiles([sample('maple-trust-chequing-2026-11.csv')])
    const asked = env.dialogs(IMPORT_DIALOGS.account).at(-1)!.input
    expect(asked.choices.filter((c: { hint?: string }) => c.hint === 'Used last time')).toEqual([])
  })

  it('a payee name', async () => {
    const env = await ledgerWithChoices()
    const [alias] = await ask<PayeeAliasView[]>(env, IMPORT_CHANNELS.aliases)
    await ask(env, IMPORT_CHANNELS.forgetAlias, { id: alias.id })
    expect(await ask(env, IMPORT_CHANNELS.aliases)).toEqual([])
  })

  it('refuses what isn’t there any more, and an account that can’t take a match', async () => {
    const env = await ledgerWithChoices()
    for (const channel of [IMPORT_CHANNELS.forgetRemembered, IMPORT_CHANNELS.forgetLink, IMPORT_CHANNELS.forgetAlias]) {
      expect((await failure(ask(env, channel, { id: 'nope' }))).code).toBe('NOT_FOUND')
    }
    const { links } = await ask<SavedLinks>(env, IMPORT_CHANNELS.links)
    const closed = await env.accounts.createAccount({ name: 'Old', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 } as AccountInput)
    await env.accounts.closeAccount?.(closed.id)
    const err = await failure(ask(env, IMPORT_CHANNELS.updateLink, { id: links[0].id, accountId: 'nope' }))
    expect([err.code, err.message]).toEqual(['REFUSED', 'Choose an open account.'])
    const csv = (await remembered(env)).find(c => c.what === 'CSV columns')!
    expect((await failure(ask(env, IMPORT_CHANNELS.updateRemembered, { id: csv.id, categories: 'file' }))).code).toBe('NOT_FOUND')
  })
})
