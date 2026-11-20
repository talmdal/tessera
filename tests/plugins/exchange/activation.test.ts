// @vitest-environment node
// The book, accounts and exchange plugins activated together, as the app runs them, and driven through IPC and
// commands: the service, the schema, the channels, the context keys, and the File ▸ Import flow that reads a
// file, settles each statement's account, and files it to read.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_COMMANDS, BOOK_SCHEMA_POINT } from '@tessera/book-api'
import {
  ACCOUNTS_DIALOGS, ACCOUNTS_SERVICE, NAVIGATOR_ITEMS_POINT, REGISTER_OVERLAYS_POINT,
  type AccountsService, type OverlayRow
} from '@tessera/accounts-api'
import {
  EXCHANGE_CHANNELS, EXCHANGE_COLLECTIONS, EXCHANGE_COMMANDS, EXCHANGE_CONTEXT_KEYS as K, EXCHANGE_DIALOGS,
  EXCHANGE_EVENTS, EXCHANGE_MIGRATOR_SERVICE, EXCHANGE_OPTIONS_DEFAULTS, type ExchangeOptions, EXCHANGE_PLUGIN_ID, EXCHANGE_SERVICE, EXCHANGE_VIEWS, FORMATS_POINT,
  type ChooseAccountResult, type ExchangeService
} from '@tessera/exchange-api'
import { OPTIONS_EXTENSION_POINT } from '@tessera/types'
import type { OptionsService } from '../../../core/options/OptionsService'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveViews } from '../../../shared/views/resolveViews'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBook } from '../../../plugins/book/src/privileged/index'
import { activate as activateExchange } from '../../../plugins/exchange/src/privileged/index'
import { CSV_FORMAT, activate as activateCsv } from '../../../plugins/exchange.csv/src/privileged/index'
import { OFX_FORMATS, activate as activateOfx } from '../../../plugins/exchange.ofx/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryBackupDisk, memoryDisk } from '../book/harness'
import { BOOK_CONTEXT_KEYS, BOOK_DIALOGS, type NewBookDialogResult } from '@tessera/book-api'
import { chequing, document, fakeDisk, fakeFormat, row, statement } from './harness'

async function setup(options: { withFormat?: boolean, revealFails?: boolean, withCsv?: boolean, withOfx?: boolean } = {}) {
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

  // The shell owns `shell.layout.reveal`; here it only has to record what was asked for
  const revealed: string[] = []
  const shell = createPluginContext('shell', runtime).context
  shell.commands.register('shell.layout.reveal', (id: unknown) => {
    if (options.revealFails === true) return false
    revealed.push(String(id))
    return true
  })

  const events: { name: string, data?: unknown }[] = []
  runtime.events.subscribe(event => events.push(event))

  const format = fakeFormat()
  if (options.withFormat === true) {
    runtime.services.provide('fake', format.contribution.service, format.format)
    runtime.extensions.contribute('fake', FORMATS_POINT, format.contribution.id, format.contribution)
  }

  await activateBook(createPluginContext('book', runtime).context, { disk: disk.disk, backupDisk: memoryBackupDisk().disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  const exchangeFiles = fakeDisk({ '/in/statement.fake': 'FAKE file' })
  const exchangeDisk = exchangeFiles.disk
  await activateExchange(createPluginContext(EXCHANGE_PLUGIN_ID, runtime).context, { disk: exchangeDisk })
  // The real CSV plugin, when a test needs a format that can actually be written.
  if (options.withCsv === true) await activateCsv(createPluginContext('exchange-csv', runtime).context)
  if (options.withOfx === true) await activateOfx(createPluginContext('exchange-ofx', runtime).context)

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(BOOK_COMMANDS.new)

  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const exchange = runtime.services.get<ExchangeService>(EXCHANGE_SERVICE)
  const chq = await accounts.createAccount(chequing())

  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const key = (name: string) => runtime.contextKeys.get(name)
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  return {
    runtime, log, files, prompts, answers, accounts, exchange, chq, ask, key, settle, driver, revealed, events,
    disk: exchangeFiles, format
  }
}

describe('activating the exchange plugin', () => {
  it('provides the service, and offers only the contract', async () => {
    const { exchange } = await setup()
    expect(Object.keys(exchange).sort()).toEqual([
      'accept', 'dismiss', 'editRow', 'ensureCategories', 'export', 'file', 'formats', 'history', 'links',
      'matchingCandidates', 'onDidChange', 'payeeRules', 'pendingFor', 'pendingSummary', 'previewRename', 'read',
      'removeLink', 'setMatch', 'undo', 'updateLink'
    ])
  })

  it('provides the migrator its schema contribution names', async () => {
    const { runtime } = await setup()
    expect(runtime.services.has(EXCHANGE_MIGRATOR_SERVICE)).toBe(true)
    const contributed = runtime.extensions.getContributions(BOOK_SCHEMA_POINT)
      .find(c => c.contributor === EXCHANGE_PLUGIN_ID)
    expect(contributed?.impl).toMatchObject({ id: 'exchange', version: 4, migrator: EXCHANGE_MIGRATOR_SERVICE })
  })

  it('creates its collections in a new book, the pending statements among them', async () => {
    const { driver } = await setup()
    const book = [...driver.databases.values()][0]
    const names = [...(book?.collections.keys() ?? [])]
    for (const collection of Object.values(EXCHANGE_COLLECTIONS)) {
      expect(names).toContain(collection)
    }
  })

  it('answers every channel its views will use', async () => {
    const { ask } = await setup()
    expect(await ask(EXCHANGE_CHANNELS.formats)).toEqual([])
    expect(await ask(EXCHANGE_CHANNELS.history, {})).toEqual([])
    expect(await ask(EXCHANGE_CHANNELS.links)).toEqual([])
    expect(await ask(EXCHANGE_CHANNELS.rules)).toEqual([])
    expect(await ask(EXCHANGE_CHANNELS.pendingSummary)).toEqual([])
    expect(await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: 'nowhere' })).toEqual([])
  })

  it('leaves the format count unset while none is installed, so File ▸ Import greys out on its own', async () => {
    const { key } = await setup()
    expect(key(K.formatCount)).toBeUndefined()
    expect(key(K.canUndo)).toBeUndefined()
    expect(key(K.pendingCount)).toBeUndefined()
  })

  it('counts the formats a plugin contributed', async () => {
    const { key, ask } = await setup({ withFormat: true })
    expect(key(K.formatCount)).toBe(1)
    expect(await ask(EXCHANGE_CHANNELS.formats)).toHaveLength(1)
  })
})

