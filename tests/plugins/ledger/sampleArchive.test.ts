// @vitest-environment node
// The sample archive (npm run sample:archive) is made here too, so it keeps working as the code changes. Then the
// plugins that touch a ledger are activated together on the real SQLite engine, as the app runs them, and the archive
// file is opened, browsed and closed: nothing is written to it, nothing beside it, and no plugin complains. That is
// the check for plugins that write when a ledger opens (docs/ledger-compaction-design.md, Phase 3). The second test
// archives through File › Archive Ledger… with the same plugins, the dialog played through its channels (Phase 4).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_DIALOGS, LEDGER_SESSION_SERVICE, displayDate,
  type ArchiveDialogInput, type ArchiveOutcome, type ArchivePreview, type LedgerSession, type Result
} from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS, ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_SERVICE, type AccountsService, type RegisterAnnotator
} from '@tessera/accounts-api'
import { IMPORT_ANNOTATOR_SERVICE } from '@tessera/import-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateImport } from '../../../plugins/import/src/privileged/index'
import { activate as activateOfx } from '../../../plugins/import-ofx/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { sqliteDriver } from '../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { makeSampleArchive } from '../../../scripts/sample-archive/household'
import { createTempModulesDir } from '../../helpers/tempModules'
import { fakePrompts, logger, memoryAppState } from './harness'

/** The ledger, accounts, import and OFX plugins on the real SQLite engine and disk, as the app runs them. */
async function app(dir: string) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  runtime.services.provide('storage-sqlite', 'storage.engine', new KitStorageEngine(sqliteDriver({ directory: path.join(dir, 'storage') })))
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, {
    showOpenDialog: vi.fn(), showOpenFilesDialog: vi.fn(), showOpenFolderDialog: vi.fn(), showSaveDialog: vi.fn(),
    exists: async (f: string) => fs.existsSync(f), trash: vi.fn(), documentsPath: () => dir, downloadsPath: () => dir
  })
  const { prompts } = fakePrompts()
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  createPluginContext('shell', runtime).context.commands.register('shell.layout.reveal', () => {})
  for (const [id, activate] of [['ledger', activateLedger], ['accounts', activateAccounts], ['import', activateImport], ['import-ofx', activateOfx]] as const) {
    await (activate as (context: unknown) => Promise<void>)({ ...createPluginContext(id, runtime).context, logger: log })
  }
  await runtime.lifecycle.markStarted()
  return {
    log, runtime, prompts,
    session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE),
    accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE),
    annotator: runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)
  }
}

/** Every account's balances (the money, not the count of transactions), by name. */
async function balances(accounts: AccountsService) {
  const all: Record<string, number[]> = {}
  for (const account of await accounts.list()) {
    const b = await accounts.balances(account.id)
    all[account.name] = [b.current, b.cleared, b.reconciled, b.available]
  }
  return all
}

