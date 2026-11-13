// @vitest-environment node
// Make Recurring…: the one place the recurring plugin reaches into the register, through the row-action point the
// accounts plugin offers. All three plugins activated together, as the app runs them.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_COMMANDS } from '@tessera/book-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_SERVICE, type AccountsService, type ResolvedTransactionAction
} from '@tessera/accounts-api'
import {
  RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_DIALOGS, RECURRING_SERVICE, RECURRING_VIEWS,
  type RecurringService, type SeriesDialogInput, type SeriesInput
} from '@tessera/recurring-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBook } from '../../../plugins/book/src/privileged/index'
import { activate as activateRecurring } from '../../../plugins/recurring/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../book/harness'
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

  await activateBook(createPluginContext('book', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  await activateRecurring(createPluginContext('recurring', runtime).context)

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(BOOK_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const recurring = runtime.services.get<RecurringService>(RECURRING_SERVICE)
  const chq = await accounts.createAccount(chequing())
  const savings = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))

  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)

  /** What the series dialog was opened with, if it was. */
  const dialogInput = (): SeriesDialogInput | undefined =>
    prompts.show.mock.calls.filter(call => call[0] === RECURRING_DIALOGS.series).at(-1)?.[1] as SeriesDialogInput | undefined

  return { runtime, log, prompts, answers, reveals, accounts, recurring, chq, savings, ask, run, dialogInput }
}

describe('the action in a register row', () => {
  it('is offered for one row, through accounts.transaction.actions', async () => {
    const { ask, chq } = await setup()
    const actions: ResolvedTransactionAction[] = await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 })
    expect(actions).toEqual([{
      id: 'recurring.fromTransaction', label: 'Make Recurring…', command: C.fromTransaction,
      icon: 'Repeat', description: expect.any(String), enabled: true
    }])
  })

  it('is not offered for several rows at once, nor while the account is closed', async () => {
    const { ask, accounts, chq } = await setup()
    expect(await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 2 })).toEqual([])

    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect(await ask(ACCOUNTS_CHANNELS.transactionActions, { accountId: chq.id, count: 1 })).toEqual([])
  })
})

describe('running it', () => {
  it('opens the series dialog prefilled from the transaction, and guesses a monthly schedule', async () => {
    const { run, accounts, chq, dialogInput, prompts } = await setup()
    const rent = await accounts.categories.create('Housing : Rent', 'expense')
    const paid = await accounts.transactions(chq.id).create({
      date: '2026-11-01', amount: -120000, payee: 'Landlord', categoryId: rent.id, memo: 'November', number: '0417'
    })

    await run(C.fromTransaction, { accountId: chq.id, transactionIds: [paid.id] })

    const input = dialogInput()!
    expect(input.mode).toBe('fromTransaction')
    expect(input).toMatchObject({ accountId: chq.id, transactionId: paid.id, sourceDate: '2026-11-01' })
    expect(input.mode === 'fromTransaction' && input.template)
      .toMatchObject({ amount: -120000, payee: 'Landlord', categoryId: rent.id, memo: 'November' })
    // A cheque number does not repeat
    expect(input.mode === 'fromTransaction' && input.template.number).toBeUndefined()
    // Anchored on the transaction's own date, the same day each month
    expect(input.mode === 'fromTransaction' && input.schedule).toEqual({ frequency: 'monthly', interval: 1, startDate: '2026-11-01' })
    // It is the same dialog New… opens, so it carries everything that dialog needs
    expect(input.chart.accounts).toHaveLength(2)
    expect(prompts.show).toHaveBeenLastCalledWith(RECURRING_DIALOGS.series, expect.anything(), { title: 'Make Recurring' })
  })

  it('creates the series the dialog confirmed, and shows the list', async () => {
    const { run, ask, accounts, recurring, chq, reveals, prompts } = await setup()
    const paid = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -120000, payee: 'Landlord' })

    // The dialog saves through the plugin and resolves with the new id, as AccountDialog does
    prompts.show.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[1] as SeriesDialogInput
      const series: SeriesInput = {
        accountId: chq.id,
        template: input.mode === 'fromTransaction' ? input.template : { amount: 0, autoNumber: false, estimated: false },
        schedule: input.mode === 'fromTransaction' ? input.schedule : { frequency: 'monthly', interval: 1, startDate: '2026-11-01' }
      }
      const saved = await ask(RECURRING_CHANNELS.createFromTransaction, {
        input: series, source: { accountId: chq.id, transactionId: paid.id }
      })
      expect(saved.ok).toBe(true)
      return { id: saved.value.id }
    })

    const created = await run(C.fromTransaction, { accountId: chq.id, transactionIds: [paid.id] }) as { id: string }
    expect(created).toMatchObject({ id: expect.any(String) })
    expect(reveals).toContain(RECURRING_VIEWS.list)

    const series = (await recurring.get(created.id))!
    expect(series).toMatchObject({ name: 'Landlord', nextDate: '2026-12-01', lastEnteredDate: '2026-11-01' })
    // The register still holds exactly the one transaction it started with
    expect(await accounts.transactions(chq.id).list()).toHaveLength(1)
  })

  it('does nothing when the dialog is cancelled', async () => {
    const { run, accounts, recurring, chq, reveals } = await setup()
    const paid = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -1000 })

    expect(await run(C.fromTransaction, { accountId: chq.id, transactionIds: [paid.id] })).toBeUndefined()
    expect(await recurring.list()).toEqual([])
    expect(reveals).not.toContain(RECURRING_VIEWS.list)
  })

  it('says so when the transaction has gone, rather than opening an empty dialog', async () => {
    const { run, prompts, chq, dialogInput } = await setup()
    expect(await run(C.fromTransaction, { accountId: chq.id, transactionIds: ['nope'] })).toBeUndefined()
    expect(prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
    expect(dialogInput()).toBeUndefined()
  })

  it('ignores an argument that names nothing', async () => {
    const { run, dialogInput } = await setup()
    expect(await run(C.fromTransaction)).toBeUndefined()
    expect(await run(C.fromTransaction, { accountId: 'c', transactionIds: [] })).toBeUndefined()
    expect(dialogInput()).toBeUndefined()
  })
})

describe('what the plugin stores', () => {
  it('refuses a source that is not in the account it names', async () => {
    const { ask, accounts, chq, savings } = await setup()
    const elsewhere = await accounts.transactions(savings.id).create({ date: '2026-11-01', amount: -1000 })
    const input: SeriesInput = {
      accountId: chq.id,
      template: { amount: -1000, autoNumber: false, estimated: false, payee: 'Someone' },
      schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-01' }
    }
    const result = await ask(RECURRING_CHANNELS.createFromTransaction, {
      input, source: { accountId: chq.id, transactionId: elsewhere.id }
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('reports a bad request to the view rather than throwing at it', async () => {
    const { ask, chq } = await setup()
    expect(await ask(RECURRING_CHANNELS.createFromTransaction, { source: { accountId: chq.id, transactionId: 'x' } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID' } })
    expect(await ask(RECURRING_CHANNELS.createFromTransaction, { input: { accountId: chq.id } }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})
