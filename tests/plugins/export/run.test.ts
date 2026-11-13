// File › Export… and Accounts › Export Account… (docs/export-design.md, "The export flow"): the dialog starts from what the user is looking at and what
// was remembered; its preview is asked for over IPC; the file is saved where the user says, and the message says what
// went where; nothing in the ledger changes, so an archive file opened read-only exports too; one export at a time, as
// the ledger's long operation; and when something goes wrong, nothing is written and the user is told why.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCOUNTS_CONTEXT_KEYS } from '@tessera/accounts-api'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import { IMPORT_COMMANDS } from '@tessera/import-api'
import {
  EXPORT_COMMANDS, EXPORT_CONTEXT_KEYS, EXPORT_DIALOGS, EXPORT_FORMATS_POINT, EXPORT_OPERATION, EXPORT_STATE_KEYS,
  type CheckResponse, type ExportDialogInput, type ExportDialogResult, type ExportFormat
} from '@tessera/export-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { file } from '../ledger/harness'
import { household, setupExport, type ExportEnv } from './harness'

const CSV = 'format-csv.csv'
const october = (accountIds: string[], over: Partial<ExportDialogResult> = {}): ExportDialogResult => ({
  formatId: CSV, accountIds, range: { from: '2026-10-01', to: '2026-10-31' }, options: {}, rangeState: { choice: 'lastMonth' }, ...over
})
/** Everything in the ledger an export could touch, to compare before and after. */
const snapshot = async (env: ExportEnv) => JSON.stringify(await Promise.all((await env.accounts.list()).map(async a =>
  [a, await env.accounts.transactions(a.id).list()])))