describe('reading a file through the plugin’s own disk', () => {
  it('reports a file that is not there as a message, rather than crashing', async () => {
    const { runtime, files, prompts } = await setup({ withFormat: true })
    files.showOpenDialog.mockResolvedValueOnce('/nowhere/missing.fake')
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)
    expect(prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })
})

describe('what the flow needs from the shell', () => {
  it('puts Import and Statements to Read in the File menu', async () => {
    const { runtime } = await setup()
    const items = runtime.extensions.getContributions('shell.menus').map(c => c.impl as { id: string, parent: string, command: string })
    expect(items.find(entry => entry.id === 'exchange.menu.import'))
      .toMatchObject({ parent: 'shell.file', command: EXCHANGE_COMMANDS.import })
    expect(items.find(entry => entry.id === 'exchange.menu.statements'))
      .toMatchObject({ parent: 'shell.file', command: EXCHANGE_COMMANDS.statements })
  })

  it('greys the import item out until a format is installed', async () => {
    const plain = await setup()
    expect(plain.key(K.formatCount)).toBeUndefined()
    expect(await plain.runtime.commands.isEnabled(EXCHANGE_COMMANDS.import)).toBe(false)

    const withFormat = await setup({ withFormat: true })
    expect(await withFormat.runtime.commands.isEnabled(EXCHANGE_COMMANDS.import)).toBe(true)
  })

  it('contributes the Statements view, the two dialogs, the register overlay and the navigator row', async () => {
    const { runtime } = await setup()
    const views = runtime.extensions.getContributions('shell.views').map(c => c.impl as { id: string, slot: string, module: string })
    expect(views.find(view => view.id === EXCHANGE_VIEWS.statements))
      .toMatchObject({ slot: 'shell.main', module: './StatementsView' })

    // The shell drops a view it can't resolve (an unknown icon, say), and revealing it then quietly does nothing
    const resolved = resolveViews(runtime.extensions.getContributions('shell.views')
      .filter(c => c.contributor === EXCHANGE_PLUGIN_ID), () => 'remoteEntry.js')
    expect(resolved.diagnostics).toEqual([])
    expect(resolved.views.map(view => view.id)).toContain(EXCHANGE_VIEWS.statements)

    const dialogs = runtime.extensions.getContributions('shell.dialogs').map(c => c.impl as { id: string, module: string })
    expect(dialogs.find(dialog => dialog.id === EXCHANGE_DIALOGS.account)).toMatchObject({ module: './ChooseAccountDialog' })
    expect(dialogs.find(dialog => dialog.id === EXCHANGE_DIALOGS.matching)).toMatchObject({ module: './MatchingDialog' })
    expect(dialogs.find(dialog => dialog.id === EXCHANGE_DIALOGS.question)).toMatchObject({ module: './QuestionDialog' })

    const overlays = runtime.extensions.getContributions(REGISTER_OVERLAYS_POINT).map(c => c.impl as { id: string, channel: string })
    expect(overlays.find(overlay => overlay.id === 'exchange.pending'))
      .toMatchObject({ channel: EXCHANGE_CHANNELS.pendingRows, refreshOn: EXCHANGE_EVENTS.pending })

    const items = runtime.extensions.getContributions(NAVIGATOR_ITEMS_POINT).map(c => c.impl as { id: string, badgeKey?: string })
    expect(items.find(item => item.id === 'exchange.statementsToRead'))
      .toMatchObject({ command: EXCHANGE_COMMANDS.statements, badgeKey: K.pendingCount })
  })

  it('says nothing when the user cancels the file dialog: that is not a failure', async () => {
    const { runtime, files, prompts } = await setup({ withFormat: true })
    files.showOpenDialog.mockResolvedValueOnce(undefined)
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)
    expect(prompts.message).not.toHaveBeenCalled()
  })
})

describe('File ▸ Import, end to end', () => {
  it('files the statement against the matching account, reveals Statements to Read, and counts the rows', async () => {
    const { runtime, files, key, settle, revealed, exchange, chq, ask, events } = await setup({ withFormat: true })
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)
    await settle()

    expect(revealed).toContain(EXCHANGE_VIEWS.statements)
    expect(key(K.pendingCount)).toBe(1)
    expect(await exchange.pendingFor(chq.id)).toHaveLength(1)
    expect(events.some(e => e.name === EXCHANGE_EVENTS.pending)).toBe(true)

    const lines = await ask(EXCHANGE_CHANNELS.pendingSummary)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ accountId: chq.id, items: 1 })

    // Resolving by number also remembers the link, so next month's file asks nothing
    expect(await exchange.links()).toHaveLength(1)
  })

  it('accepts a row from the register overlay, through the commands the overlay actions name', async () => {
    const { runtime, files, ask, key, settle, chq, accounts } = await setup({ withFormat: true })
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    const rows: OverlayRow[] = await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: chq.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].actions.map(a => a.command)).toEqual([
      EXCHANGE_COMMANDS.accept, EXCHANGE_COMMANDS.change, EXCHANGE_COMMANDS.rename, EXCHANGE_COMMANDS.skip
    ])

    await runtime.commands.execute(EXCHANGE_COMMANDS.accept, { accountId: chq.id, key: rows[0].key })
    await settle()

    const register = await accounts.transactions(chq.id).register()
    expect(register.rows).toHaveLength(1)
    expect(register.rows[0].transaction.status).toBe('electronic')
    expect(await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: chq.id })).toEqual([])
    expect(key(K.pendingCount)).toBeUndefined()
    expect(key(K.canUndo)).toBe(true)
  })

  it('opens Change Transaction Matching and keeps the user’s answer in the book', async () => {
    const { runtime, files, prompts, ask, chq, exchange, accounts } = await setup({ withFormat: true })
    await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    const [found]: OverlayRow[] = await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: chq.id })
    expect(found.matchedId).toBeDefined()

    // The user keeps the row unmatched
    prompts.show.mockResolvedValueOnce({ matchTo: null })
    await runtime.commands.execute(EXCHANGE_COMMANDS.change, { accountId: chq.id, key: found.key })

    expect(prompts.show).toHaveBeenCalledWith(EXCHANGE_DIALOGS.matching, expect.objectContaining({
      entry: expect.objectContaining({ payee: 'Hydro Ottawa' }),
      currentId: found.matchedId
    }))
    const [statementDoc] = await exchange.pendingFor(chq.id)
    expect(statementDoc.rows[0].userMatch).toBeNull()
  })
})

