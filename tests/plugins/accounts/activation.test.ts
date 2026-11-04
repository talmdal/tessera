// @vitest-environment node
// The ledger and accounts plugins activated together, as the app runs them, and driven through commands and IPC.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS as C, ACCOUNTS_CONTEXT_KEYS as K, ACCOUNTS_DIALOGS, ACCOUNTS_EVENTS, ACCOUNTS_SERVICE,
  ACCOUNTS_VIEWS, type AccountDialogInput, type AccountsService, type MoveDialogInput
} from '@tessera/accounts-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'
import { chequing } from './harness'

async function setup() {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  const shell = createPluginContext('shell', runtime).context
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (id: unknown) => { reveals.push(String(id)) })
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)

  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const key = (k: string) => runtime.contextKeys.get(k)
  const enabled = (id: string) => runtime.commands.isEnabled(id)
  const last = (name: string) => events.filter(e => e.name === name).at(-1)?.data
  const open = async () => {
    files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
    await run(LEDGER_COMMANDS.new)
  }
  return { runtime, log, prompts, answers, reveals, events, session, accounts, run, ask, key, enabled, last, open }
}

describe('the accounts plugin: contributions', () => {
  it('adds an Accounts menu, a View item, its views and three dialogs, all valid', async () => {
    const { runtime } = await setup()
    const impls = (point: string) => runtime.extensions.getContributions(point).filter(c => c.contributor === 'accounts')
    const menus = resolveMenus([{ kind: 'menu', id: 'shell.view', label: '&View' }, ...impls('shell.menus').map(c => c.impl)])
    expect(menus.diagnostics).toEqual([])
    const accountsMenu = menus.menus.find(m => m.id === 'accounts.menu')!
    expect(normalizeMenuNodes(accountsMenu.children).map(n => n.type === 'item' ? n.label : n.type)).toEqual([
      '&New Account…', '&Edit Account…', '&Close Account…', '&Reopen Account', '&Delete Account…', 'separator',
      'New &Sub-Ledger…', 'Re&name Sub-Ledger…', 'Delete Su&b-Ledger…', 'separator', '&Move To…', 'separator',
      '&Open Register', 'New &Transaction', 'Reconcile with &Statement…'
    ])
    const views = resolveViews(impls('shell.views'), () => 'x')
    expect(views.diagnostics).toEqual([])
    expect(impls('shell.views').map(c => c.id)).toEqual([ACCOUNTS_VIEWS.navigator, ACCOUNTS_VIEWS.register, ACCOUNTS_VIEWS.reconcile])
    expect(resolveDialogs(impls('shell.dialogs'), () => 'x').dialogs.map(d => d.id))
      .toEqual([ACCOUNTS_DIALOGS.account, ACCOUNTS_DIALOGS.move, ACCOUNTS_DIALOGS.reconcile])
  })

  it('provides exactly the AccountsService contract, and a migrator for ledger.schema', async () => {
    const { accounts, runtime } = await setup()
    expect(Object.keys(accounts).sort()).toEqual([
      'balances', 'categories', 'chart', 'closeAccount', 'createAccount', 'deleteAccount', 'get', 'list', 'moveAccount',
      'onDidChange', 'payees', 'reconciliation', 'reopenAccount', 'transactions', 'updateAccount'
    ])
    expect(runtime.services.has('accounts.migrator')).toBe(true)
    expect(runtime.extensions.getContributions('ledger.schema').map(c => c.id)).toEqual(['accounts'])
  })

  it('replaces the ledger\'s own panel with its navigator', async () => {
    const { key, open, reveals } = await setup()
    expect(key(LEDGER_CONTEXT_KEYS.hasNavigator)).toBe(true)
    await open()
    expect(reveals).toContain(ACCOUNTS_VIEWS.navigator)
    expect(reveals).not.toContain('ledger.tree')
  })

  it('stores its accounts in a ledger made before it was installed, without fuss', async () => {
    const { open, accounts } = await setup()
    await open()
    await expect(accounts.list()).resolves.toEqual([])
  })
})