describe('File › Export…', () => {
  it('is there while a ledger is open and a format can write, and not during another long operation', async () => {
    const env = await setupExport()
    expect(env.enabled()).toBe(true)
    const other = env.session.beginOperation('Backing up')
    expect(env.enabled()).toBe(false)
    other.dispose()
    expect(env.enabled()).toBe(true)
    await env.session.close()
    expect(env.enabled()).toBe(false)

    const none = await setupExport({ csv: false, qif: false, ofx: false })
    expect(none.runtime.contextKeys.get(EXPORT_CONTEXT_KEYS.hasFormats)).toBe(false)
    expect(none.enabled()).toBe(false)
  })

  it('starts the dialog from the account the user is looking at, with every account and each format’s options', async () => {
    const env = await setupExport()
    const h = await household(env)
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.registerAccount, h.savings.id)
    env.answerExport(undefined)                            // Cancel
    await env.run()

    const [{ input }] = env.dialogs('export.dialog.export') as { input: ExportDialogInput }[]
    expect(input).toMatchObject({ ledgerName: 'Home', preselectedId: h.savings.id, formatId: CSV, range: { choice: 'all' }, today: '2026-11-06' })
    expect(input.formats.map(f => [f.id, f.extension, f.accounts])).toEqual([
      [CSV, 'csv', 'many'], ['format-qif.qif', 'qif', 'many'], ['format-ofx.ofx', 'ofx', 'one'], ['format-ofx.qfx', 'qfx', 'one'], ['format-ofx.qbo', 'qbo', 'one']
    ])
    expect(input.options[CSV]).toEqual({ amounts: 'signed', dates: 'iso', decimal: '.', encoding: 'utf-8', includeVoided: false, formulaGuard: true })
    expect(input.accounts.map(a => [a.name, a.location, a.closed])).toEqual([
      ['Savings', 'Family', false], ['Chequing', '', false], ['Visa', '', false], ['Tokyo', '', false], ['Old Account', '', true]
    ])
    expect(input.accounts.find(a => a.name === 'Visa')).toMatchObject({ type: 'creditCard', typeLabel: 'Credit card', currency: 'CAD' })
    // Cancelled: no Save dialog, no file, no message, and the export is over
    expect(env.files.showSaveDialog).not.toHaveBeenCalled()
    expect(env.saved.size).toBe(0)
    expect(env.messages()).toEqual([])
    expect(env.runtime.contextKeys.get(EXPORT_CONTEXT_KEYS.isRunning)).toBe(false)

    // Without a register shown, the navigator's selected account
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.registerAccount, undefined)
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.selectionKind, 'account')
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.selectionId, h.chequing.id)
    env.answerExport(undefined)
    await env.run()
    expect((env.dialogs('export.dialog.export')[1].input as ExportDialogInput).preselectedId).toBe(h.chequing.id)
  })

  it('answers the dialog’s preview: how many transactions, the dates, and what is changed or left out', async () => {
    const env = await setupExport()
    const h = await household(env)
    const reply = await env.check<CheckResponse>(october([h.chequing.id, h.visa.id]))
    expect(reply).toEqual({
      ok: true,
      value: {
        transactions: 6, accounts: 2, range: { from: '2026-10-01', to: '2026-10-31' }, archived: [], problems: [],
        warnings: [
          'Several accounts in one CSV file suit a spreadsheet. Tessera would import the file back as a single account.',
          '1 cell starting like a spreadsheet formula is written with a \' in front.',
          '1 voided transaction is left out.'
        ]
      }
    })
    // An option the format doesn't have is dropped; one it has, but with a value it doesn't, is its default
    const odd = await env.check<CheckResponse>(october([h.chequing.id], { options: { includeVoided: true, dates: 'backwards', colour: 'red' } }))
    expect(odd.ok && odd.value.transactions).toBe(6)
    // Nothing in the range is a problem; a request that isn't one, or a format that isn't there, is refused
    const empty = await env.check<CheckResponse>(october([h.chequing.id], { range: { from: '2026-03-01', to: '2026-03-31' } }))
    expect(empty.ok && empty.value.problems).toEqual(['There are no transactions to export in “Chequing” for these dates.'])
    expect(await env.check({ accountIds: 'all' })).toMatchObject({ ok: false, error: { code: 'INVALID' } })
    expect(await env.check(october([h.chequing.id], { formatId: 'format-xlsx.xlsx' }))).toMatchObject({ ok: false, error: { code: 'NO_FORMAT' } })
    expect(await env.check(october(['gone']))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('counts only the accounts in the file, and names those a format leaves out', async () => {
    const env = await setupExport()
    const h = await household(env)
    // Old Account has nothing; Savings has nothing in October's first week
    const reply = await env.check<CheckResponse>(october([h.chequing.id, h.old.id, h.savings.id], { formatId: 'format-qif.qif', range: { from: '2026-10-01', to: '2026-10-05' } }))
    expect(reply.ok && reply.value).toMatchObject({
      transactions: 3, accounts: 1,
      warnings: expect.arrayContaining(['“Savings” and “Old Account” have no transactions in these dates, so they aren’t in the file.'])
    })
    // The file, and the message, are of the one account in it
    env.answerExport(october([h.chequing.id, h.old.id, h.savings.id], { formatId: 'format-qif.qif', range: { from: '2026-10-01', to: '2026-10-05' } }))
    env.saveAs('First week.qif')
    await env.run()
    expect(env.files.showSaveDialog.mock.calls[0][0]?.defaultPath).toMatch(/Chequing 2026-10-01 to 2026-10-05\.qif$/)
    expect(env.text(file('First week.qif'))).not.toMatch(/NSavings|NOld Account/)
    expect(env.messages()[0].detail).toMatch(/^3 transactions from “Chequing”, Oct 1, 2026 to Oct 5, 2026\.\n.*\n“Savings” and “Old Account” have no transactions in these dates/)
  })

  it('saves the file where the user says, tells them what went where, remembers the choices, and changes nothing', async () => {
    const env = await setupExport()
    const h = await household(env)
    const before = await snapshot(env)
    env.answerExport(october([h.chequing.id], { options: { dates: 'dmy' } }))
    env.saveAs('Exports/October.csv')
    await env.run()

    expect(env.files.showSaveDialog).toHaveBeenCalledWith({
      title: 'Export', buttonLabel: 'Export', defaultPath: path.join(env.files.documentsPath(), 'Chequing 2026-10-01 to 2026-10-31.csv'),
      filters: [{ name: 'CSV file (spreadsheets)', extensions: ['csv'] }]
    })
    const saved = file('Exports/October.csv')
    expect([...env.saved.keys()]).toEqual([saved])
    expect(env.text(saved).split('\r\n').slice(0, 3)).toEqual([
      'Date,Cheque number,Payee,Category,Memo,Amount,Status,Balance',
      '01/10/2026,,Landlord,Housing : Rent,,-1200.00,R,3790.00',
      '03/10/2026,101,Hydro One,,"Sept, 2026 ""final""",-84.12,,3705.88'
    ])
    expect(env.messages()).toEqual([{
      kind: 'warning', title: 'Export', message: 'Exported to October.csv.',
      detail: expect.stringMatching(/^5 transactions from “Chequing”, Oct 1, 2026 to Oct 31, 2026\.\nSaved in .*Exports\.\n1 cell starting like a spreadsheet formula/)
    }])
    // The log says how much, never what
    expect(env.exportLog.info).toHaveBeenCalledWith('[export] Exported 5 transactions from 1 accounts as format-csv.csv')
    expect(JSON.stringify(env.exportLog.info.mock.calls)).not.toMatch(/Landlord|October|1200/)
    expect(await snapshot(env)).toBe(before)

    // The next export starts from this one: the format, its options, the dates, the folder
    expect(env.appState.values.get(`export.${EXPORT_STATE_KEYS.lastFolder}`)).toBe(path.dirname(saved))
    // Kept as a list: the storage engine refuses field names with a '.', which format ids have (the pipeline test caught it)
    const options = env.appState.values.get(`export.${EXPORT_STATE_KEYS.options}`)
    expect(options).toEqual([{ formatId: CSV, options: expect.objectContaining({ dates: 'dmy' }) }])
    const fieldNames = (value: unknown): string[] => typeof value !== 'object' || value === null ? []
      : Object.entries(value).flatMap(([k, v]) => [...(Array.isArray(value) ? [] : [k]), ...fieldNames(v)])
    expect(fieldNames(options).filter(name => name.includes('.'))).toEqual([])
    env.files.exists.mockResolvedValueOnce(true)
    env.answerExport(october([h.visa.id]))
    env.saveAs(undefined)                                  // Cancel in the Save dialog: nothing written
    await env.run()
    const input = env.dialogs('export.dialog.export')[1].input as ExportDialogInput
    expect(input.options[CSV].dates).toBe('dmy')
    expect(input.range).toEqual({ choice: 'lastMonth' })
    expect(env.files.showSaveDialog.mock.calls[1][0]?.defaultPath).toBe(path.join(path.dirname(saved), 'Visa 2026-10-01 to 2026-10-31.csv'))
    expect([...env.saved.keys()]).toEqual([saved])
    expect(env.messages()).toHaveLength(1)
  })

  it('exports from an archive file opened read-only, and says where each account’s history starts', async () => {
    const env = await setupExport()
    const h = await household(env)
    const archive = await env.archiveWithFile('2026-10-02')
    await env.ledger.open(archive)
    expect(env.runtime.contextKeys.get(LEDGER_CONTEXT_KEYS.isReadOnly)).toBe(true)
    const before = await snapshot(env)
    expect(env.enabled()).toBe(true)

    env.answerExport(october([h.chequing.id, h.savings.id], { range: {} }))
    env.saveAs('Archive.csv')
    await env.run()
    expect(env.text(file('Archive.csv'))).toContain('Landlord')      // in the archive file, the rent is still there
    expect(env.messages()[0].detail).toMatch(/2 accounts, Jan 1, 2026 to Nov 6, 2026/)
    expect(await snapshot(env)).toBe(before)

    // In the ledger itself, the archived rent is gone, and the message says where Chequing starts
    await env.ledger.open(file('Home.tessera'))
    env.answerExport(october([h.chequing.id], { range: {} }))
    env.saveAs('Ledger.csv')
    await env.run()
    expect(env.text(file('Ledger.csv'))).not.toContain('Landlord')
    expect(env.messages()[1].detail).toContain('“Chequing” starts on Oct 2, 2026: its earlier transactions are in an archive file.')
  })

  it('runs one export at a time, as the ledger’s long operation, dialogs included', async () => {
    const env = await setupExport()
    await household(env)
    const during: unknown[] = []
    env.answerExport(() => {
      during.push(env.session.operation, env.runtime.contextKeys.get(EXPORT_CONTEXT_KEYS.isRunning), env.enabled(),
        env.runtime.commands.isEnabled(IMPORT_COMMANDS.file))
      return undefined
    })
    await env.run()
    expect(during).toEqual([EXPORT_OPERATION, true, false, false])
    expect([env.session.operation, env.runtime.contextKeys.get(EXPORT_CONTEXT_KEYS.isRunning), env.enabled()]).toEqual([undefined, false, true])
  })

  it('writes nothing, and says why, when the export can’t be done', async () => {
    const env = await setupExport()
    const h = await household(env)
    const failed = () => env.messages().filter(m => m.kind === 'error').map(m => [m.message, m.detail])

    // Nothing to export: said before the Save dialog
    env.answerExport(october([h.chequing.id], { range: { from: '2026-03-01', to: '2026-03-31' } }))
    await env.run()
    expect(env.files.showSaveDialog).not.toHaveBeenCalled()
    expect(failed()).toEqual([['Nothing was exported.', 'There are no transactions to export in “Chequing” for these dates.']])

    // The file held by another program the whole time
    env.fail.rename.push(...Array(100).fill('EBUSY'))
    env.answerExport(october([h.chequing.id]))
    env.saveAs('Held.csv')
    await env.run()
    expect(failed()[1]).toEqual(['Nothing was exported.', expect.stringContaining('Held.csv couldn’t be saved: another program may have it open')])
    expect(env.saved.size).toBe(0)
    env.fail.rename.length = 0

    // A ledger with no accounts
    const empty = await setupExport()
    await empty.run()
    expect(empty.messages()).toEqual([{ kind: 'error', title: 'Export', message: 'Nothing was exported.', detail: 'This ledger has no accounts to export.' }])
  })

  it('refuses accounts a format can’t hold, and more than one for a format that holds one', async () => {
    const env = await setupExport()
    const h = await household(env)
    const plugin = createPluginContext('bank', env.runtime).context
    plugin.extensions.contribute('bank', EXPORT_FORMATS_POINT, 'bank.stmt', {
      id: 'bank.stmt', label: 'Bank statement', extension: 'stm', service: 'bank.export', accounts: 'one', accountTypes: ['chequing', 'savings']
    })
    plugin.services.provide('bank', 'bank.export', { check: () => ({ transactions: 1, problems: [], warnings: [] }), write: () => ({ bytes: new Uint8Array(), warnings: [] }) })
    const problems = async (accountIds: string[]) => {
      const reply = await env.check<CheckResponse>(october(accountIds, { formatId: 'bank.stmt' }))
      return reply.ok ? reply.value.problems : reply.error
    }
    expect(await problems([h.chequing.id])).toEqual([])
    expect(await problems([h.visa.id])).toEqual(['This file type can’t hold credit card accounts, such as “Visa”.'])
    expect(await problems([h.chequing.id, h.savings.id])).toEqual(['Choose one account: this file type holds one account per file.'])
  })

  it('gives up on a format that takes too long to write', async () => {
    const env = await setupExport({ writeTimeoutMs: 20 })
    const h = await household(env)
    const slow: ExportFormat = {
      check: () => ({ transactions: 1, problems: [], warnings: [] }),
      write: () => new Promise(() => {})
    }
    const plugin = createPluginContext('slow', env.runtime).context
    plugin.extensions.contribute('slow', EXPORT_FORMATS_POINT, 'slow.fmt', { id: 'slow.fmt', label: 'Slow file', extension: 'slw', service: 'slow.export', accounts: 'many' })
    plugin.services.provide('slow', 'slow.export', slow)
    env.answerExport(october([h.chequing.id], { formatId: 'slow.fmt' }))
    env.saveAs('Slow.slw')
    await env.run()
    expect(env.messages().at(-1)).toMatchObject({ kind: 'error', detail: 'The Slow file took too long to write (more than 0.02 seconds).' })
    expect(env.saved.size).toBe(0)
    expect(env.enabled()).toBe(true)
  })
})

describe('Accounts › Export Account…', () => {
  const exportAccount = (env: ExportEnv, args?: unknown) => env.runtime.commands.execute(EXPORT_COMMANDS.account, args)
  const select = (env: ExportEnv, id: string | undefined) => {
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.selectionKind, id === undefined ? 'subLedger' : 'account')
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.selectionId, id)
  }
  const lastInput = (env: ExportEnv) => env.dialogs(EXPORT_DIALOGS.export).at(-1) as { input: ExportDialogInput, options?: { title?: string } }

  it('is in the Accounts menu after Reconcile with Statement…, for the selected account, when File › Export… could run', async () => {
    const env = await setupExport()
    const h = await household(env)
    const impls = env.runtime.extensions.getContributions('shell.menus')
      .filter(c => c.contributor === 'accounts' || c.contributor === 'export').map(c => c.impl)
    const menus = resolveMenus([{ kind: 'menu', id: 'shell.file', label: '&File' }, { kind: 'menu', id: 'shell.view', label: '&View' }, ...impls])
    expect(menus.diagnostics).toEqual([])
    const accountsMenu = menus.menus.find(m => m.id === 'accounts.menu')!
    expect(normalizeMenuNodes(accountsMenu.children).map(n => n.type === 'item' ? n.label : n.type).slice(-5))
      .toEqual(['separator', '&Open Register', 'New &Transaction', 'Reconcile with &Statement…', 'Ex&port Account…'])

    const enabled = () => env.runtime.commands.isEnabled(EXPORT_COMMANDS.account)
    select(env, undefined)
    expect(enabled()).toBe(false)
    select(env, h.visa.id)
    expect(enabled()).toBe(true)
    const other = env.session.beginOperation('Backing up')
    expect(enabled()).toBe(false)
    other.dispose()
    expect(enabled()).toBe(true)
  })

  it('starts the dialog from the selected account, or the one it is given, whatever the register shows', async () => {
    const env = await setupExport()
    const h = await household(env)
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.registerAccount, h.chequing.id)
    select(env, h.savings.id)
    env.answerExport(undefined)
    await exportAccount(env)
    expect(lastInput(env).input.preselectedId).toBe(h.savings.id)
    expect(lastInput(env).options).toEqual({ title: 'Export Account' })

    env.answerExport(undefined)
    await exportAccount(env, { id: h.old.id })                   // a closed account can be exported too
    expect(lastInput(env).input.preselectedId).toBe(h.old.id)
    expect(env.messages()).toEqual([])
  })

  it('exports the account, naming the file after it, and says what went where', async () => {
    const env = await setupExport()
    const h = await household(env)
    select(env, h.visa.id)
    env.answerExport(october([h.visa.id]))
    env.saveAs('Visa.csv')
    await exportAccount(env)
    const defaultPath = env.files.showSaveDialog.mock.calls.at(-1)![0]?.defaultPath
    expect(path.basename(defaultPath!)).toBe('Visa 2026-10-01 to 2026-10-31.csv')
    expect(env.messages().at(-1)).toMatchObject({ kind: 'info', message: 'Exported to Visa.csv.' })
    expect(env.messages().at(-1)!.detail).toMatch(/^1 transaction from “Visa”, /)
  })

  it('starts on the last format used when it can hold the account, and otherwise on the first that can', async () => {
    const env = await setupExport()
    const h = await household(env)
    const plugin = createPluginContext('bank', env.runtime).context
    plugin.extensions.contribute('bank', EXPORT_FORMATS_POINT, 'bank.stmt', {
      id: 'bank.stmt', label: 'Bank statement', extension: 'stm', service: 'bank.export', accounts: 'one', accountTypes: ['chequing', 'savings']
    })
    plugin.services.provide('bank', 'bank.export', { check: () => ({ transactions: 1, problems: [], warnings: [] }), write: () => ({ bytes: new Uint8Array([1]), warnings: [] }) })
    env.answerExport(october([h.chequing.id], { formatId: 'bank.stmt' }))
    env.saveAs('Chequing.stm')
    await env.run()
    expect(env.appState.values.get(`export.${EXPORT_STATE_KEYS.lastFormat}`)).toBe('bank.stmt')

    select(env, h.chequing.id)                                  // (the command is for when an account is selected)
    env.answerExport(undefined)
    await exportAccount(env, { id: h.savings.id })
    expect(lastInput(env).input.formatId).toBe('bank.stmt')
    // A card it can't hold: the first format that can (File › Export… does the same for the account the user looks at)
    env.answerExport(undefined)
    await exportAccount(env, { id: h.visa.id })
    expect(lastInput(env).input.formatId).toBe(CSV)
    env.runtime.contextKeys.set(ACCOUNTS_CONTEXT_KEYS.registerAccount, h.visa.id)
    env.answerExport(undefined)
    await env.run()
    expect(lastInput(env).input.formatId).toBe(CSV)
  })

  it('says so, and shows no dialog, for an account that isn’t in the ledger', async () => {
    const env = await setupExport()
    const h = await household(env)
    select(env, h.chequing.id)
    await exportAccount(env, { id: 'nope' })
    expect(env.dialogs(EXPORT_DIALOGS.export)).toEqual([])
    expect(env.messages()).toEqual([{ kind: 'error', title: 'Export', message: 'Nothing was exported.', detail: 'That account isn’t in this ledger.' }])
  })
})