describe('a statement for an account the book does not have', () => {
  const elsewhere = () => document({
    statements: [statement({
      account: { number: '5555000099', currency: 'CAD' },
      balances: { ledger: { amount: 100_000, asOf: '2026-11-30' } },
      transactions: [row({ amount: -14_200 })]
    })],
    institution: { name: 'Maple Trust Bank' }
  })

  it('asks with the Choose Account dialog, and files into the account the user picked', async () => {
    const { runtime, files, prompts, format, exchange, chq } = await setup({ withFormat: true })
    format.next(elsewhere())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    prompts.show.mockImplementation(async (dialogId: unknown) =>
      dialogId === EXCHANGE_DIALOGS.account
        ? { kind: 'existing', accountId: chq.id, remember: true } satisfies ChooseAccountResult
        : undefined)

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    expect(prompts.show).toHaveBeenCalledWith(EXCHANGE_DIALOGS.account, expect.objectContaining({
      statement: 'The Maple Trust Bank account ····0099',
      currency: 'CAD',
      canCreate: true
    }))
    expect(await exchange.pendingFor(chq.id)).toHaveLength(1)
    const links = await exchange.links()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ accountId: chq.id, numberKey: '5555000099' })
  })

  it('opens the New Account dialog prefilled when the user asks for a new account', async () => {
    const { runtime, files, prompts, format, accounts, exchange } = await setup({ withFormat: true })
    format.next(elsewhere())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    let created: string | undefined
    prompts.show.mockImplementation(async (dialogId: unknown) => {
      if (dialogId === EXCHANGE_DIALOGS.account) return { kind: 'create', remember: false } satisfies ChooseAccountResult
      if (dialogId !== ACCOUNTS_DIALOGS.account) return undefined
      created = (await accounts.createAccount(chequing({ name: 'Maple chequing', accountNumber: '5555000099' }))).id
      return { id: created }
    })

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    expect(prompts.show).toHaveBeenCalledWith(ACCOUNTS_DIALOGS.account, expect.objectContaining({
      mode: 'create',
      // The opening balance is the statement's balance less what it files, so the account ends at the bank's
      defaults: expect.objectContaining({ accountNumber: '5555000099', currency: 'CAD', institution: 'Maple Trust Bank', openingBalance: 114_200 })
    }))
    expect(created).toBeDefined()
    expect(await exchange.pendingFor(created!)).toHaveLength(1)
  })

  it('skips the statement when the user cancels the dialog, filing nothing', async () => {
    const { runtime, files, prompts, format, exchange, chq } = await setup({ withFormat: true })
    format.next(elsewhere())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    prompts.show.mockResolvedValue(undefined)

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    expect(await exchange.pendingFor(chq.id)).toEqual([])
    expect(await exchange.links()).toEqual([])
  })
})