describe('the sample archive', () => {
  it('is made, opens read-only with its whole history while every plugin is active, and is left as it was', async () => {
    const dir = createTempModulesDir()
    const made = await makeSampleArchive(dir)

    expect(made.outcome).toMatchObject({ before: '2026-01-01', summaries: ['644 transactions from 5 accounts, and 1 closed account with nothing left'] })
    // Compacted as the archive's last step: the file gave back the space the archived transactions took
    const compaction = made.outcome.compaction as { before: number, after: number }
    expect(compaction.after).toBeLessThan(compaction.before)
    expect(compaction.after).toBe(fs.statSync(made.ledger).size)
    expect(made.said).toEqual([
      `3 transactions before ${displayDate('2026-01-01')} aren’t reconciled, so they stay in the ledger.`,
      'Chequing 1 · Savings 1 · Visa 1',
      '1 reconciled transfer stays with them, until the other side is reconciled.',
      'To archive them too, cancel, reconcile those accounts, and archive again.',
      '“Store Card” is closed, but stays: its balance isn’t zero.'
    ])
    await expect(makeSampleArchive(dir)).rejects.toThrow('is already there')
    const before = { bytes: fs.readFileSync(made.archive), modified: fs.statSync(made.archive).mtimeMs }
    const beside = () => fs.readdirSync(path.dirname(made.archive)).filter(f => f !== path.basename(made.archive))

    const { log, session, accounts, annotator, runtime } = await app(dir)
    const ask = async (channel: string, data?: unknown) => {
      const reply = await runtime.ipc.dispatch({ channel, data })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.data as any
    }

    // The archive: read-only, the whole history, every register and its marks readable
    expect(await session.open(made.archive)).toMatchObject({ readOnly: true, archive: { before: '2026-01-01', ledgerName: 'Household' } })
    // The views are told it is read-only, so they offer nothing that would change it
    expect((await ask(ACCOUNTS_CHANNELS.chart)).ledger).toEqual({ name: 'Household (archive before 2026-01-01)', readOnly: true })
    const anyAccount = (await accounts.list())[0]
    expect(await ask(ACCOUNTS_CHANNELS.loadRegister, { accountId: anyAccount.id })).toMatchObject({ readOnly: true })
    await runtime.commands.execute(ACCOUNTS_COMMANDS.openRegister, { id: anyAccount.id })
    expect(runtime.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.registerEditable)).toBe(false)
    const inArchive = await balances(accounts)
    expect(Object.keys(inArchive).sort()).toEqual(['Chequing', 'Old Savings', 'Savings', 'Store Card', 'Visa'])
    for (const account of await accounts.list()) {
      const { rows } = await accounts.transactions(account.id).register()
      expect(rows.length, account.name).toBeGreaterThan(0)
      await annotator.annotate(account.id)
    }
    const chequing = (await accounts.list()).find(a => a.name === 'Chequing')!
    expect((await accounts.transactions(chequing.id).list({ to: '2023-01-31' })).length).toBeGreaterThan(5)
    expect(beside()).toEqual([])

    // The ledger: the same balances, without what was archived or the closed account left with nothing
    await session.open(made.ledger)
    expect((await ask(ACCOUNTS_CHANNELS.chart)).ledger).toEqual({ name: 'Household' })
    const inLedger = await balances(accounts)
    expect(Object.keys(inLedger).sort()).toEqual(['Chequing', 'Savings', 'Store Card', 'Visa'])
    for (const name of Object.keys(inLedger)) expect(inLedger[name], name).toEqual(inArchive[name])
    const now = (await accounts.list()).find(a => a.name === 'Chequing')!
    expect(now).toMatchObject({ openingDate: '2023-01-01', lastArchiveDate: '2026-01-01' })
    expect(await accounts.transactions(now.id).list({ to: '2025-12-31' })).toHaveLength(2)    // the cheque never cashed, and the top-up
    await session.close()

    expect(fs.readFileSync(made.archive).equals(before.bytes)).toBe(true)
    expect(fs.statSync(made.archive).mtimeMs).toBe(before.modified)
    expect(beside()).toEqual([])
    // No plugin tried to write to the archive, or failed at anything
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  }, 60_000)

  it('is what File › Archive Ledger… does with every plugin active: the dialog sees each part, and balances stay', async () => {
    const dir = createTempModulesDir()
    const { log, runtime, prompts, session, accounts } = await app(dir)
    await session.create(path.join(dir, 'Home.tessera'))
    const chequing = await accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2024-01-01', openingBalance: 100000 })
    const old = await accounts.createAccount({ name: 'Old', type: 'savings', subLedgerId: null, currency: 'CAD', openingDate: '2024-01-01', openingBalance: 0 })
    const t = accounts.transactions(chequing.id)
    const made = await t.createMany([
      { date: '2024-03-01', amount: -2500 }, { date: '2024-06-01', amount: 10000 }, { date: '2025-02-01', amount: -700 }, { date: '2025-12-01', amount: -400 }
    ])
    const settled = made.filter(x => x.date < '2025-06-01')
    await accounts.reconciliation.begin(chequing.id, { statementDate: '2025-05-31', startingBalance: 100000, statementBalance: 100000 + settled.reduce((sum, x) => sum + x.amount, 0), reconcilerId: 'accounts.reconcile.statement' })
    await accounts.reconciliation.mark(chequing.id, settled.map(x => x.id), true)
    await accounts.reconciliation.finish(chequing.id)
    await accounts.closeAccount(old.id, { closedOn: '2024-02-01' })
    const before = await balances(accounts)

    // The dialog, played as the real one plays it
    const ask = async <T>(channel: string, data: unknown) => {
      const reply = await runtime.ipc.dispatch({ channel, data })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.data as T
    }
    let preview: Result<ArchivePreview> | undefined
    prompts.show.mockImplementationOnce(async (id: unknown, input: unknown) => {
      expect(id).toBe(LEDGER_DIALOGS.archive)
      const { suggestedBefore } = input as ArchiveDialogInput
      preview = await ask<Result<ArchivePreview>>(LEDGER_CHANNELS.archivePreview, { before: '2025-06-01', options: {} })
      expect(suggestedBefore).toMatch(/^\d{4}-01-01$/)
      const ran = await ask<Result<ArchiveOutcome>>(LEDGER_CHANNELS.archiveRun, { before: '2025-06-01', options: { 'accounts.removeClosedAccounts': true } })
      return ran.ok ? ran.value : undefined
    })
    const outcome = await runtime.commands.execute(LEDGER_COMMANDS.archive) as ArchiveOutcome

    expect(preview).toMatchObject({ ok: true, value: {
      count: 4, copy: { name: 'Home (archive before 2025-06-01)', folder: path.join(dir, 'Tessera Backups', 'Archives') },
      // The import plugin has nothing to archive here, so it says nothing
      parts: [{
        contributor: 'accounts', count: 4, summary: '3 transactions from 1 account, and 1 closed account with nothing left',
        options: [{ id: 'accounts.removeClosedAccounts', label: 'Remove closed accounts with nothing left: “Old”', default: true }]
      }]
    } })
    expect(outcome).toMatchObject({ before: '2025-06-01', count: 4, summaries: ['3 transactions from 1 account, and 1 closed account with nothing left'] })
    expect(fs.existsSync(outcome.copy.path)).toBe(true)
    // The file was compacted: no larger than before, with nothing left in its -wal
    const compaction = outcome.compaction as { before: number, after: number }
    expect(compaction.after).toBeLessThanOrEqual(compaction.before)
    const ledgerFile = path.join(dir, 'Home.tessera')
    expect(compaction.after).toBe(fs.statSync(ledgerFile).size + (fs.existsSync(`${ledgerFile}-wal`) ? fs.statSync(`${ledgerFile}-wal`).size : 0))
    expect(fs.existsSync(`${ledgerFile}-wal`) ? fs.statSync(`${ledgerFile}-wal`).size : 0).toBe(0)
    expect(prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info', message: '“Home” has been archived.' }))
    // Every balance as it was; what is left starts on the archive date
    const after = await balances(accounts)
    expect(after).toEqual({ Chequing: before.Chequing })
    expect((await t.list()).map(x => x.date)).toEqual(['2025-12-01'])
    expect(await accounts.get(chequing.id)).toMatchObject({ openingBalance: 100000 - 2500 + 10000 - 700, lastArchiveDate: '2025-06-01', archived: { count: 3, originalOpeningBalance: 100000 } })

    // The archive file: the whole history, read-only
    await session.open(outcome.copy.path)
    expect((await accounts.list()).map(a => a.name).sort()).toEqual(['Chequing', 'Old'])
    expect(await accounts.transactions((await accounts.list()).find(a => a.name === 'Chequing')!.id).list()).toHaveLength(4)
    await session.close()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  }, 60_000)
})
