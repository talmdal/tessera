// @vitest-environment node
// The register's side of the accounts plugin, activated with the ledger as the app runs them.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS } from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS as C, ACCOUNTS_CONTEXT_KEYS as K, ACCOUNTS_DIALOGS, ACCOUNTS_EVENTS, ACCOUNTS_SERVICE,
  ACCOUNTS_VIEWS, RECONCILE_ACTIONS_POINT, STATEMENT_RECONCILER, type AccountsService
} from '@tessera/accounts-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
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

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(LEDGER_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const chq = await accounts.createAccount(chequing())
  const sav = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))

  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const key = (k: string) => runtime.contextKeys.get(k)
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const named = (name: string) => events.filter(e => e.name === name).map(e => e.data)
  return { runtime, log, prompts, answers, reveals, events, accounts, chq, sav, ask, run, key, settle, named }
}

describe('opening a register', () => {
  it('shows the selected account\'s register, with keys that enable New Transaction', async () => {
    const { ask, run, key, reveals, chq, named, runtime } = await setup()
    expect(runtime.commands.isEnabled(C.showRegister)).toBe(false)      // nothing selected
    expect(runtime.commands.isEnabled(C.newTransaction)).toBe(false)

    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: chq.id })
    expect(await run(C.showRegister)).toBe(true)

    expect(reveals).toContain(ACCOUNTS_VIEWS.register)
    expect(await ask(ACCOUNTS_CHANNELS.registerAccount)).toEqual({ accountId: chq.id })
    expect(named(ACCOUNTS_EVENTS.register).at(-1)).toEqual({ accountId: chq.id })
    expect([key(K.registerAccount), key(K.registerEditable)]).toEqual([chq.id, true])
    expect(runtime.commands.isEnabled(C.newTransaction)).toBe(true)
  })

  it('makes the register read-only when its account closes, and empty when it is deleted', async () => {
    const { ask, run, key, chq, accounts, settle, named } = await setup()
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: chq.id })
    await run(C.showRegister)
    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    await settle()
    expect(key(K.registerEditable)).toBe(false)

    await accounts.deleteAccount(chq.id)
    await settle()
    expect(key(K.registerAccount)).toBeUndefined()
    expect(named(ACCOUNTS_EVENTS.register).at(-1)).toEqual({ accountId: null })
    expect(await ask(ACCOUNTS_CHANNELS.loadRegister, { accountId: chq.id })).toBeNull()
  })

  it('New Transaction brings the register forward and tells it to start an entry', async () => {
    const { ask, run, chq, named, reveals } = await setup()
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: chq.id })
    await run(C.showRegister)
    reveals.length = 0
    await run(C.newTransaction)
    expect(reveals).toEqual([ACCOUNTS_VIEWS.register])
    expect(named(ACCOUNTS_EVENTS.newTransaction)).toEqual([{}])
  })
})

describe('the register\'s requests', () => {
  it('saves new transactions, and edits whole rows, clearing what the row left out', async () => {
    const { ask, chq, settle, named } = await setup()
    const created = await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: -5000, payee: 'Metro', memo: 'x' } })
    expect(created).toMatchObject({ ok: true, value: { amount: -5000, memo: 'x' } })
    await settle()
    expect(named(ACCOUNTS_EVENTS.transactions).at(-1)).toEqual({ accounts: [chq.id] })

    const edited = await ask(ACCOUNTS_CHANNELS.saveTransaction, {
      accountId: chq.id, id: created.value.id, expectedRev: created.value.rev, draft: { date: '2026-10-02', amount: -6000 }
    })
    expect(edited.value).toMatchObject({ amount: -6000 })
    expect(edited.value).not.toHaveProperty('memo')
    expect(edited.value).not.toHaveProperty('payeeId')

    const snapshot = await ask(ACCOUNTS_CHANNELS.loadRegister, { accountId: chq.id })
    expect(snapshot.rows.map((r: any) => r.balance)).toEqual([94000])
  })

  it('answers problems as results on their fields', async () => {
    const { ask, chq } = await setup()
    expect(await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: 'nope', amount: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID', field: 'date' } })
    expect(await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: 1, categoryId: 'gone' } }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND', field: 'category' } })
  })

  it('asks for, then accepts, confirmation for a reconciled transaction', async () => {
    const { ask, chq } = await setup()
    const { value: a } = await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: -5000 } })
    expect(await ask(ACCOUNTS_CHANNELS.setStatus, { accountId: chq.id, ids: [a.id], status: 'reconciled' }))
      .toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', reasons: ['reconciled'] } })
    expect(await ask(ACCOUNTS_CHANNELS.setStatus, { accountId: chq.id, ids: [a.id], status: 'reconciled', confirm: ['reconciled'] })).toEqual({ ok: true })
    expect(await ask(ACCOUNTS_CHANNELS.deleteTransactions, { accountId: chq.id, ids: [a.id] }))
      .toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } })
    expect(await ask(ACCOUNTS_CHANNELS.deleteTransactions, { accountId: chq.id, ids: [a.id], confirm: ['reconciled'] })).toEqual({ ok: true })
  })

  it('voids, searches payees, lists and creates categories', async () => {
    const { ask, chq, sav, settle, named } = await setup()
    const { value: a } = await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: -5000, payee: 'Me', transferAccountId: sav.id } })
    expect(await ask(ACCOUNTS_CHANNELS.setVoided, { accountId: chq.id, ids: [a.id], voided: true })).toEqual({ ok: true })
    await settle()
    expect(named(ACCOUNTS_EVENTS.transactions).at(-1).accounts.sort()).toEqual([chq.id, sav.id].sort())
    expect((await ask(ACCOUNTS_CHANNELS.searchPayees, { prefix: 'm' })).map((p: any) => p.name)).toEqual(['Me'])

    const before = (await ask(ACCOUNTS_CHANNELS.categories)).length
    expect(await ask(ACCOUNTS_CHANNELS.createCategory, { path: 'Pets : Vet', kind: 'expense' })).toMatchObject({ ok: true, value: { name: 'Vet' } })
    await settle()
    expect(named(ACCOUNTS_EVENTS.categories).at(-1)).toHaveLength(before + 2)
  })
})