describe('a file holding several accounts', () => {
  /** A whole-book export: two accounts, a transfer between them, and a category list. */
  const wholeBook = () => document({
    formatId: 'fake.statements',
    categories: [{ path: 'Utilities : Electricity', kind: 'expense' }, { path: 'Salary', kind: 'income' }],
    statements: [
      statement({
        account: { name: 'Chequing' },
        transactions: [row({ category: 'Utilities : Electricity' }), row({ date: '2026-11-10', amount: -50000, payee: 'To savings', transferAccount: 'My Savings' })]
      }),
      statement({
        account: { name: 'My Savings', type: 'savings' },
        transactions: [row({ date: '2026-11-10', amount: 50000, payee: 'From chequing', transferAccount: 'Chequing' })]
      })
    ]
  })

  /** Answers each dialog by what it is: the import's questions, the Choose Account dialog, the book's new-book dialog. */
  const answering = (prompts: ReturnType<typeof fakePrompts>['prompts'], answers: {
    destination?: 'this' | 'new', currency?: string, choose?: ChooseAccountResult
  }) => {
    prompts.show.mockImplementation(async (dialogId: unknown, input: unknown) => {
      if (dialogId === EXCHANGE_DIALOGS.question) {
        const question = (input as { question: { id: string } }).question
        if (question.id === 'exchange.import.destination') return answers.destination
        if (question.id === 'exchange.import.currency') return answers.currency
      }
      if (dialogId === EXCHANGE_DIALOGS.account) return answers.choose
      if (dialogId === BOOK_DIALOGS.newBook) return { kind: 'file', name: 'Imported' } satisfies NewBookDialogResult
      return undefined
    })
  }

  it('asks where they go, and adds them to the open book — matching by name and asking for the rest', async () => {
    const { runtime, files, prompts, format, exchange, accounts, chq } = await setup({ withFormat: true })
    const savings = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', accountNumber: '9999000011' }))
    format.next(wholeBook())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    answering(prompts, { destination: 'this', choose: { kind: 'existing', accountId: savings.id, remember: false } })

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    expect(prompts.show).toHaveBeenCalledWith(EXCHANGE_DIALOGS.question, expect.objectContaining({
      question: expect.objectContaining({ id: 'exchange.import.destination', title: expect.stringContaining('2 accounts') })
    }), expect.anything())
    // "Chequing" matched the book's account by name; "My Savings" did not, so the user was asked
    expect(prompts.show).toHaveBeenCalledWith(EXCHANGE_DIALOGS.account, expect.objectContaining({ statement: '“My Savings”' }))
    expect((await exchange.pendingFor(chq.id))[0].rows).toHaveLength(2)
    expect((await exchange.pendingFor(savings.id))[0].rows).toHaveLength(1)
    // The file's categories now exist in the book
    const categories = await accounts.categories.list()
    expect(categories.some(c => c.name === 'Electricity')).toBe(true)
    expect(categories.some(c => c.name === 'Salary')).toBe(true)
  })

  it('resolves a transfer the file wrote by its own account name to the account the user chose', async () => {
    const { runtime, files, prompts, format, exchange, accounts, chq, ask } = await setup({ withFormat: true })
    const savings = await accounts.createAccount(chequing({ name: 'Rainy Day', type: 'savings', accountNumber: '9999000011' }))
    format.next(wholeBook())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    answering(prompts, { destination: 'this', choose: { kind: 'existing', accountId: savings.id, remember: false } })
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)

    const [pending] = await exchange.pendingFor(chq.id)
    expect(pending.accountMap).toEqual({ Chequing: chq.id, 'My Savings': savings.id })
    const rows: OverlayRow[] = await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: chq.id })
    const transfer = rows.find(r => r.amount === -50000)!
    await runtime.commands.execute(EXCHANGE_COMMANDS.accept, { accountId: chq.id, key: transfer.key })

    const written = (await accounts.transactions(chq.id).register()).rows.find(r => r.transaction.amount === -50000)!
    expect(written.transaction.transferAccountId).toBe(savings.id)
    // The other side landed in Rainy Day, and the file's own row for it now matches that transaction
    const otherSide: OverlayRow[] = await ask(EXCHANGE_CHANNELS.pendingRows, { accountId: savings.id })
    expect(otherSide[0].matchedId).toBeDefined()
  })

  it('creates a new book from the file, with every account and category made from it, asking only the currency', async () => {
    const { runtime, files, prompts, format, exchange, accounts, key, settle } = await setup({ withFormat: true })
    format.next(wholeBook())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    files.showSaveDialog.mockResolvedValueOnce(file('Imported.tessera'))
    answering(prompts, { destination: 'new', currency: 'EUR' })

    await runtime.commands.execute(EXCHANGE_COMMANDS.import)
    await settle()

    const made = await accounts.list()
    expect(made.map(a => a.name).sort()).toEqual(['Chequing', 'My Savings'])
    expect(made.every(a => a.currency === 'EUR')).toBe(true)
    expect(made.find(a => a.name === 'My Savings')?.type).toBe('savings')
    expect(prompts.show).not.toHaveBeenCalledWith(EXCHANGE_DIALOGS.account, expect.anything())
    for (const account of made) expect((await exchange.pendingFor(account.id)).length).toBe(1)
    expect((await accounts.categories.list()).some(c => c.name === 'Electricity')).toBe(true)
    expect(key(K.pendingCount)).toBe(3)
  })

  it('does nothing when the user backs out of the destination question', async () => {
    const { runtime, files, prompts, format, exchange, chq } = await setup({ withFormat: true })
    format.next(wholeBook())
    files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    answering(prompts, {})
    await runtime.commands.execute(EXCHANGE_COMMANDS.import)
    expect(await exchange.pendingFor(chq.id)).toEqual([])
  })
})

describe('File ▸ Export Transactions…', () => {
  /** Queues the export dialog's answer, then the save dialog's path. */
  const exporting = (
    prompts: { show: { mockImplementation: (fn: (id: string) => Promise<unknown>) => unknown } },
    result: unknown
  ) => {
    prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.export ? result : undefined)
  }

  it('writes the chosen account through the chosen format, and says what it wrote', async () => {
    const { runtime, files, prompts, accounts, chq, disk } = await setup({ withCsv: true })
    await accounts.transactions(chq.id).create({
      date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa', memo: 'November'
    })

    exporting(prompts, { scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT })
    files.showSaveDialog.mockResolvedValueOnce('/out/Chequing.csv')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const written = disk.written.get('/out/Chequing.csv')
    expect(written).toBeDefined()
    const text = new TextDecoder().decode(written!)
    expect(text).toContain('Date,Number,Payee,Category,Memo,Amount,Balance,Status,Account')
    expect(text).toContain('Hydro Ottawa')
    expect(text).toContain('-142.00')
    expect(prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('1 transaction')
    }))
  })

  it('asks what to export before asking where to put it', async () => {
    const { runtime, files, prompts, chq } = await setup({ withCsv: true })
    const order: string[] = []
    prompts.show.mockImplementation(async (id: string) => {
      order.push('what')
      return id === EXCHANGE_DIALOGS.export
        ? { scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT }
        : undefined
    })
    files.showSaveDialog.mockImplementation(async () => { order.push('where'); return '/out/x.csv' })

    await runtime.commands.execute(EXCHANGE_COMMANDS.export)
    expect(order).toEqual(['what', 'where'])
  })

  it('writes nothing when the user backs out of either dialog', async () => {
    const backOut = await setup({ withCsv: true })
    backOut.prompts.show.mockResolvedValue(undefined)
    // Creating the book in `setup` already used the save dialog once, so count from here.
    const before = backOut.files.showSaveDialog.mock.calls.length
    await backOut.runtime.commands.execute(EXCHANGE_COMMANDS.export)
    expect(backOut.files.showSaveDialog.mock.calls.length).toBe(before)
    expect(backOut.disk.written.size).toBe(0)

    // And cancelling the save dialog leaves nothing behind either.
    const cancelSave = await setup({ withCsv: true })
    exporting(cancelSave.prompts, { scope: { kind: 'book' }, formatId: CSV_FORMAT })
    cancelSave.files.showSaveDialog.mockResolvedValueOnce(undefined)
    await cancelSave.runtime.commands.execute(EXCHANGE_COMMANDS.export)
    expect(cancelSave.disk.written.size).toBe(0)
  })

  it('pre-fills the save dialog with the account’s name and the format’s extension', async () => {
    const { runtime, files, prompts, chq } = await setup({ withCsv: true })
    exporting(prompts, { scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT })
    files.showSaveDialog.mockResolvedValueOnce('/out/Chequing.csv')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    expect(files.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/Chequing\.csv$/),
      filters: [expect.objectContaining({ extensions: ['csv', 'tsv'] })]
    }))
  })

  it('offers the dialog only the formats that can be written', async () => {
    // The fake format reads but does not write, so it must not appear in the export dialog's list.
    const { runtime, files, prompts, chq } = await setup({ withCsv: true, withFormat: true })
    exporting(prompts, { scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT })
    files.showSaveDialog.mockResolvedValueOnce('/out/x.csv')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const input = prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.export)![1] as {
      formats: { id: string }[], accounts: { id: string }[], today: string
    }
    expect(input.formats.map(f => f.id)).toEqual([CSV_FORMAT])
    expect(input.accounts.map(a => a.id)).toContain(chq.id)
    expect(input.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is disabled outright when no format that can write is installed, rather than failing when pressed', async () => {
    // The fake format reads only, so Export greys itself out — the user never reaches a dialog to be
    // disappointed by. The command's own guard is a backstop for a format unregistered mid-session.
    const { runtime, prompts } = await setup({ withFormat: true })
    expect(runtime.commands.isEnabled(EXCHANGE_COMMANDS.export)).toBe(false)
    await expect(runtime.commands.execute(EXCHANGE_COMMANDS.export)).rejects.toThrow(/disabled/)
    expect(prompts.show).not.toHaveBeenCalledWith(EXCHANGE_DIALOGS.export, expect.anything())
  })

  it('is enabled once a format that can write is installed', async () => {
    const { runtime } = await setup({ withCsv: true })
    expect(runtime.commands.isEnabled(EXCHANGE_COMMANDS.export)).toBe(true)
  })

  it('counts the writable formats separately from the readable ones, for the menu item', async () => {
    const readOnly = await setup({ withFormat: true })
    expect(readOnly.key(K.formatCount)).toBe(1)
    expect(readOnly.key(K.writableFormatCount)).toBeUndefined()

    const writable = await setup({ withCsv: true })
    expect(writable.key(K.writableFormatCount)).toBe(1)
  })
})