// Commands act on the navigator's selection, and are enabled only when it makes them applicable (so the menu greys
// out to match). The navigator selects a row before acting on it; other plugins use accounts.service instead.
describe('the accounts plugin: commands and selection', () => {
  it('enables account commands by what is selected, published as context keys', async () => {
    const { enabled, open, ask, key, accounts } = await setup()
    expect(enabled(C.newAccount)).toBe(false)
    await open()
    expect(enabled(C.newAccount)).toBe(true)
    expect(key(K.selectionKind)).toBe('ledger')
    expect(enabled(C.editAccount)).toBe(false)
    expect(enabled(C.move)).toBe(false)

    const a = await accounts.createAccount(chequing({ openingBalance: 0 }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: a.id })
    expect([key(K.selectionKind), key(K.selectionId), key(K.selectionIsClosed)]).toEqual(['account', a.id, false])
    expect([enabled(C.editAccount), enabled(C.closeAccount), enabled(C.reopenAccount), enabled(C.deleteAccount), enabled(C.move)])
      .toEqual([true, true, false, true, true])

    await accounts.closeAccount(a.id)
    await new Promise(resolve => setTimeout(resolve, 0))      // the selection follows the change
    expect(key(K.selectionIsClosed)).toBe(true)
    expect([enabled(C.editAccount), enabled(C.closeAccount), enabled(C.reopenAccount)]).toEqual([false, false, true])
  })

  it('falls back to the ledger when the selected account goes, and refuses a malformed selection', async () => {
    const { open, ask, key, accounts } = await setup()
    await open()
    const a = await accounts.createAccount(chequing())
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: a.id })
    await accounts.deleteAccount(a.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(key(K.selectionKind)).toBe('ledger')
    await expect(ask(ACCOUNTS_CHANNELS.select, { kind: 'account' })).rejects.toThrow('A selection is')
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: 'gone' })
    expect(key(K.selectionKind)).toBe('ledger')
  })

  it('New Account opens the dialog in the selected sub-ledger, then selects the new account', async () => {
    const { open, ask, run, prompts, session, last, accounts } = await setup()
    await open()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    await accounts.createAccount(chequing({ currency: 'USD', name: 'US' }))
    await accounts.createAccount(chequing({ currency: 'USD', name: 'US 2' }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'subLedger', id: personal.id })
    prompts.show.mockResolvedValueOnce({ id: 'new-id' })

    await run(C.newAccount)

    const [dialog, input] = prompts.show.mock.calls[0] as [string, AccountDialogInput]
    expect(dialog).toBe(ACCOUNTS_DIALOGS.account)
    expect(input).toMatchObject({ mode: 'create', subLedgerId: personal.id, ledgerName: 'Home', defaultCurrency: 'USD' })
    expect(input.subLedgers.map(s => s.name)).toEqual(['Personal'])
    expect(last(ACCOUNTS_EVENTS.selection)).toEqual({ kind: 'ledger' })    // 'new-id' doesn't exist, so the ledger
  })

  it('New Account with an argument puts it there, whatever is selected', async () => {
    const { open, run, prompts } = await setup()
    await open()
    await run(C.newAccount, { subLedgerId: null })
    expect((prompts.show.mock.calls[0][1] as any).subLedgerId).toBeNull()
  })

  it('Edit Account opens the dialog on the account, titled for editing; a closed one must be reopened first', async () => {
    const { open, run, prompts, accounts, ask, enabled } = await setup()
    await open()
    const a = await accounts.createAccount(chequing({ openingBalance: 0 }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: a.id })
    await run(C.editAccount, { id: a.id })
    expect(prompts.show).toHaveBeenCalledWith(ACCOUNTS_DIALOGS.account, expect.objectContaining({ mode: 'edit', account: a }), { title: 'Edit Account' })

    await run(C.closeAccount)
    expect(enabled(C.editAccount)).toBe(false)
    await expect(run(C.editAccount)).rejects.toThrow('Command is disabled')
  })

  it('Close Account says the balance when there is one, and closes with that confirmed', async () => {
    const { open, run, prompts, answers, accounts, ask } = await setup()
    await open()
    const visa = await accounts.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: -54000 }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: visa.id })

    answers.push(false)
    expect(await run(C.closeAccount, { id: visa.id })).toBe(false)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Close account “Visa”?', confirmLabel: 'Close Account', detail: expect.stringMatching(/^Its balance is .*540\.00, not zero\./)
    }))
    expect((await accounts.get(visa.id))!.closed).toBe(false)

    expect(await run(C.closeAccount, { id: visa.id })).toBe(true)
    expect((await accounts.get(visa.id))!.closed).toBe(true)
    expect(await run(C.reopenAccount, { id: visa.id })).toBe(true)
    expect((await accounts.get(visa.id))!.closed).toBe(false)
  })

  it('Delete Account asks, as a destructive action, then deletes and selects the ledger', async () => {
    const { open, run, prompts, accounts, ask, key } = await setup()
    await open()
    const a = await accounts.createAccount(chequing())
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: a.id })
    expect(await run(C.deleteAccount)).toBe(true)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Delete account “Chequing”?', destructive: true }))
    expect(await accounts.get(a.id)).toBeUndefined()
    expect(key(K.selectionKind)).toBe('ledger')
  })

  it('hands the sub-ledger commands to the ledger, with the selection as their argument', async () => {
    const { open, run, prompts, session, ask, accounts } = await setup()
    await open()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    await accounts.createAccount(chequing({ subLedgerId: personal.id }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'subLedger', id: personal.id })

    await run(C.newSubLedger)
    expect(prompts.show).toHaveBeenLastCalledWith('ledger.dialog.new', expect.objectContaining({ parentId: personal.id }))
    await run(C.renameSubLedger)
    expect(prompts.show).toHaveBeenLastCalledWith('ledger.dialog.rename', expect.objectContaining({ id: personal.id }))
    await run(C.deleteSubLedger)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ detail: 'Its 1 account will move to “Home”. Nothing in it is deleted.' }))
    expect((await accounts.list()).map(a => a.subLedgerId)).toEqual([null])
  })

  it('Move To… offers the tree, for an account or a sub-ledger', async () => {
    const { open, run, prompts, session, accounts, ask } = await setup()
    await open()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const a = await accounts.createAccount(chequing({ subLedgerId: personal.id }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: a.id })
    await run(C.move)
    const [dialog, input, options] = prompts.show.mock.calls.at(-1) as [string, MoveDialogInput, object]
    expect(dialog).toBe(ACCOUNTS_DIALOGS.move)
    expect(input.item).toEqual({ kind: 'account', id: a.id, name: 'Chequing', parentId: personal.id })
    expect(options).toEqual({ title: 'Move “Chequing”' })
  })
})