describe('deleting an account from the menu', () => {
  it('says how many transactions go with it', async () => {
    const { ask, run, chq, prompts, answers } = await setup()
    await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: -5000 } })
    await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-03', amount: -5000 } })
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: chq.id })
    answers.push(false)
    await run(C.deleteAccount)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      detail: expect.stringContaining('Its 2 transactions will be deleted with it; transfers stay in the other accounts.')
    }))
  })
})

describe('reconciling with a statement', () => {
  /** The register shows Chequing, with Metro (−50.25) and Hydro (−80.00). */
  async function reconciling() {
    const env = await setup()
    const { ask, run, chq } = env
    const { value: metro } = await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-02', amount: -5025, payee: 'Metro' } })
    const { value: hydro } = await ask(ACCOUNTS_CHANNELS.saveTransaction, { accountId: chq.id, draft: { date: '2026-10-05', amount: -8000, payee: 'Hydro' } })
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: chq.id })
    await run(C.showRegister)
    return { ...env, metro, hydro }
  }

  it('asks for the statement\'s figures, prefilled from the last reconciliation, then reconciles in the register', async () => {
    const { run, prompts, chq, key, reveals, settle, named } = await reconciling()
    expect(key(K.reconciling)).toBeUndefined()
    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86975 })
    expect(await run(C.reconcileStatement)).toBe(true)

    expect(prompts.show).toHaveBeenLastCalledWith(ACCOUNTS_DIALOGS.reconcile, {
      account: expect.objectContaining({ id: chq.id }), lastReconciled: { balance: 100000 },
      categories: expect.arrayContaining([expect.objectContaining({ name: 'Bank fees' })]),
      defaultCategories: { serviceCharge: expect.any(String), interest: expect.any(String) }
    }, {})
    expect([key(K.reconciling), key(K.reconciler)]).toEqual([chq.id, STATEMENT_RECONCILER])
    expect(reveals.slice(-2)).toEqual([ACCOUNTS_VIEWS.register, ACCOUNTS_VIEWS.reconcile])
    await settle()
    expect(named(ACCOUNTS_EVENTS.reconcile).at(-1)).toMatchObject({ accountId: chq.id, state: { summary: { difference: -13025 } } })
  })

  it('adds the statement\'s service charge and interest, marked, in their categories', async () => {
    const { run, prompts, chq, accounts, ask } = await reconciling()
    // The dialog is offered the usual categories (cancelled here)
    await run(C.reconcileStatement)
    const { defaultCategories } = prompts.show.mock.lastCall![1] as { defaultCategories: { serviceCharge: string, interest: string } }
    const categories = await accounts.categories.list()
    const label = (id?: string) => categories.find(c => c.id === id)?.name
    expect([label(defaultCategories.serviceCharge), label(defaultCategories.interest)]).toEqual(['Bank fees', 'Interest'])

    prompts.show.mockResolvedValueOnce({
      statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86500,
      serviceCharge: { amount: 495, date: '2026-10-31', categoryId: defaultCategories.serviceCharge },
      interest: { amount: 20, date: '2026-10-31', categoryId: defaultCategories.interest }
    })
    await run(C.reconcileStatement)
    const state = await ask(ACCOUNTS_CHANNELS.reconcileState, { accountId: chq.id })
    const added = state.candidates.filter((c: any) => state.reconciliation.addedIds.includes(c.transaction.id))
    expect(added.map((c: any) => [c.payeeName, c.transaction.amount, c.marked, c.categoryLabel])).toEqual([
      ['Service charge', -495, true, 'Bank fees'], ['Interest', 20, true, 'Interest']
    ])
  })

  it('uses Interest paid for a liability\'s interest', async () => {
    const { run, prompts, ask, accounts } = await reconciling()
    const card = await accounts.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: -54000 }))
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: card.id })
    await run(C.showRegister)
    await run(C.reconcileStatement)
    const { defaultCategories } = prompts.show.mock.lastCall![1] as { defaultCategories: { interest: string } }
    expect((await accounts.categories.list()).find(c => c.id === defaultCategories.interest)?.name).toBe('Interest paid')
  })

  it('does nothing when the dialog is cancelled', async () => {
    const { run, key } = await reconciling()
    expect(await run(C.reconcileStatement)).toBe(false)
    expect(key(K.reconciling)).toBeUndefined()
  })

  it('marks, corrects, completes with an adjustment once confirmed, and ends', async () => {
    const { run, ask, prompts, chq, metro, hydro, key, settle, named, accounts } = await reconciling()
    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86760 })
    await run(C.reconcileStatement)

    const marked = await ask(ACCOUNTS_CHANNELS.reconcileMark, { accountId: chq.id, ids: [metro.id, hydro.id], marked: true })
    expect(marked).toMatchObject({ ok: true, value: { summary: { markedCount: 2, difference: -215 } } })
    // The statement says Hydro was 82.15: corrected in place, and only the amount changes
    expect(await ask(ACCOUNTS_CHANNELS.patchTransaction, { accountId: chq.id, id: hydro.id, patch: { amount: -8215 }, expectedRev: hydro.rev + 1 }))
      .toMatchObject({ ok: true, value: { amount: -8215, status: 'cleared' } })
    await settle()
    // An edited transaction changes the reconciliation: the panel hears of it
    expect(named(ACCOUNTS_EVENTS.reconcile).at(-1)).toMatchObject({ accountId: chq.id, state: { summary: { difference: 0 } } })

    expect(await ask(ACCOUNTS_CHANNELS.reconcileFinish, { accountId: chq.id })).toMatchObject({ ok: true, value: { reconciledCount: 2 } })
    await settle()
    expect(key(K.reconciling)).toBeUndefined()
    expect(named(ACCOUNTS_EVENTS.reconcile).at(-1)).toEqual({ accountId: chq.id, state: null })
    expect((await accounts.get(chq.id))!.lastReconciled).toMatchObject({ date: '2026-10-31', balance: 86760 })
  })

  it('answers a difference with a confirmation to ask for, then adds the adjustment', async () => {
    const { run, ask, prompts, chq } = await reconciling()
    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 50000 })
    await run(C.reconcileStatement)
    expect(await ask(ACCOUNTS_CHANNELS.reconcileFinish, { accountId: chq.id }))
      .toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', reasons: ['adjustBalance'] } })
    expect(await ask(ACCOUNTS_CHANNELS.reconcileFinish, { accountId: chq.id, confirm: ['adjustBalance'] }))
      .toMatchObject({ ok: true, value: { reconciledCount: 0, adjustment: { amount: -50000 } } })
  })

  it('pauses (the register shows a note) and resumes with the figures already entered', async () => {
    const { run, ask, prompts, chq, metro, key, settle } = await reconciling()
    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 94975 })
    await run(C.reconcileStatement)
    await ask(ACCOUNTS_CHANNELS.reconcileMark, { accountId: chq.id, ids: [metro.id], marked: true })
    expect(await ask(ACCOUNTS_CHANNELS.reconcilePause, { accountId: chq.id })).toEqual({ ok: true })
    await settle()
    expect(key(K.reconciling)).toBeUndefined()
    expect(await ask(ACCOUNTS_CHANNELS.reconcileState, { accountId: chq.id })).toMatchObject({ reconciliation: { paused: true } })

    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 94975 })
    await run(C.reconcileStatement)
    expect(prompts.show).toHaveBeenLastCalledWith(ACCOUNTS_DIALOGS.reconcile, expect.objectContaining({
      current: expect.objectContaining({ statementBalance: 94975, paused: true })
    }), { title: 'Resume Reconciliation' })
    expect(key(K.reconciling)).toBe(chq.id)
  })

  it('cancels, putting the marks back', async () => {
    const { run, ask, prompts, chq, metro, accounts, key, settle } = await reconciling()
    prompts.show.mockResolvedValueOnce({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 0 })
    await run(C.reconcileStatement)
    await ask(ACCOUNTS_CHANNELS.reconcileMark, { accountId: chq.id, ids: [metro.id], marked: true })
    expect(await ask(ACCOUNTS_CHANNELS.reconcileCancel, { accountId: chq.id })).toEqual({ ok: true })
    await settle()
    expect((await accounts.transactions(chq.id).get(metro.id))!.status).toBe('uncleared')
    expect(key(K.reconciling)).toBeUndefined()
    expect(await ask(ACCOUNTS_CHANNELS.reconcileState, { accountId: chq.id })).toBeNull()
  })

  it('answers requests without a reconciliation under way as results', async () => {
    const { ask, chq, metro } = await reconciling()
    expect(await ask(ACCOUNTS_CHANNELS.reconcileMark, { accountId: chq.id, ids: [metro.id], marked: true }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await ask(ACCOUNTS_CHANNELS.reconcileMark, { accountId: chq.id, ids: 'x' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID', field: 'ids' } })
    expect(await ask(ACCOUNTS_CHANNELS.patchTransaction, { accountId: chq.id, id: metro.id }))
      .toMatchObject({ ok: false, error: { code: 'INVALID' } })
  })

  it('won\'t reconcile a closed account', async () => {
    const { run, ask, prompts, chq, sav, accounts, settle } = await reconciling()
    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    await settle()
    // Its register is read-only, so the command is disabled…
    await expect(run(C.reconcileStatement)).rejects.toThrow(/disabled/)
    // …and named from another register, it says why
    await ask(ACCOUNTS_CHANNELS.select, { kind: 'account', id: sav.id })
    await run(C.showRegister)
    expect(await run(C.reconcileStatement, { accountId: chq.id })).toBe(false)
    expect(prompts.message).toHaveBeenLastCalledWith(expect.objectContaining({ detail: 'Reopen it to reconcile it.' }))
    expect(prompts.show).not.toHaveBeenCalledWith(ACCOUNTS_DIALOGS.reconcile, expect.anything(), expect.anything())
  })

  it('offers the statement reconciler, and other plugins\' options, through accounts.reconcile.actions', async () => {
    const { ask, chq, runtime, log } = await reconciling()
    const other = createPluginContext('bank', runtime).context
    other.commands.register('bank.match', () => undefined, { enablement: 'bank.ready' })
    other.extensions.contribute('bank', RECONCILE_ACTIONS_POINT, 'bank.match', {
      id: 'bank.match', label: 'Match Downloaded…', scope: 'account', command: 'bank.match', accountTypes: ['chequing'], order: 5
    })
    other.extensions.contribute('bank', RECONCILE_ACTIONS_POINT, 'bank.cards', {
      id: 'bank.cards', label: 'Cards Only', scope: 'account', command: 'bank.match', accountTypes: ['creditCard']
    })
    other.extensions.contribute('bank', RECONCILE_ACTIONS_POINT, 'bank.row', {
      id: 'bank.row', label: 'Find on Statement', scope: 'transaction', command: 'bank.find'
    })
    // Someone else's name, and no label: skipped, with a warning
    other.extensions.contribute('bank', RECONCILE_ACTIONS_POINT, 'bank.bad', { id: 'accounts.sneaky', label: 'x', scope: 'account', command: 'x' })
    other.extensions.contribute('bank', RECONCILE_ACTIONS_POINT, 'bank.bad2', { id: 'bank.bad2', scope: 'account', command: 'x' })

    expect(await ask(ACCOUNTS_CHANNELS.reconcileActions, { accountId: chq.id, scope: 'account' })).toEqual([
      { id: STATEMENT_RECONCILER, label: 'Reconcile with Statement…', scope: 'account', command: C.reconcileStatement, icon: 'Check', enabled: true,
        description: expect.any(String) },
      { id: 'bank.match', label: 'Match Downloaded…', scope: 'account', command: 'bank.match', enabled: false }
    ])
    runtime.contextKeys.set('bank.ready', true)
    expect((await ask(ACCOUNTS_CHANNELS.reconcileActions, { accountId: chq.id, scope: 'account' }))[1].enabled).toBe(true)
    // A command that doesn't exist is never enabled
    expect(await ask(ACCOUNTS_CHANNELS.reconcileActions, { accountId: chq.id, scope: 'transaction' }))
      .toEqual([{ id: 'bank.row', label: 'Find on Statement', scope: 'transaction', command: 'bank.find', enabled: false }])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('needs an id starting with "bank."'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"bank.bad2" needs a label'))
    expect(await ask(ACCOUNTS_CHANNELS.reconcileActions, { accountId: 'gone', scope: 'account' })).toEqual([])
  })
})