describe('a format’s export options, end to end', () => {
  it('carries the dialog’s answer through to the writer', async () => {
    const { runtime, files, prompts, accounts, chq, disk } = await setup({ withCsv: true })
    await accounts.transactions(chq.id).create({ date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa' })

    prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? {
        scope: { kind: 'account', accountId: chq.id },
        formatId: CSV_FORMAT,
        // What the user chose in the section CSV contributed.
        formatOptions: { delimiter: ';', bom: false }
      }
      : undefined)
    files.showSaveDialog.mockResolvedValueOnce('/out/semi.csv')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const written = disk.written.get('/out/semi.csv')!
    const text = new TextDecoder().decode(written)
    expect(text.split('\r\n')[0]).toBe('Date;Number;Payee;Category;Memo;Amount;Balance;Status;Account')
    expect(written[0]).not.toBe(0xef)
  })

  it('offers the dialog the fields the format contributed', async () => {
    const { runtime, files, prompts, chq } = await setup({ withCsv: true })
    prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? { scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT }
      : undefined)
    files.showSaveDialog.mockResolvedValueOnce('/out/x.csv')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const input = prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.export)![1] as {
      formats: { id: string, fields: { key: string }[] }[]
    }
    expect(input.formats[0].fields.map(f => f.key)).toEqual(['delimiter', 'bom'])
  })

  it('falls back to the format’s own defaults when the caller passes no options at all', async () => {
    const { exchange, accounts, chq, disk } = await setup({ withCsv: true })
    await accounts.transactions(chq.id).create({ date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa' })

    // The service is an API as much as a menu item: a caller that never opened the dialog still gets the
    // file the dialog's defaults would have produced — here, a comma and a BOM.
    await exchange.export({ scope: { kind: 'account', accountId: chq.id }, formatId: CSV_FORMAT, path: '/out/plain.csv' })

    const written = disk.written.get('/out/plain.csv')!
    expect(written[0]).toBe(0xef)
    expect(new TextDecoder().decode(written)).toContain('Date,Number,Payee')
  })
})

describe('exporting OFX', () => {
  it('writes an OFX 2.x file for the chosen account', async () => {
    const { runtime, files, prompts, accounts, chq, disk } = await setup({ withOfx: true })
    await accounts.transactions(chq.id).create({ date: '2026-10-15', amount: -14200, payee: 'Hydro Ottawa' })

    prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? { scope: { kind: 'account', accountId: chq.id }, formatId: OFX_FORMATS.ofx }
      : undefined)
    files.showSaveDialog.mockResolvedValueOnce('/out/Chequing.ofx')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const text = new TextDecoder().decode(disk.written.get('/out/Chequing.ofx')!)
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(text).toContain('VERSION="211"')
    expect(text).toContain('<ACCTID>1234567890</ACCTID>')
    expect(text).toContain('<TRNAMT>-142.00</TRNAMT>')
    expect(text).toContain('<NAME>Hydro Ottawa</NAME>')
  })

  it('offers OFX but not QFX or QBO in the export dialog', async () => {
    const { runtime, files, prompts, chq } = await setup({ withOfx: true })
    prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? { scope: { kind: 'account', accountId: chq.id }, formatId: OFX_FORMATS.ofx }
      : undefined)
    files.showSaveDialog.mockResolvedValueOnce('/out/x.ofx')
    await runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const input = prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.export)![1] as {
      formats: { id: string, fields: unknown[] }[]
    }
    expect(input.formats.map(f => f.id)).toEqual([OFX_FORMATS.ofx])
    // OFX contributes no options of its own, so the dialog shows no section for it.
    expect(input.formats[0].fields).toEqual([])
  })

  it('refuses to export QFX or QBO, which Tessera has no identifier to issue', async () => {
    const { exchange, chq } = await setup({ withOfx: true })
    for (const formatId of [OFX_FORMATS.qfx, OFX_FORMATS.qbo]) {
      await expect(exchange.export({
        scope: { kind: 'account', accountId: chq.id }, formatId, path: '/out/x'
      })).rejects.toThrow(/does not write them|cannot be written/)
    }
  })
})

