// @vitest-environment node
// The two extension points `accounts` offers other plugins for its own UI: items in a register row's context menu
// (`accounts.transaction.actions`) and rows in the navigator (`accounts.navigator.items`). The `recurring` plugin
// is their first consumer; see docs/recurring-transactions-design.md.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_COMMANDS } from '@tessera/book-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, ACCOUNTS_SERVICE, NAVIGATOR_ITEMS_POINT, RECONCILE_ACTIONS_POINT,
  REGISTER_FIGURES_POINT, STATEMENT_RECONCILER, TRANSACTION_ACTIONS_POINT, type AccountsService
} from '@tessera/accounts-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBook } from '../../../plugins/book/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../book/harness'
import { chequing } from './harness'

async function setup() {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  const { prompts } = fakePrompts()
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  const shell = createPluginContext('shell', runtime).context
  shell.commands.register('shell.layout.reveal', () => undefined)
  const events: { name: string, data?: unknown }[] = []
  runtime.events.subscribe(event => events.push(event))
  await activateBook(createPluginContext('book', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(BOOK_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const chq = await accounts.createAccount(chequing())
  const visa = await accounts.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: 0 }))

  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  /** A second plugin, as `recurring` will be. */
  const other = createPluginContext('recurring', runtime).context
  const named = (name: string) => events.filter(e => e.name === name).map(e => e.data)
  return { runtime, log, accounts, chq, visa, ask, other, named }
}

const rowAction = (over: object = {}) =>
  ({ id: 'recurring.fromTransaction', label: 'Make Recurring…', command: 'recurring.fromTransaction', icon: 'Repeat', ...over })

describe('accounts.transaction.actions: a register row\'s context menu', () => {
  it('offers a contributed item, enabled exactly when its command is', async () => {
    const { ask, chq, other, runtime } = await setup()
    other.commands.register('recurring.fromTransaction', () => undefined, { enablement: 'recurring.ready' })
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'recurring.fromTransaction', rowAction())

    expect(await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 })).toEqual([
      { id: 'recurring.fromTransaction', label: 'Make Recurring…', command: 'recurring.fromTransaction', icon: 'Repeat', enabled: false }
    ])
    runtime.contextKeys.set('recurring.ready', true)
    expect((await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 }))[0].enabled).toBe(true)
  })

  it('honours accountTypes, singleOnly and needsEditable', async () => {
    const { ask, chq, visa, accounts, other } = await setup()
    other.commands.register('recurring.fromTransaction', () => undefined)
    other.commands.register('recurring.bulk', () => undefined)
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'recurring.fromTransaction',
      rowAction({ singleOnly: true, accountTypes: ['chequing'] }))
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'recurring.bulk',
      rowAction({ id: 'recurring.bulk', label: 'Bulk', command: 'recurring.bulk', needsEditable: false }))

    const ids = async (accountId: string, count: number) =>
      (await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId, count })).map((a: { id: string }) => a.id)

    expect(await ids(chq.id, 1)).toEqual(['recurring.fromTransaction', 'recurring.bulk'])
    // singleOnly: gone once two rows are selected
    expect(await ids(chq.id, 2)).toEqual(['recurring.bulk'])
    // accountTypes: not a chequing account
    expect(await ids(visa.id, 1)).toEqual(['recurring.bulk'])
    // needsEditable defaults to true, so only the one that opts out survives a closed account
    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect(await ids(chq.id, 1)).toEqual(['recurring.bulk'])
  })

  it('still shows a transaction-scope reconcile action, after the new point\'s items', async () => {
    const { ask, chq, other } = await setup()
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'recurring.fromTransaction', rowAction())
    other.extensions.contribute('recurring', RECONCILE_ACTIONS_POINT, 'recurring.row',
      { id: 'recurring.row', label: 'Find on Statement', scope: 'transaction', command: 'recurring.find' })
    // An account-scope one belongs to the Reconcile menu, not here
    other.extensions.contribute('recurring', RECONCILE_ACTIONS_POINT, 'recurring.acct',
      { id: 'recurring.acct', label: 'Account Wide', scope: 'account', command: 'recurring.find' })

    expect((await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 })).map((a: { id: string }) => a.id))
      .toEqual(['recurring.fromTransaction', 'recurring.row'])
    // The statement reconciler is account-scope, so the Reconcile menu still has it and the row menu doesn't
    expect((await ask(ACCOUNTS_CHANNELS.reconcileActions, { accountId: chq.id, scope: 'account' })).map((a: { id: string }) => a.id))
      .toEqual([STATEMENT_RECONCILER, 'recurring.acct'])
  })

  it('skips an invalid contribution with one warning, and knows no account', async () => {
    const { ask, chq, other, log } = await setup()
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'a', { id: 'accounts.sneaky', label: 'x', command: 'x' })
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'b', { id: 'recurring.b', command: 'x' })
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'c', { id: 'recurring.c', label: 'x', command: 'x', accountTypes: ['piggyBank'] })
    other.extensions.contribute('recurring', TRANSACTION_ACTIONS_POINT, 'd', { id: 'recurring.d', label: 'x', command: 'x', singleOnly: 'yes' })

    expect(await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 })).toEqual([])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('needs an id starting with "recurring."'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"recurring.b" needs a label'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unknown account type'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invalid singleOnly'))
    expect(await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: 'gone', count: 1 })).toEqual([])
  })
})

