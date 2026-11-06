// @vitest-environment node
// Applying an import in three steps, and putting right one that was interrupted between them; and the plugin as it
// activates: its menu item, dialogs and service, and when File › Import… is enabled.
import { describe, expect, it, vi } from 'vitest'
import { LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_CONTEXT_KEYS, REGISTER_ANNOTATIONS_POINT, type AccountInput } from '@tessera/accounts-api'
import { IMPORT_ANNOTATOR_SERVICE, IMPORT_COMMANDS, IMPORT_CONTEXT_KEYS, IMPORT_DIALOGS, IMPORT_MANAGER_SERVICE } from '@tessera/import-api'
import { applyImport, recoverImports } from '../../../plugins/import/src/privileged/apply'
import { collectionsOf } from '../../../plugins/import/src/privileged/store'
import { activate as activateOfx } from '../../../plugins/import-ofx/src/privileged/index'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { file } from '../ledger/harness'
import { sample, setupImport, type ImportEnv } from './harness'

const chequing = (over: Partial<AccountInput> = {}): AccountInput =>
  ({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, ...over })

const line = (importId: string, amount = -100) => ({ importId, bank: { date: '2026-10-05', amount, payee: 'SHOP' } })
const draft = (importId: string, amount = -100) => ({ date: '2026-10-05', amount, payee: 'Shop', status: 'electronic' as const, externalId: importId })
const counts = { lines: 2, added: 2, matched: 0, possible: 0, duplicates: 0, invalid: 0 }

function db(env: ImportEnv) {
  const session = env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  return () => session.database('import')
}

/** Step 1 as an interruption left it: the batch 'applying', with its lines. */
async function interruptedAfterStepOne(env: ImportEnv, accountId: string, ids: string[]) {
  const c = collectionsOf(db(env)())
  const batch = await c.batches.insert({ accountId, fileName: 'October.ofx', statementIndex: 0, importedAt: '2026-11-06T12:00:00Z', state: 'applying', counts })
  await c.lines.insertMany(ids.map(id => ({ batchId: batch.id, accountId, importId: id, bank: line(id).bank, outcome: 'added' as const, review: 'pending' as const })))
  return batch.id
}

describe('applying an import', () => {
  it('records the batch and its lines, adds the transactions, and points each line at its transaction', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing())
    const { batchId, transactions } = await applyImport(db(env), env.accounts, {
      accountId: mine.id, fileName: 'October.ofx', statementIndex: 0, counts, lines: [line('A'), line('B', -200)], drafts: [draft('A'), draft('B', -200)]
    }, '2026-11-06T12:00:00Z')
    const c = collectionsOf(db(env)())
    expect(await c.batches.get(batchId)).toMatchObject({ state: 'applied', accountId: mine.id, counts })
    const lines = await c.lines.find({ batchId })
    expect(lines.map(l => [l.importId, l.transactionId, l.outcome, l.review])).toEqual([
      ['A', transactions[0].id, 'added', 'pending'], ['B', transactions[1].id, 'added', 'pending']
    ])
  })

  it('keeps nothing of the import when the transactions can’t be added', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing())
    const bad = { ...draft('B'), categoryId: 'no-such-category' }
    await expect(applyImport(db(env), env.accounts, {
      accountId: mine.id, fileName: 'October.ofx', statementIndex: 0, counts, lines: [line('A'), line('B')], drafts: [draft('A'), bad]
    }, '2026-11-06T12:00:00Z')).rejects.toMatchObject({ code: 'NOT_FOUND', field: 'drafts[1].category' })
    const c = collectionsOf(db(env)())
    expect(await c.batches.find()).toEqual([])
    expect(await c.lines.find()).toEqual([])
    expect(await env.transactions(mine.id)).toEqual([])
  })
})