describe('File ▸ Import History… and Undo Import', () => {
  /** Imports the fake statement into the chequing account and accepts every row, closing the batch. */
  const importAndAccept = async (env: Awaited<ReturnType<typeof setup>>) => {
    env.format.next(document({ statements: [statement({ transactions: [row(), row({ externalId: 'FIT-2', amount: -999 })] })] }))
    env.files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.import)
    // Through the service: the accept *command* takes the register overlay's composite key, which is a
    // different thing from a row key and not what this helper is here to exercise. Bounded, so a row that
    // refuses to be accepted fails the test rather than hanging it.
    for (let guard = 0; guard < 20; guard += 1) {
      const [waiting] = await env.exchange.pendingFor(env.chq.id)
      if (waiting === undefined) return
      await env.exchange.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    }
    throw new Error('rows were still waiting after 20 acceptances')
  }

  it('greys out Undo Import until something has been imported', async () => {
    const env = await setup({ withFormat: true })
    expect(env.runtime.commands.isEnabled(EXCHANGE_COMMANDS.undo)).toBe(false)
    await importAndAccept(env)
    await env.settle()
    expect(env.runtime.commands.isEnabled(EXCHANGE_COMMANDS.undo)).toBe(true)
  })

  it('undoes the most recent import when given no argument, and says what it removed', async () => {
    const env = await setup({ withFormat: true })
    await importAndAccept(env)
    expect((await env.accounts.transactions(env.chq.id).register()).rows).toHaveLength(2)

    await env.runtime.commands.execute(EXCHANGE_COMMANDS.undo)

    expect((await env.accounts.transactions(env.chq.id).register()).rows).toEqual([])
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('2 transactions were removed')
    }))
  })

  it('shows the history, and undoes the import the dialog chose', async () => {
    const env = await setup({ withFormat: true })
    await importAndAccept(env)
    const [batch] = await env.exchange.history()

    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.history ? { undo: batch.id } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.history)

    const input = env.prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.history)![1] as {
      entries: { batch: { fileName: string }, accountNames: string[], blocked?: string }[]
    }
    expect(input.entries[0].batch.fileName).toBe('statement.fake')
    expect(input.entries[0].accountNames).toEqual(['Chequing'])
    expect(input.entries[0].blocked).toBeUndefined()
    expect((await env.accounts.transactions(env.chq.id).register()).rows).toEqual([])
  })

  it('says so rather than opening an empty dialog when nothing has been imported', async () => {
    const env = await setup({ withFormat: true })
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.history)
    expect(env.prompts.show).not.toHaveBeenCalledWith(EXCHANGE_DIALOGS.history, expect.anything(), expect.anything())
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Nothing has been imported')
    }))
  })

  it('marks an already-undone import as blocked, so the dialog cannot offer it again', async () => {
    const env = await setup({ withFormat: true })
    await importAndAccept(env)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.undo)

    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.history)
    const input = env.prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.history)![1] as {
      entries: { blocked?: string }[]
    }
    expect(input.entries[0].blocked).toBe('Already undone')
  })

  it('asks before discarding an edit made since the import, and does nothing if refused', async () => {
    const env = await setup({ withFormat: true })
    await importAndAccept(env)
    const [first] = (await env.accounts.transactions(env.chq.id).register()).rows
    await env.accounts.transactions(env.chq.id).update(first.transaction.id, { memo: 'MY OWN EDIT' })

    env.answers.push(false)  // the user declines the confirmation
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.undo)

    expect(env.prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
    expect((await env.accounts.transactions(env.chq.id).register()).rows).toHaveLength(2)
  })

  it('goes ahead once the user confirms', async () => {
    const env = await setup({ withFormat: true })
    await importAndAccept(env)
    const [first] = (await env.accounts.transactions(env.chq.id).register()).rows
    await env.accounts.transactions(env.chq.id).update(first.transaction.id, { memo: 'MY OWN EDIT' })

    env.answers.push(true)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.undo)
    expect((await env.accounts.transactions(env.chq.id).register()).rows).toEqual([])
  })
})

