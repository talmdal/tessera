// @vitest-environment node
// The import and OFX plugins as built and loaded by the app, beside the ledger, accounts, SQLite and app state: a
// statement imports, what the import remembers (the account, the lines) survives a restart, and a line the user had
// typed is proposed as a match, marked in the register, and accepted.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_CHANNELS, ACCOUNTS_DIALOGS, ACCOUNTS_SERVICE, type AccountInput, type AccountsService, type RegisterView } from '@tessera/accounts-api'
import { IMPORT_DIALOGS, IMPORT_MANAGER_SERVICE, type ImportManager } from '@tessera/import-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { SAMPLES } from '../../helpers/importFile'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-import-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

describe('the built import, OFX, CSV and QIF plugins', () => {
  it('import a statement into a ledger file, and remember it across runs of the app', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({
      pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'import', 'format-ofx', 'format-csv', 'format-qif']
    })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    let accounts: AccountsService | undefined
    const shown: string[] = []
    const prompts = {
      confirm: async () => true, message: async () => {}, prompt: async () => undefined,
      // The user creates the account the first time, as the statement describes it, and closes the summary
      show: vi.fn(async (id: string, input: any) => {
        shown.push(id)
        if (id === IMPORT_DIALOGS.account) return { kind: 'create', remember: true }
        if (id === ACCOUNTS_DIALOGS.account) return { id: (await accounts!.createAccount({ subLedgerId: null, type: 'chequing', name: 'Imported', ...input.initial } as AccountInput)).id }
        if (id === 'format-csv.dialog.layout') return { kind: 'layout', layout: input.layout }
        if (id === 'format-qif.dialog.options') return { kind: 'options', dateOrder: input.dates?.value }
        return {}
      })
    }
    const files = {
      showOpenDialog: async () => undefined, showOpenFilesDialog: async () => [], showSaveDialog: async () => undefined,
      exists: async (f: string) => fs.existsSync(f), trash: vi.fn(async () => {}), documentsPath: () => userData, downloadsPath: () => userData
    }
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      const active = (await manager.activateAll()).map(m => m.id)
      await runtime.lifecycle.markStarted()
      accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
      return { active, manager, runtime, session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE), importer: runtime.services.get<ImportManager>(IMPORT_MANAGER_SERVICE) }
    }

    const first = await start()
    expect(first.active.indexOf('import')).toBeGreaterThan(first.active.indexOf('accounts'))
    expect(first.active).toContain('format-ofx')
    expect(first.active).toContain('format-csv')
    expect(first.active).toContain('format-qif')
    await first.session.create(path.join(userData, 'Home.tessera'))
    const october = await first.importer.importFiles([path.join(SAMPLES, 'maple-trust-chequing-2026-10.ofx')])
    expect(october!.results[0]).toMatchObject({ outcome: 'imported', accountName: 'Maple Trust Bank 5678', counts: { added: 17 } })
    await first.manager.deactivateAll()

    // A new run of the app: the same account without asking, and only November's new lines. The user had typed the
    // Costco one, so it is proposed as a match rather than added
    const second = await start()
    expect(second.session.current?.name).toBe('Home')
    const [account] = await accounts!.list()
    const typed = await accounts!.transactions(account.id).create({ date: '2026-11-01', amount: -9136, payee: 'Costco' })
    shown.length = 0
    const november = await second.importer.importFiles([path.join(SAMPLES, 'maple-trust-chequing-2026-11.ofx')])
    expect(november!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 4, matched: 1, duplicates: 5 } })
    expect(shown).toEqual([IMPORT_DIALOGS.summary])
    expect((await accounts!.balances(account.id)).current).toBe(624174)

    // The built import plugin marks the built accounts plugin's register, and its Accept button works
    const reply = await second.runtime.ipc.dispatch({ channel: ACCOUNTS_CHANNELS.loadRegister, data: { accountId: account.id } })
    if (!reply.ok) throw new Error(reply.error.message)
    const mark = (reply.data as RegisterView).annotations!.rows.find(r => r.transactionId === typed.id)!
    expect(mark.buttons.map(b => b.label)).toEqual(['Accept', 'Change…'])
    expect(await second.runtime.commands.execute(mark.buttons[0].command, mark.buttons[0].args)).toEqual({ ok: true })
    expect(await accounts!.transactions(account.id).get(typed.id)).toMatchObject({ date: '2026-11-02', externalId: 'MT2026110201', status: 'electronic' })
    // The built CSV format reads a CSV export, after its CSV Columns dialog, into accounts of its own
    shown.length = 0
    const csv = await second.importer.importFiles([path.join(SAMPLES, 'harbour-bank-2026-10.csv')])
    expect(shown).toEqual(['format-csv.dialog.layout', IMPORT_DIALOGS.account, ACCOUNTS_DIALOGS.account, IMPORT_DIALOGS.account, ACCOUNTS_DIALOGS.account, IMPORT_DIALOGS.summary])
    expect(csv!.results.map(r => [r.outcome, r.counts.added])).toEqual([['imported', 5], ['imported', 2]])
    // And the built QIF format, after its QIF Options dialog (the file's dates read two ways)
    shown.length = 0
    const qif = await second.importer.importFiles([path.join(SAMPLES, 'cedar-savings-2026-08-12.qif')])
    expect(shown).toEqual(['format-qif.dialog.options', IMPORT_DIALOGS.account, ACCOUNTS_DIALOGS.account, IMPORT_DIALOGS.summary])
    expect(qif!.results.map(r => [r.outcome, r.counts.added])).toEqual([['imported', 4]])
    await second.manager.deactivateAll()
    // The Change Match dialog is in the built renderer
    expect(fs.readFileSync(path.join(out, 'import', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./MatchDialog')
    expect(fs.readFileSync(path.join(out, 'import', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./CategoriesDialog')
    expect(fs.readFileSync(path.join(out, 'import', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./SignsDialog')
    expect(fs.readFileSync(path.join(out, 'import', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./SavedChoicesDialog')
    expect(fs.readFileSync(path.join(out, 'format-csv', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./LayoutDialog')
    expect(fs.readFileSync(path.join(out, 'format-qif', 'renderer', 'remoteEntry.js'), 'utf8')).toContain('./OptionsDialog')
    expect(log.error).not.toHaveBeenCalled()
  })
})