describe('an import interrupted', () => {
  it('after its transactions were added is finished: the lines point at them', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing())
    const batchId = await interruptedAfterStepOne(env, mine.id, ['A', 'B'])
    const added = await env.accounts.transactions(mine.id).createMany([draft('A'), draft('B')])

    expect(await recoverImports(db(env), env.accounts)).toEqual([])
    const c = collectionsOf(db(env)())
    expect((await c.batches.get(batchId))?.state).toBe('applied')
    expect((await c.lines.find({ batchId })).map(l => l.transactionId)).toEqual(added.map(t => t.id))
  })

  it('before they were added is undone, and the next import says so', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing({ accountNumber: '8812345678' }))
    await interruptedAfterStepOne(env, mine.id, ['MT2026100201', 'MT2026100301'])

    const report = await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    expect(report!.notices).toEqual(['The import of October.ofx was interrupted, so nothing from it was added. Import the file again.'])
    // Its lines are gone, so they import now, rather than counting as imported before
    expect(report!.results[0].counts).toMatchObject({ added: 17, duplicates: 0 })
    const summary = env.dialogs(IMPORT_DIALOGS.summary)[0].input
    expect(summary.notices).toHaveLength(1)
    // Told once
    expect((await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')]))!.notices).toBeUndefined()
  })

  it('is put right as soon as its ledger opens again', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing())
    const batchId = await interruptedAfterStepOne(env, mine.id, ['A'])
    await env.accounts.transactions(mine.id).createMany([draft('A')])
    await env.runtime.commands.execute(LEDGER_COMMANDS.close)
    env.files.showOpenDialog.mockResolvedValueOnce(file('Home.tessera'))
    await env.runtime.commands.execute(LEDGER_COMMANDS.open)
    await vi.waitFor(async () => expect((await collectionsOf(db(env)()).batches.get(batchId))?.state).toBe('applied'))
  })
})

describe('the import plugin, activated', () => {
  it('adds File › Import…, its dialogs, its register marks and its services', async () => {
    const env = await setupImport()
    const menus = env.runtime.extensions.getContributions('shell.menus').filter(c => c.contributor === 'import').map(c => c.impl)
    expect(menus).toEqual([
      { kind: 'group', id: 'import.file', parent: 'shell.file', order: 5 },
      { kind: 'item', id: 'import.file.import', label: '&Import…', parent: 'shell.file', group: 'import.file', command: IMPORT_COMMANDS.file }
    ])
    expect(env.runtime.extensions.getContributions('shell.dialogs').filter(c => c.contributor === 'import').map(c => c.id))
      .toEqual([IMPORT_DIALOGS.format, IMPORT_DIALOGS.account, IMPORT_DIALOGS.summary, IMPORT_DIALOGS.match])
    expect(env.runtime.extensions.getContributions(REGISTER_ANNOTATIONS_POINT).filter(c => c.contributor === 'import').map(c => c.impl))
      .toEqual([{ id: 'import.review', service: IMPORT_ANNOTATOR_SERVICE }])
    expect(env.runtime.services.has(IMPORT_MANAGER_SERVICE)).toBe(true)
    expect(env.runtime.services.has(IMPORT_ANNOTATOR_SERVICE)).toBe(true)
    for (const command of [IMPORT_COMMANDS.accept, IMPORT_COMMANDS.acceptAll, IMPORT_COMMANDS.change]) expect(env.runtime.commands.has(command)).toBe(true)
    expect(env.importLog.warn).not.toHaveBeenCalled()
  })

  it('enables Import… only with a writable ledger open, a format installed, and no import running', async () => {
    const env = await setupImport({ ofx: false })
    const enabled = () => env.runtime.commands.isEnabled(IMPORT_COMMANDS.file)
    expect(env.runtime.contextKeys.get(IMPORT_CONTEXT_KEYS.hasFormats)).toBe(false)
    expect(enabled()).toBe(false)                                   // no format yet
    await activateOfx(createPluginContext('import-ofx', env.runtime).context)
    expect(env.runtime.contextKeys.get(IMPORT_CONTEXT_KEYS.hasFormats)).toBe(true)
    expect(enabled()).toBe(true)

    let release: (value: unknown) => void = () => {}
    let asked: () => void = () => {}
    const dialogOpen = new Promise<void>(resolve => { asked = resolve })
    env.answer(IMPORT_DIALOGS.account, () => new Promise(resolve => { release = resolve; asked() }))
    const running = env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    await dialogOpen
    expect(enabled()).toBe(false)                                   // one import at a time
    release({ kind: 'skip' })
    await running
    expect(enabled()).toBe(true)

    await env.runtime.commands.execute(LEDGER_COMMANDS.close)
    expect(env.runtime.contextKeys.get(LEDGER_CONTEXT_KEYS.isOpen)).toBe(false)
    expect(enabled()).toBe(false)
  })

  it('runs the whole flow from the menu: files, import, summary, and the register of the account to review', async () => {
    const env = await setupImport()
    const mine = await env.accounts.createAccount(chequing({ accountNumber: '8812345678' }))
    env.files.showOpenFilesDialog.mockResolvedValueOnce([sample('maple-trust-chequing-2026-10.ofx')])
    env.answer(IMPORT_DIALOGS.summary, (report: { results: { accountId: string }[] }) => ({ review: report.results[0].accountId }))
    await env.runtime.commands.execute(IMPORT_COMMANDS.file)
    expect(await env.transactions(mine.id)).toHaveLength(17)
    expect(env.runtime.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.registerAccount)).toBe(mine.id)
  })
})
