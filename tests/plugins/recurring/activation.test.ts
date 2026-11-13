// @vitest-environment node
// The book, accounts and recurring plugins activated together, as the app runs them, and driven through commands
// and IPC — including the context keys the overdue warnings hang on.
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_CHANNELS, BOOK_COMMANDS } from '@tessera/book-api'
import { ACCOUNTS_CHANNELS, ACCOUNTS_MENU, ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import {
  RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_CONTEXT_KEYS as K, RECURRING_DIALOGS, RECURRING_EVENTS,
  RECURRING_SERVICE, RECURRING_VIEWS, type RecurringService, type RecurringSnapshot, type SeriesInput
} from '@tessera/recurring-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { normalizeMenuNodes } from '../../../shared/menus/normalize'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { parseWhen, evaluateWhen } from '../../../shared/context/when'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateBook } from '../../../plugins/book/src/privileged/index'
import { activate as activateRecurring, watchDateRollover } from '../../../plugins/recurring/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../book/harness'
import { chequing, monthly, template } from './harness'

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
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (id: unknown) => { reveals.push(String(id)) })
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  await activateBook(createPluginContext('book', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  await activateRecurring(createPluginContext('recurring', runtime).context)

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(BOOK_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const recurring = runtime.services.get<RecurringService>(RECURRING_SERVICE)
  const chq = await accounts.createAccount(chequing())

  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const key = (k: string) => runtime.contextKeys.get(k)
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const named = (name: string) => events.filter(e => e.name === name).map(e => e.data)
  const series = (over: Partial<SeriesInput> = {}): SeriesInput =>
    ({ accountId: chq.id, template: template(), schedule: monthly('2026-11-15'), ...over })

  return { runtime, log, prompts, reveals, events, accounts, recurring, chq, ask, run, key, settle, named, series }
}

describe('activating the recurring plugin', () => {
  it('provides the service, and offers only the contract', async () => {
    const { recurring } = await setup()
    expect(Object.keys(recurring).sort()).toEqual([
      'addHoliday', 'create', 'createFromTransaction', 'delete', 'enter', 'forecast', 'get', 'history', 'holidays',
      'list', 'onDidChange', 'removeHoliday', 'setPaused', 'skip', 'snapshot', 'templateFrom', 'update'
    ])
    expect((recurring as unknown as { handleAccountsChange?: unknown }).handleAccountsChange).toBeUndefined()
  })

  it('contributes the view, the menu items and the overdue warning, and opens the view', async () => {
    const { runtime, reveals, run } = await setup()
    const contributions = (point: string) => runtime.extensions.getContributions(point)
    const impls = (point: string) => contributions(point).map(c => c.impl)

    const views = resolveViews(contributions('shell.views'), id => `tessera-plugin://${id}/remoteEntry.js`)
    expect(views.diagnostics).toEqual([])
    expect(views.views.find(v => v.id === RECURRING_VIEWS.list)).toMatchObject({ slot: 'shell.main', title: 'Recurring' })
    expect(views.views.find(v => v.id === RECURRING_VIEWS.upcoming)).toMatchObject({ slot: 'shell.right', title: 'Upcoming' })

    // The shell owns the File and View menus; everything else here is contributed by the three plugins
    const menus = resolveMenus([
      { kind: 'menu', id: 'shell.file', label: '&File' },
      { kind: 'menu', id: 'shell.view', label: '&View' },
      ...impls('shell.menus')
    ])
    expect(menus.diagnostics).toEqual([])
    // Its item joins the Accounts menu, in a group of its own, so a separator divides it from the register's
    const accountsMenu = menus.menus.find(m => m.id === ACCOUNTS_MENU.id)!
    const labels = normalizeMenuNodes(accountsMenu.children).map(n => n.type === 'item' ? n.label : n.type)
    expect(labels.slice(-5)).toEqual([
      'separator', 'Recurring &Transactions', 'New &Recurring Transaction…', 'Enter &Due Transactions…', '&Holidays…'
    ])
    const viewMenu = menus.menus.find(m => m.id === 'shell.view')!
    expect(normalizeMenuNodes(viewMenu.children).map(n => n.type === 'item' ? n.label : n.type)).toContain('&Recurring')

    const bar = resolveBarItems(contributions('shell.bar.items'))
    expect(bar.diagnostics).toEqual([])
    expect(bar.items.find(i => i.id === 'recurring.status.overdue'))
      .toMatchObject({ slot: 'shell.bottom', kind: 'text', align: 'end', icon: 'Warning', command: C.open })

    await run(C.open)
    expect(reveals).toContain(RECURRING_VIEWS.list)
  })

  it('leaves the warnings off while nothing is overdue', async () => {
    const { key, ask } = await setup()
    expect(key(K.overdueCount)).toBeUndefined()
    expect(key(K.overdueSummary)).toBeUndefined()
    expect(key(K.hasSeries)).toBeUndefined()
    expect((await ask(RECURRING_CHANNELS.snapshot) as RecurringSnapshot).rows).toEqual([])
  })
})

describe('the context keys the warnings read', () => {
  it('counts what is overdue, and words it for the bar', async () => {
    const { recurring, key, series, settle } = await setup()
    await recurring.create(series({ name: 'Hydro', schedule: monthly('2026-09-01') }))
    await settle()

    expect(key(K.overdueCount)).toBe(1)
    expect(key(K.overdueSummary)).toBe('1 transaction overdue')
    expect(key(K.dueCount)).toBe(1)
    expect(key(K.hasSeries)).toBe(true)

    await recurring.create(series({ name: 'Rent', schedule: monthly('2026-10-01'), template: template({ payee: 'Landlord' }) }))
    await settle()
    expect(key(K.overdueSummary)).toBe('2 transactions overdue')
  })

  it('turns the bar item on exactly when something is overdue', async () => {
    const { runtime, recurring, series, settle } = await setup()
    const item = resolveBarItems(runtime.extensions.getContributions('shell.bar.items'))
      .items.find(i => i.id === 'recurring.status.overdue')!
    const shown = () => evaluateWhen(parseWhen(item.when!), k => runtime.contextKeys.get(k))

    expect(shown()).toBe(false)
    const overdue = await recurring.create(series({ schedule: monthly('2026-09-01') }))
    await settle()
    expect(shown()).toBe(true)

    // Dealt with, so the warning goes: a count of zero is falsy, and the key is cleared
    await recurring.skip([overdue.id], { count: 3 })
    await settle()
    expect(shown()).toBe(false)
    expect(runtime.contextKeys.get(K.overdueCount)).toBeUndefined()
  })

  it('clears them when the book closes', async () => {
    const { runtime, recurring, key, series, settle } = await setup()
    await recurring.create(series({ schedule: monthly('2026-09-01') }))
    await settle()
    expect(key(K.overdueCount)).toBe(1)

    await runtime.commands.execute(BOOK_COMMANDS.close)
    await settle()
    expect(key(K.overdueCount)).toBeUndefined()
    expect(key(K.hasSeries)).toBeUndefined()
  })
})

describe('the views talk to the plugin', () => {
  it('pushes the whole snapshot whenever anything changes', async () => {
    const { recurring, named, series, settle } = await setup()
    await recurring.create(series({ name: 'Hydro', schedule: monthly('2026-09-01') }))
    await settle()

    const pushed = named(RECURRING_EVENTS.snapshot).at(-1) as RecurringSnapshot
    expect(pushed.rows.map(r => r.series.name)).toEqual(['Hydro'])
    expect(pushed.summary.overdueCount).toBe(1)
  })

  it('creates, changes, enters, skips, pauses and deletes over IPC', async () => {
    const { ask, accounts, chq, series } = await setup()
    const created = await ask(RECURRING_CHANNELS.saveSeries, { input: series({ name: 'Hydro', schedule: monthly('2026-11-10') }) })
    expect(created.ok).toBe(true)
    const id = created.value.id

    const renamed = await ask(RECURRING_CHANNELS.saveSeries, { id, input: series({ name: 'Power', schedule: monthly('2026-11-10') }) })
    expect(renamed.value).toMatchObject({ name: 'Power', nextDate: '2026-11-10' })

    const entered = await ask(RECURRING_CHANNELS.enter, { requests: [{ seriesId: id }] })
    expect(entered.value.entered).toHaveLength(1)
    expect(await accounts.transactions(chq.id).list()).toHaveLength(1)

    expect((await ask(RECURRING_CHANNELS.skip, { ids: [id] })).ok).toBe(true)
    expect((await ask(RECURRING_CHANNELS.setPaused, { ids: [id], paused: true })).ok).toBe(true)

    const history = await ask(RECURRING_CHANNELS.history, { seriesId: id })
    expect(history.map((p: { outcome: string }) => p.outcome)).toEqual(['skipped', 'entered'])

    expect((await ask(RECURRING_CHANNELS.deleteSeries, { ids: [id] })).ok).toBe(true)
    expect((await ask(RECURRING_CHANNELS.snapshot)).rows).toEqual([])
  })

  it('returns a failure the view can show, rather than throwing at it', async () => {
    const { ask, series } = await setup()
    const bad = await ask(RECURRING_CHANNELS.saveSeries, { input: series({ template: template({ amount: 0 }) }) })
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID', field: 'amount' } })

    const asked = await ask(RECURRING_CHANNELS.enter, { requests: [{ seriesId: 'nope' }] })
    // A request for a series that is gone is reported per occurrence, not as an error for the whole call
    expect(asked.value.failed).toEqual([{ seriesId: 'nope', code: 'NOT_FOUND', message: expect.any(String) }])

    expect(await ask(RECURRING_CHANNELS.deleteSeries, { ids: 'all' })).toMatchObject({ ok: false, error: { field: 'ids' } })
  })

  it('shows paused and finished series only when the view asks', async () => {
    const { ask, recurring, series } = await setup()
    const paused = await recurring.create(series({ name: 'Paused', schedule: monthly('2026-11-20') }))
    await recurring.setPaused([paused.id], true)

    expect((await ask(RECURRING_CHANNELS.snapshot)).rows).toEqual([])
    expect((await ask(RECURRING_CHANNELS.snapshot, { includePaused: true })).rows).toHaveLength(1)
  })

  it('gives the view nothing at all while no book is open', async () => {
    const { runtime, ask } = await setup()
    await runtime.commands.execute(BOOK_COMMANDS.close)
    expect(await ask(RECURRING_CHANNELS.snapshot)).toBeNull()
    expect(await ask(RECURRING_CHANNELS.history, { seriesId: 'x' })).toEqual([])
  })
})

describe('following the accounts plugin while it runs', () => {
  it('pauses a series when its account closes, and says so in the snapshot', async () => {
    const { recurring, accounts, chq, ask, settle, series } = await setup()
    const one = await recurring.create(series({ name: 'Hydro', schedule: monthly('2026-11-20') }))
    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    await settle()

    expect(await recurring.get(one.id)).toMatchObject({ paused: true, pausedReason: 'accountClosed' })
    const snapshot = await ask(RECURRING_CHANNELS.snapshot) as RecurringSnapshot
    expect(snapshot.rows[0].blockedReason).toMatch(/closed/)
    expect(snapshot.summary.blockedCount).toBe(1)
  })

  it('deletes a series with its account, without being asked', async () => {
    const { recurring, accounts, chq, settle, series } = await setup()
    const one = await recurring.create(series({ schedule: monthly('2026-11-20') }))
    await accounts.deleteAccount(chq.id)
    await settle()
    expect(await recurring.get(one.id)).toBeUndefined()
  })
})

describe('noticing that the date has changed', () => {
  it('republishes when today moves on, and not before', async () => {
    vi.useFakeTimers()
    try {
      let today = '2026-11-13'
      const onRollover = vi.fn()
      const watch = watchDateRollover(() => today, onRollover, 1000)

      vi.advanceTimersByTime(5000)
      expect(onRollover).not.toHaveBeenCalled()

      today = '2026-11-14'
      vi.advanceTimersByTime(1000)
      expect(onRollover).toHaveBeenCalledTimes(1)

      // Only once per change, however long the window stays open
      vi.advanceTimersByTime(10_000)
      expect(onRollover).toHaveBeenCalledTimes(1)

      watch.dispose()
      today = '2026-11-15'
      vi.advanceTimersByTime(10_000)
      expect(onRollover).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('opening a book that has something overdue', () => {
  /** A book saved with an overdue series, then closed and reopened the way the app does it. */
  async function reopened(overdue: boolean) {
    const env = await setup()
    await env.recurring.create(env.series({ name: 'Hydro', schedule: monthly(overdue ? '2026-09-01' : '2026-12-01') }))
    await env.settle()
    await env.runtime.commands.execute(BOOK_COMMANDS.close)
    env.reveals.length = 0
    await env.ask(BOOK_CHANNELS.open, { path: file('Home.tessera') })
    await env.settle()
    return env
  }

  it('shows the Recurring view', async () => {
    const { reveals } = await reopened(true)
    expect(reveals).toContain(RECURRING_VIEWS.list)
  })

  it('leaves the layout alone when nothing is overdue, or when the book is brand new', async () => {
    const { reveals } = await reopened(false)
    expect(reveals).not.toContain(RECURRING_VIEWS.list)
    // The book created in setup() had no series at all, and nothing was revealed for it
    const fresh = await setup()
    expect(fresh.reveals).not.toContain(RECURRING_VIEWS.list)
  })
})

describe('the forecast, the holidays and the projected balance', () => {
  it('answers the Upcoming panel over IPC, and nothing while no book is open', async () => {
    const { ask, recurring, series, runtime } = await setup()
    await recurring.create(series({ name: 'Hydro', schedule: monthly('2026-11-20') }))
    const entries = await ask(RECURRING_CHANNELS.forecast, { from: '2026-11-13', to: '2026-12-31' })
    expect(entries.map((e: { date: string }) => e.date)).toEqual(['2026-11-20', '2026-12-20'])
    expect(await ask(RECURRING_CHANNELS.forecast, { from: 'x' })).toEqual([])

    await runtime.commands.execute(BOOK_COMMANDS.close)
    expect(await ask(RECURRING_CHANNELS.forecast, { from: '2026-11-13', to: '2026-12-31' })).toEqual([])
    expect(await ask(RECURRING_CHANNELS.holidays)).toEqual([])
  })

  it('keeps holidays over IPC, and opens their dialog from the menu', async () => {
    const { ask, run, prompts } = await setup()
    const added = await ask(RECURRING_CHANNELS.addHoliday, { date: '2026-12-25', name: 'Christmas Day' })
    expect(added).toMatchObject({ ok: true, value: { date: '2026-12-25', name: 'Christmas Day' } })
    expect(await ask(RECURRING_CHANNELS.addHoliday, { date: '2026-12-25', name: 'Again' })).toMatchObject({ ok: false, error: { field: 'date' } })
    expect((await ask(RECURRING_CHANNELS.holidays)).map((h: { name: string }) => h.name)).toEqual(['Christmas Day'])

    await run(C.holidays)
    expect(prompts.show).toHaveBeenLastCalledWith(RECURRING_DIALOGS.holidays, expect.objectContaining({
      holidays: [expect.objectContaining({ name: 'Christmas Day' })], today: '2026-11-13'
    }))

    expect((await ask(RECURRING_CHANNELS.removeHoliday, { id: added.value.id })).ok).toBe(true)
    expect(await ask(RECURRING_CHANNELS.holidays)).toEqual([])
  })

  it('gives the register a projected balance, transfers into the account included', async () => {
    const { run, recurring, accounts, chq, series } = await setup()
    const savings = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    await recurring.create(series({ name: 'Hydro', schedule: monthly('2026-11-20') }))                       // −142.00 from Chequing
    await recurring.create(series({
      name: 'Save', schedule: monthly('2026-11-25'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })               // 500.00 to Savings
    }))
    await recurring.create(series({ name: 'Far', schedule: monthly('2027-03-01') }))                         // outside the window

    // Chequing opens at 5,000.00: less the bill and the transfer out
    expect(await run(C.projectBalance, { accountId: chq.id })).toEqual({
      minor: 500000 - 14200 - 50000, currency: 'CAD', detail: 'after 2 scheduled transactions'
    })
    // Savings has nothing of its own scheduled, but receives the transfer
    expect(await run(C.projectBalance, { accountId: savings.id })).toEqual({
      minor: 50000, currency: 'CAD', detail: 'after 1 scheduled transaction'
    })
    // An account with nothing coming shows no figure, rather than one that repeats Current
    const quiet = await accounts.createAccount(chequing({ name: 'Quiet', openingBalance: 100 }))
    expect(await run(C.projectBalance, { accountId: quiet.id })).toBeUndefined()
    expect(await run(C.projectBalance, { accountId: 'gone' })).toBeUndefined()
  })

  it('is offered to the register through accounts.register.figures', async () => {
    const { ask, chq } = await setup()
    const figures = await ask(ACCOUNTS_CHANNELS.registerFigures, { accountId: chq.id })
    expect(figures).toEqual([{
      id: 'recurring.projected', label: 'Projected (30 days)', command: C.projectBalance,
      refreshOn: RECURRING_EVENTS.snapshot, description: expect.any(String), enabled: true
    }])
  })
})