describe('the accounts plugin: requests and events', () => {
  it('answers the chart, and pushes it after every change', async () => {
    const { open, ask, last, accounts } = await setup()
    expect(await ask(ACCOUNTS_CHANNELS.chart)).toBeNull()
    await open()
    await accounts.createAccount(chequing())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(last(ACCOUNTS_EVENTS.chart).accounts.map((s: any) => s.account.name)).toEqual(['Chequing'])
    expect((await ask(ACCOUNTS_CHANNELS.chart)).totals).toEqual({ CAD: 100000 })
  })

  it('saves accounts for the dialog, with errors as results on their fields', async () => {
    const { open, ask } = await setup()
    await open()
    const created = await ask(ACCOUNTS_CHANNELS.saveAccount, { input: chequing({ institution: 'TD' }) })
    expect(created).toMatchObject({ ok: true, value: { name: 'Chequing', institution: 'TD' } })
    expect(await ask(ACCOUNTS_CHANNELS.saveAccount, { input: chequing({ name: 'chequing' }) }))
      .toMatchObject({ ok: false, error: { code: 'DUPLICATE_NAME', field: 'name' } })

    // Editing sends the whole form: a field it leaves out was emptied
    const { institution: _dropped, ...form } = chequing({ name: 'Everyday' })
    const edited = await ask(ACCOUNTS_CHANNELS.saveAccount, { id: created.value.id, input: form, expectedRev: created.value.rev })
    expect(edited.value).toMatchObject({ name: 'Everyday' })
    expect(edited.value).not.toHaveProperty('institution')
    expect(await ask(ACCOUNTS_CHANNELS.saveAccount, { id: created.value.id, input: form, expectedRev: created.value.rev }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })

  it('moves accounts and sub-ledgers for the dialog, turning the ledger\'s refusals into results', async () => {
    const { open, ask, session, accounts } = await setup()
    await open()
    const a = await session.createSubLedger({ name: 'A', parentId: null })
    const b = await session.createSubLedger({ name: 'B', parentId: a.id })
    const account = await accounts.createAccount(chequing())
    expect(await ask(ACCOUNTS_CHANNELS.move, { kind: 'account', id: account.id, to: b.id })).toEqual({ ok: true })
    expect((await accounts.get(account.id))!.subLedgerId).toBe(b.id)
    expect(await ask(ACCOUNTS_CHANNELS.move, { kind: 'subLedger', id: a.id, to: b.id }))
      .toMatchObject({ ok: false, error: { code: 'INVALID', field: 'to', message: expect.stringContaining('can’t be moved into itself') } })
  })
})