describe('Rename Payee, end to end', () => {
  /** Files a statement of one noisy row and returns the register overlay's key for it. */
  const noisyRow = async (env: Awaited<ReturnType<typeof setup>>, payee = 'SQ *THE DAILY GRIND 4471 OTTAWA ON') => {
    env.format.next(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee })] })]
    }))
    env.files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.import)
    const rows: OverlayRow[] = await env.ask(EXCHANGE_CHANNELS.pendingRows, { accountId: env.chq.id })
    return rows[0]
  }

  it('renames the row through the overlay action the register offers', async () => {
    const env = await setup({ withFormat: true })
    const overlay = await noisyRow(env)
    expect(overlay.actions.map(a => a.label)).toContain('Edit…')

    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.rename ? { payee: 'The Daily Grind', categoryId: null, always: false } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rename, { accountId: env.chq.id, key: overlay.key })

    const after: OverlayRow[] = await env.ask(EXCHANGE_CHANNELS.pendingRows, { accountId: env.chq.id })
    expect(after[0].payee).toBe('The Daily Grind')
    // No rule was written, because the user did not ask for one.
    expect(await env.exchange.payeeRules.list()).toEqual([])
  })

  it('writes a learned rule when the user asks for one, matching the merchant without the store number', async () => {
    const env = await setup({ withFormat: true })
    const overlay = await noisyRow(env)

    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.rename ? { payee: 'The Daily Grind', categoryId: null, always: true } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rename, { accountId: env.chq.id, key: overlay.key })

    const [rule] = await env.exchange.payeeRules.list()
    expect(rule).toMatchObject({
      payee: 'The Daily Grind',
      learned: true,
      enabled: true,
      match: { kind: 'startsWith', value: 'SQ *THE DAILY GRIND', ignoreCase: true }
    })
  })

  it('the learned rule renames next month’s row, with its different store number, without asking', async () => {
    const env = await setup({ withFormat: true })
    const overlay = await noisyRow(env)
    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.rename ? { payee: 'The Daily Grind', categoryId: null, always: true } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rename, { accountId: env.chq.id, key: overlay.key })
    await env.exchange.accept(env.chq.id, ...splitKey(overlay.key))

    // Next month: the same merchant, a different terminal.
    env.format.next(document({
      statements: [statement({
        transactions: [row({ date: '2026-12-03', amount: -475, payee: 'SQ *THE DAILY GRIND 4472 OTTAWA ON', externalId: 'FIT-NEXT' })]
      })]
    }))
    // The same file path: this harness's disk holds only the one, and the first statement has been read
    // through, so re-reading those bytes is not a duplicate of anything still waiting.
    env.files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.import)

    const next: OverlayRow[] = await env.ask(EXCHANGE_CHANNELS.pendingRows, { accountId: env.chq.id })
    expect(next).toHaveLength(1)
    expect(next[0].payee).toBe('The Daily Grind')
  })

  it('does nothing when the user cancels the dialog', async () => {
    const env = await setup({ withFormat: true })
    const overlay = await noisyRow(env)
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rename, { accountId: env.chq.id, key: overlay.key })

    const after: OverlayRow[] = await env.ask(EXCHANGE_CHANNELS.pendingRows, { accountId: env.chq.id })
    expect(after[0].payee).toBe('SQ *THE DAILY GRIND 4471 OTTAWA ON')
    expect(await env.exchange.payeeRules.list()).toEqual([])
  })

  it('answers the preview channel the dialog asks as the user types', async () => {
    const env = await setup({ withFormat: true })
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -450, payee: 'The Daily Grind'
    })
    const overlay = await noisyRow(env)
    const [statementId, rowKey] = splitKey(overlay.key)

    const reply = await env.ask(EXCHANGE_CHANNELS.renamePreview, {
      accountId: env.chq.id, statementId, rowKey, payee: 'The Daily Grind'
    })
    expect(reply).toMatchObject({ ok: true, value: { disposition: 'merge', matchedId: typed.id } })
  })
})

/** An overlay key back into the statement id and row key it was made from. */
const splitKey = (key: string): [string, string] => {
  const at = key.indexOf(':')
  return [key.slice(0, at), key.slice(at + 1)]
}

describe('File ▸ Payee Rules…', () => {
  it('opens with the book’s rules, its categories and its accounts', async () => {
    const env = await setup({ withFormat: true })
    await env.exchange.payeeRules.add([{
      order: 0, match: { kind: 'contains', value: 'AMZN', ignoreCase: true }, payee: 'Amazon', enabled: true
    }])

    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rules)

    const input = env.prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.rules)![1] as {
      rules: { payee: string }[], accounts: { name: string }[]
    }
    expect(input.rules.map(r => r.payee)).toEqual(['Amazon'])
    expect(input.accounts.map(a => a.name)).toContain('Chequing')
  })

  it('replaces the whole list in the order the dialog returned', async () => {
    const env = await setup({ withFormat: true })
    env.prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.rules
      ? {
        rules: [
          { order: 0, match: { kind: 'contains', value: 'SQ *', ignoreCase: true }, payee: 'Square', enabled: true },
          { order: 1, match: { kind: 'contains', value: 'AMZN', ignoreCase: true }, payee: 'Amazon', enabled: true }
        ]
      }
      : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rules)

    const saved = await env.exchange.payeeRules.list()
    expect(saved.map(r => [r.payee, r.order])).toEqual([['Square', 0], ['Amazon', 1]])
  })

  it('leaves the rules alone when the dialog is cancelled', async () => {
    const env = await setup({ withFormat: true })
    await env.exchange.payeeRules.add([{
      order: 0, match: { kind: 'contains', value: 'AMZN', ignoreCase: true }, payee: 'Amazon', enabled: true
    }])
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.rules)
    expect((await env.exchange.payeeRules.list()).map(r => r.payee)).toEqual(['Amazon'])
  })
})

describe('the bank’s own identifiers, import to export', () => {
  it('writes an account’s routing number back out as BANKID', async () => {
    const env = await setup({ withOfx: true })
    const account = await env.accounts.createAccount({
      name: 'With Routing', type: 'chequing', subBookId: null, currency: 'CAD',
      openingDate: '2026-01-01', openingBalance: 0,
      accountNumber: '5550001111', routingNumber: '001002003'
    })
    await env.accounts.transactions(account.id).create({ date: '2026-11-03', amount: -450, payee: 'A' })

    env.prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? { scope: { kind: 'account', accountId: account.id }, formatId: OFX_FORMATS.ofx }
      : undefined)
    env.files.showSaveDialog.mockResolvedValueOnce('/out/routing.ofx')
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const written = new TextDecoder().decode(env.disk.written.get('/out/routing.ofx')!)
    expect(written).toContain('<BANKID>001002003</BANKID>')
    expect(written).toContain('<ACCTID>5550001111</ACCTID>')
  })

  it('writes no BANKID for an account the user typed in, which has no routing number', async () => {
    const env = await setup({ withOfx: true })
    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-03', amount: -450, payee: 'A' })

    env.prompts.show.mockImplementation(async (id: string) => id === EXCHANGE_DIALOGS.export
      ? { scope: { kind: 'account', accountId: env.chq.id }, formatId: OFX_FORMATS.ofx }
      : undefined)
    env.files.showSaveDialog.mockResolvedValueOnce('/out/plain.ofx')
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.export)

    const written = new TextDecoder().decode(env.disk.written.get('/out/plain.ofx')!)
    expect(written).not.toContain('<BANKID>')
    // The account number it does have is still written.
    expect(written).toContain('<ACCTID>1234567890</ACCTID>')
  })
})