describe('accounts.navigator.items: rows other plugins add', () => {
  const item = (over: object = {}) =>
    ({ id: 'recurring.navigator.list', label: 'Recurring', command: 'recurring.open', icon: 'Repeat', ...over })

  it('resolves a row with its placement, tone and command state', async () => {
    const { ask, other, runtime } = await setup()
    other.commands.register('recurring.open', () => undefined, { enablement: 'book.isOpen' })
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'recurring.navigator.list',
      item({ badgeKey: 'recurring.overdue.count', badgeTone: 'error', description: 'Payments and deposits that repeat' }))

    expect(await ask(ACCOUNTS_CHANNELS.navigatorItems)).toEqual([{
      id: 'recurring.navigator.list', label: 'Recurring', command: 'recurring.open', icon: 'Repeat',
      placement: 'bottom', badgeTone: 'error', description: 'Payments and deposits that repeat', enabled: true
    }])
    expect(runtime.commands.isEnabled('recurring.open')).toBe(true)
  })

  it('shows a badge only while its context key is truthy, and republishes the list when it moves', async () => {
    const { ask, other, runtime, named } = await setup()
    other.commands.register('recurring.open', () => undefined)
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'recurring.navigator.list',
      item({ badgeKey: 'recurring.overdue.count', badgeTone: 'error' }))

    // Unset, and zero, are both "nothing to warn about"
    expect((await ask(ACCOUNTS_CHANNELS.navigatorItems))[0].badge).toBeUndefined()
    runtime.contextKeys.set('recurring.overdue.count', 0)
    expect((await ask(ACCOUNTS_CHANNELS.navigatorItems))[0].badge).toBeUndefined()

    runtime.contextKeys.set('recurring.overdue.count', 3)
    expect((await ask(ACCOUNTS_CHANNELS.navigatorItems))[0].badge).toBe('3')
    // The navigator doesn't poll: the plugin pushes the whole list again
    expect(named(ACCOUNTS_EVENTS.navigatorItems).at(-1)).toEqual([expect.objectContaining({ badge: '3' })])

    // A key nothing contributed watches changes nothing
    const before = named(ACCOUNTS_EVENTS.navigatorItems).length
    runtime.contextKeys.set('something.else', 9)
    expect(named(ACCOUNTS_EVENTS.navigatorItems).length).toBe(before)
  })

  it('orders by order then contribution, and skips invalid rows with one warning', async () => {
    const { ask, other, log } = await setup()
    other.commands.register('recurring.open', () => undefined)
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'a', item({ id: 'recurring.a', order: 5 }))
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'b', item({ id: 'recurring.b', order: 1, placement: 'top' }))
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'c', item({ id: 'recurring.c', placement: 'sideways' }))
    other.extensions.contribute('recurring', NAVIGATOR_ITEMS_POINT, 'd', item({ id: 'recurring.d', badgeTone: 'puce' }))

    const rows = await ask(ACCOUNTS_CHANNELS.navigatorItems)
    expect(rows.map((r: { id: string, placement: string }) => [r.id, r.placement]))
      .toEqual([['recurring.b', 'top'], ['recurring.a', 'bottom']])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('needs a placement of "top" or "bottom"'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invalid badgeTone'))
  })
})

describe('accounts.register.figures: numbers other plugins add above the register', () => {
  const figure = (over: object = {}) =>
    ({ id: 'recurring.projected', label: 'Projected (30 days)', command: 'recurring.projectBalance', ...over })

  it('resolves a figure for an account, enabled exactly when its command is', async () => {
    const { ask, chq, other, runtime } = await setup()
    other.commands.register('recurring.projectBalance', () => ({ minor: 1, currency: 'CAD' }), { enablement: 'book.isOpen' })
    other.extensions.contribute('recurring', REGISTER_FIGURES_POINT, 'recurring.projected',
      figure({ refreshOn: 'recurring:snapshot.changed', description: 'What is coming' }))

    expect(await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: chq.id })).toEqual([{
      id: 'recurring.projected', label: 'Projected (30 days)', command: 'recurring.projectBalance',
      refreshOn: 'recurring:snapshot.changed', description: 'What is coming', enabled: true
    }])
    runtime.contextKeys.set('book.isOpen', false)
    expect((await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: chq.id }))[0].enabled).toBe(false)
  })

  it('honours accountTypes, skips an invalid contribution with one warning, and knows no account', async () => {
    const { ask, chq, visa, other, log } = await setup()
    other.extensions.contribute('recurring', REGISTER_FIGURES_POINT, 'a', figure({ accountTypes: ['creditCard'] }))
    other.extensions.contribute('recurring', REGISTER_FIGURES_POINT, 'b', figure({ id: 'recurring.b', refreshOn: 42 }))
    other.extensions.contribute('recurring', REGISTER_FIGURES_POINT, 'c', figure({ id: 'accounts.sneaky' }))

    expect(await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: chq.id })).toEqual([])
    expect((await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: visa.id })).map((f: { id: string }) => f.id)).toEqual(['recurring.projected'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invalid refreshOn'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('needs an id starting with "recurring."'))
    expect(await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: 'gone' })).toEqual([])
  })
})
