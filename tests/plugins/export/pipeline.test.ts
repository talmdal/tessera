// @vitest-environment node
// The export plugin and the CSV and QIF file-type plugins as built and loaded by the app, beside the ledger, accounts,
// SQLite and app state: File › Export… writes a ledger's transactions to real files, which each plugin's own reader
// reads back, and the choices made are remembered across runs of the app.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { EXPORT_COMMANDS, EXPORT_DIALOGS, type ExportDialogInput, type ExportDialogResult } from '@tessera/export-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { readCsv, valuesOf } from '../../../plugins/format-csv/src/shared/csv'
import { guessLayout } from '../../../plugins/format-csv/src/shared/guess'
import { readLines } from '../../../plugins/format-csv/src/shared/lines'
import { decode } from '../../../plugins/import/src/privileged/files'
import { parseQif } from '../../../plugins/format-qif/src/privileged/qif'
import { collect, readStatement } from '../../../plugins/format-qif/src/privileged/statements'
import { parseOfx } from '../../../plugins/format-ofx/src/privileged/sgml'
import { statementsOf } from '../../../plugins/format-ofx/src/privileged/statements'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-export-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

describe('the built export, CSV, QIF and OFX plugins', () => {
  it('export a ledger’s transactions to a file the CSV plugin reads back, and remember the choices', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({
      pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'ledger', 'accounts', 'import', 'format-csv', 'format-qif', 'format-ofx', 'export']
    })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const exports = path.join(userData, 'Exports')
    fs.mkdirSync(exports)
    const log = createLogger()
    const shown: ExportDialogInput[] = []
    const messages: { kind?: string, message: string, detail?: string }[] = []
    // The user exports every account, October, with month-first dates
    const prompts = {
      confirm: async () => true, prompt: async () => undefined,
      message: vi.fn(async (m: { kind?: string, message: string, detail?: string }) => { messages.push(m) }),
      show: vi.fn(async (id: string, input: ExportDialogInput): Promise<ExportDialogResult | undefined> => {
        if (id !== EXPORT_DIALOGS.export) return undefined
        shown.push(input)
        return {
          formatId: 'format-csv.csv', accountIds: input.accounts.map(a => a.id), range: { from: '2026-10-01', to: '2026-10-31' },
          options: { ...input.options['format-csv.csv'], dates: 'mdy' }, rangeState: { choice: 'custom', from: '2026-10-01', to: '2026-10-31' }
        }
      })
    }
    const files = {
      showOpenDialog: async () => undefined, showOpenFilesDialog: async () => [], showOpenFolderDialog: async () => undefined,
      showSaveDialog: vi.fn(async () => path.join(exports, 'October.csv') as string | undefined),
      exists: async (f: string) => fs.existsSync(f), trash: vi.fn(async () => {}), documentsPath: () => userData, downloadsPath: () => userData
    }
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      const active = (await manager.activateAll()).map(m => m.id)
      await runtime.lifecycle.markStarted()
      return { active, manager, runtime, session: runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE), accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE) }
    }

    const first = await start()
    expect(first.active.indexOf('export')).toBeGreaterThan(first.active.indexOf('accounts'))
    expect(first.active).toContain('format-csv')
    await first.session.create(path.join(userData, 'Home.tessera'))
    const chequing = await first.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000 })
    const visa = await first.accounts.createAccount({ name: 'Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    const groceries = await first.accounts.categories.create('Food : Groceries', 'expense')
    await first.accounts.transactions(chequing.id).create({ date: '2026-10-03', amount: -8412, payee: 'Hydro One', number: '101' })
    await first.accounts.transactions(chequing.id).create({ date: '2026-10-05', amount: 250000, payee: 'Employer Inc' })
    await first.accounts.transactions(visa.id).create({ date: '2026-10-14', amount: -2345, payee: 'Costco', categoryId: groceries.id })
    expect(first.runtime.commands.isEnabled(EXPORT_COMMANDS.file)).toBe(true)

    await first.runtime.commands.execute(EXPORT_COMMANDS.file)
    const saved = path.join(exports, 'October.csv')
    expect(fs.readdirSync(exports)).toEqual(['October.csv'])          // no temporary file left behind
    const text = decode(new Uint8Array(fs.readFileSync(saved)), 'auto')
    expect(text.split('\r\n')).toEqual([
      'Account,Date,Cheque number,Payee,Category,Memo,Amount,Status,Balance',
      'Chequing,10/03/2026,101,Hydro One,,,-84.12,,915.88',
      'Chequing,10/05/2026,,Employer Inc,,,2500.00,,3415.88',
      'Visa,10/14/2026,,Costco,Food : Groceries,,-23.45,,-23.45',
      ''
    ])
    expect(messages).toEqual([expect.objectContaining({ kind: 'warning', message: 'Exported to October.csv.' })])
    // The CSV plugin reads it back, with nothing guessed
    const { delimiter, rows } = readCsv(text)
    const values = rows.map(valuesOf)
    const guess = guessLayout(values, { delimiter, pivot: 2036 })
    expect(guess.uncertain).toEqual([])
    expect(readLines(values, guess.layout, 2036).statements.flatMap(s => s.lines.map(l => [l.line.date, l.line.amount, l.line.payee]))).toEqual([
      ['2026-10-03', '-84.12', 'Hydro One'], ['2026-10-05', '2500.00', 'Employer Inc'], ['2026-10-14', '-23.45', 'Costco']
    ])

    // And as QIF, from the QIF plugin as built: standard QIF, the accounts listed first, read back by its own reader
    files.showSaveDialog.mockResolvedValueOnce(path.join(exports, 'October.qif'))
    prompts.show.mockImplementationOnce(async (_id: string, input: ExportDialogInput) => ({
      formatId: 'format-qif.qif', accountIds: input.accounts.map(a => a.id), range: { from: '2026-10-01', to: '2026-10-31' },
      options: { ...input.options['format-qif.qif'] }, rangeState: { choice: 'custom', from: '2026-10-01', to: '2026-10-31' }
    }))
    await first.runtime.commands.execute(EXPORT_COMMANDS.file)
    const qif = decode(new Uint8Array(fs.readFileSync(path.join(exports, 'October.qif'))), 'auto')
    expect(qif.split('\r\n').filter(l => l.startsWith('!'))).toEqual([
      '!Type:Cat', '!Option:AutoSwitch', '!Account', '!Account', '!Clear:AutoSwitch', '!Account', '!Type:Bank', '!Account', '!Type:CCard'
    ])
    const read = collect(parseQif(qif))
    expect(read.warnings).toEqual([])
    expect(read.statements.map(raw => readStatement(raw, 'October.qif', { dateOrder: 'MDY', decimal: '.', pivot: 2036, reversed: false }).statement.balance))
      .toEqual([{ amount: '3415.88', asOf: '2026-10-05' }, { amount: '-23.45', asOf: '2026-10-14' }])

    // And as OFX, from the OFX plugin as built: the account's numbers from the account, read back by its own reader
    await first.accounts.updateAccount(chequing.id, { accountNumber: '12-345678', bankId: '004' })
    files.showSaveDialog.mockResolvedValueOnce(path.join(exports, 'October.ofx'))
    prompts.show.mockImplementationOnce(async () => ({
      formatId: 'format-ofx.ofx', accountIds: [chequing.id], range: { from: '2026-10-01', to: '2026-10-31' },
      options: {}, rangeState: { choice: 'custom', from: '2026-10-01', to: '2026-10-31' }
    }))
    await first.runtime.commands.execute(EXPORT_COMMANDS.file)
    const ofxBytes = new Uint8Array(fs.readFileSync(path.join(exports, 'October.ofx')))
    const ofx = statementsOf(parseOfx(decode(ofxBytes, 'windows-1252'))!.root)
    expect(ofx.warnings).toEqual([])
    expect(ofx.statements.map(s => [s.account.key, s.balance, s.lines.length])).toEqual([['ofx:bank:004:12345678', { amount: '3415.88', asOf: '2026-10-31' }, 2]])
    await first.manager.deactivateAll()

    // The next run of the app starts the Export dialog from the choices made, and the Save dialog in the same folder
    const second = await start()
    await second.session.open(path.join(userData, 'Home.tessera'))
    prompts.show.mockImplementationOnce(async (_id: string, input: ExportDialogInput) => { shown.push(input); return undefined })
    await second.runtime.commands.execute(EXPORT_COMMANDS.file)
    expect(shown[1].formatId).toBe('format-ofx.ofx')               // the format used last
    expect(shown[1].options['format-csv.csv'].dates).toBe('mdy')      // and each format's options as they were
    expect(shown[1].range).toEqual({ choice: 'custom', from: '2026-10-01', to: '2026-10-31' })
    await second.manager.deactivateAll()
  })
})