describe('the options page', () => {
  it('is contributed, naming a module the plugin exposes', async () => {
    const { runtime } = await setup()
    const pages = runtime.extensions.getContributions(OPTIONS_EXTENSION_POINT)
      .filter(c => c.contributor === EXCHANGE_PLUGIN_ID)
    expect(pages).toHaveLength(1)
    expect(pages[0].impl).toMatchObject({
      id: 'exchange.options.importExport', title: 'Import and export', module: './OptionsPage'
    })
  })

  it('registers its namespace, starting at the defaults', async () => {
    const { runtime } = await setup()
    const options = runtime.options as OptionsService
    expect(options.has(EXCHANGE_PLUGIN_ID)).toBe(true)
    expect(options.get<ExchangeOptions>(EXCHANGE_PLUGIN_ID)).toEqual(EXCHANGE_OPTIONS_DEFAULTS)
  })

  it('refuses a setting outside its range, through the same check the page uses', async () => {
    const { runtime } = await setup()
    const options = runtime.options as OptionsService
    const bad = { ...EXCHANGE_OPTIONS_DEFAULTS, import: { ...EXCHANGE_OPTIONS_DEFAULTS.import, dateWindow: 99 } }
    expect(options.commit(EXCHANGE_PLUGIN_ID, bad)).toEqual([expect.stringContaining('0 to 60')])
  })

  it('feeds what the user settled into the pipeline, not only the defaults', async () => {
    const env = await setup({ withFormat: true })
    const options = env.runtime.options as OptionsService
    expect(options.commit(EXCHANGE_PLUGIN_ID, {
      ...EXCHANGE_OPTIONS_DEFAULTS,
      import: { ...EXCHANGE_OPTIONS_DEFAULTS.import, maxRows: 1 }
    })).toEqual([])

    // A two-row file is now beyond the limit the user set, and the import says so rather than proceeding.
    env.format.next(document({ statements: [statement({ transactions: [row(), row({ externalId: 'FIT-2' })] })] }))
    env.files.showOpenDialog.mockResolvedValueOnce('/in/statement.fake')
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.import)

    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('limit of 1')
    }))
  })
})

describe('File ▸ Statement Sources…', () => {
  /** Imports the fake statement into chequing, remembering the source, so the book has one link. */
  const linkedSource = async (env: Awaited<ReturnType<typeof setup>>) => {
    await env.exchange.file(statement({ transactions: [row()] }), env.chq.id, {
      source: { fileName: 'statement.fake', fileHash: 'h1', formatId: env.format.contribution.id },
      remember: true
    })
    return (await env.exchange.links())[0]
  }

  it('says so rather than opening an empty dialog when no source is linked', async () => {
    const env = await setup({ withFormat: true })
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.sources)
    expect(env.prompts.show).not.toHaveBeenCalledWith(EXCHANGE_DIALOGS.sources, expect.anything(), expect.anything())
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('No statement sources')
    }))
  })

  it('opens with each source, its account, its format and the option’s window', async () => {
    const env = await setup({ withFormat: true })
    const link = await linkedSource(env)
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.sources)

    const input = env.prompts.show.mock.calls.find(call => call[0] === EXCHANGE_DIALOGS.sources)![1] as {
      sources: { id: string, accountName: string, formatLabel: string }[], defaultWindow: number, maxWindow: number
    }
    expect(input.sources).toEqual([expect.objectContaining({
      id: link.id, accountName: 'Chequing', formatLabel: 'Fake statement'
    })])
    expect(input).toMatchObject({ defaultWindow: 3, maxWindow: 60 })
  })

  it('saves a window the dialog set, and forgets a source it removed', async () => {
    const env = await setup({ withFormat: true })
    const link = await linkedSource(env)

    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.sources ? { windows: [{ id: link.id, dateWindow: 7 }], removed: [] } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.sources)
    expect((await env.exchange.links())[0].dateWindow).toBe(7)

    env.prompts.show.mockImplementation(async (id: string) =>
      id === EXCHANGE_DIALOGS.sources ? { windows: [], removed: [link.id] } : undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.sources)
    expect(await env.exchange.links()).toEqual([])
  })

  it('leaves everything alone when the dialog is cancelled', async () => {
    const env = await setup({ withFormat: true })
    await linkedSource(env)
    env.prompts.show.mockResolvedValue(undefined)
    await env.runtime.commands.execute(EXCHANGE_COMMANDS.sources)
    const [link] = await env.exchange.links()
    expect(link.dateWindow).toBeUndefined()
  })
})

describe('a book opened read-only', () => {
  it('disables Import History and every statement-row command, which can only write', async () => {
    const env = await setup({ withFormat: true })
    for (const command of [EXCHANGE_COMMANDS.history, EXCHANGE_COMMANDS.accept, EXCHANGE_COMMANDS.change,
      EXCHANGE_COMMANDS.rename, EXCHANGE_COMMANDS.skip]) {
      expect(env.runtime.commands.isEnabled(command), command).toBe(true)
    }
    env.runtime.contextKeys.set(BOOK_CONTEXT_KEYS.isReadOnly, true)
    for (const command of [EXCHANGE_COMMANDS.history, EXCHANGE_COMMANDS.accept, EXCHANGE_COMMANDS.change,
      EXCHANGE_COMMANDS.rename, EXCHANGE_COMMANDS.skip]) {
      expect(env.runtime.commands.isEnabled(command), command).toBe(false)
    }
  })
})

describe('exporting several accounts as CSV', () => {
  it('is refused before anything is written, with QIF named as the format for it', async () => {
    const env = await setup({ withCsv: true })
    await env.accounts.createAccount(chequing({ name: 'Savings', accountNumber: '999' }))
    await expect(env.exchange.export({ scope: { kind: 'book' }, formatId: CSV_FORMAT, path: '/out/all.csv' }))
      .rejects.toMatchObject({ code: 'NOT_WRITABLE' })
    expect(env.disk.written.size).toBe(0)
  })
})
