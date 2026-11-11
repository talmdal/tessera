// @vitest-environment node
// The ledger plugin as the app runs it: activated on a plugin runtime, driven through its commands, IPC and lifecycle.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import {
  LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_DIALOGS, LEDGER_EVENTS, LEDGER_SESSION_SERVICE, LEDGER_SETTINGS_PAGE, LEDGER_VIEWS,
  type LedgerSession
} from '@tessera/ledger-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { activate } from '../../../plugins/ledger/src/privileged/index'
import { DIR, fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from './harness'
import { memorySettingsPersistence } from '../../helpers/settings'

/** `settings` are the ledger's saved settings, read as the app reads them before plugins activate. */
async function setup(options: { last?: string, settings?: object, recent?: string[] } = {}) {
  const log = logger()
  const saved = memorySettingsPersistence(options.settings ? { ledger: { version: 1, values: options.settings } } : {})
  const runtime = createPluginRuntime(undefined, log, { settingsPersistence: saved.persistence })
  await runtime.settings.load()
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files, trashed } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  const state = memoryAppState()
  if (options.last) state.values.set('ledger.last', options.last)
  if (options.recent) state.values.set('ledger.recent', options.recent.map(name => ({ path: file(name), name, openedAt: '2026-11-01T00:00:00.000Z' })))
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', state)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)

  const shell = createPluginContext('shell', runtime).context
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (viewId: unknown) => { reveals.push(String(viewId)) })

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const context = createPluginContext('ledger', runtime).context
  await activate(context, { disk: disk.disk })

  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const key = (k: string) => runtime.contextKeys.get(k)
  const last = (name: string) => events.filter(e => e.name === name).at(-1)?.data
  /** Opens a new ledger through File › New Ledger…, answering the save dialog. */
  const newLedger = async (name = 'Home.tessera') => {
    files.showSaveDialog.mockResolvedValueOnce(file(name))
    return run(LEDGER_COMMANDS.new)
  }
  return { runtime, log, driver, disk, files, trashed, prompts, answers, state, reveals, events, run, ask, session, key, last, newLedger, saved }
}

describe('the ledger plugin: contributions', () => {
  it('adds valid File menu items, views, dialogs and a status item, as the shell resolves them', async () => {
    const { runtime } = await setup()
    const impls = (point: string) => runtime.extensions.getContributions(point)

    const menus = resolveMenus([{ kind: 'menu', id: 'shell.file', label: '&File' }, ...impls('shell.menus').map(c => c.impl)])
    expect(menus.diagnostics).toEqual([])
    expect(menus.menus[0].children.filter(n => n.type === 'item').map(n => (n as any).label))
      .toEqual(['&New Ledger…', '&Open Ledger…', '&Close Ledger', '&Delete Ledger…'])

    const views = resolveViews(impls('shell.views'), () => 'tessera-plugin://ledger/remoteEntry.js')
    expect(views.diagnostics).toEqual([])
    expect(views.views.map(v => [v.id, v.slot, v.when])).toEqual([
      [LEDGER_VIEWS.start, 'shell.main', '!ledger.isOpen'], [LEDGER_VIEWS.tree, 'shell.left', 'ledger.isOpen && !ledger.hasNavigator']
    ])

    const dialogs = resolveDialogs(impls('shell.dialogs'), () => 'tessera-plugin://ledger/remoteEntry.js')
    expect(dialogs.diagnostics).toEqual([])
    expect(dialogs.dialogs.map(d => d.id)).toEqual([LEDGER_DIALOGS.newLedger, LEDGER_DIALOGS.renameSubLedger])

    const items = resolveBarItems(impls('shell.bar.items'))
    expect(items.diagnostics).toEqual([])
    expect(items.items[0]).toMatchObject({ kind: 'text', text: 'Ledger: {ledger.name}', when: 'ledger.isOpen' })
  })

  it('provides exactly the LedgerSession contract, not the implementation', async () => {
    const { session } = await setup()
    expect(Object.keys(session).sort()).toEqual([
      'close', 'create', 'createSubLedger', 'current', 'database', 'delete', 'deleteSubLedger', 'moveSubLedger',
      'onDidChange', 'onDidChangeTree', 'onWillClose', 'open', 'participate', 'registerNavigator', 'renameSubLedger', 'tree'
    ])
  })

  it('hides its Ledger panel while another plugin\'s navigator shows the tree, and brings it back when that goes', async () => {
    const { session, key, reveals, newLedger } = await setup()
    expect(key(LEDGER_CONTEXT_KEYS.hasNavigator)).toBe(false)

    const first = session.registerNavigator('accounts')
    const second = session.registerNavigator('budgets')
    expect(key(LEDGER_CONTEXT_KEYS.hasNavigator)).toBe(true)
    // A navigator shows its own view of a new ledger; the hidden panel isn't revealed
    await newLedger()
    expect(reveals).not.toContain(LEDGER_VIEWS.tree)

    first.dispose()
    first.dispose()
    expect(key(LEDGER_CONTEXT_KEYS.hasNavigator)).toBe(true)
    second.dispose()
    expect(key(LEDGER_CONTEXT_KEYS.hasNavigator)).toBe(false)
  })
})

describe('the ledger plugin: commands', () => {
  it('enables Close and Delete only while a ledger is open, and publishes its state as context keys', async () => {
    const { runtime, key, newLedger } = await setup()
    expect(key(LEDGER_CONTEXT_KEYS.isOpen)).toBe(false)
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.close)).toBe(false)
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.delete)).toBe(false)
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.new)).toBe(true)
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.open)).toBe(true)

    await newLedger()

    expect(key(LEDGER_CONTEXT_KEYS.isOpen)).toBe(true)
    expect(key(LEDGER_CONTEXT_KEYS.name)).toBe('Home')
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.close)).toBe(true)
    expect(runtime.commands.isEnabled(LEDGER_COMMANDS.delete)).toBe(true)
  })

  it('New Ledger with nothing open goes straight to the save dialog, then shows the new ledger\'s tree', async () => {
    const { prompts, reveals, newLedger, session } = await setup()
    await newLedger()
    expect(prompts.show).not.toHaveBeenCalled()
    expect(session.current?.name).toBe('Home')
    expect(reveals).toContain(LEDGER_VIEWS.tree)
  })

  it('New Ledger with a ledger open shows the dialog, with the parent asked for, or None', async () => {
    const { prompts, run, newLedger, session } = await setup()
    await newLedger()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })

    await run(LEDGER_COMMANDS.new)
    await run(LEDGER_COMMANDS.new, { parentId: personal.id })
    await run(LEDGER_COMMANDS.new, { parentId: null })
    await run(LEDGER_COMMANDS.new, { parentId: 'gone' })

    const inputs = prompts.show.mock.calls.map(call => call[1] as any)
    expect(prompts.show.mock.calls.every(call => call[0] === LEDGER_DIALOGS.newLedger)).toBe(true)
    expect(inputs.map(input => 'parentId' in input ? input.parentId : 'none')).toEqual(['none', personal.id, null, 'none'])
    expect(inputs[0].tree.subLedgers.map((s: any) => s.name)).toEqual(['Personal'])
  })

  it('creates a new file when the dialog chooses no parent: asks to close the open one, suggests the name', async () => {
    const { prompts, files, run, newLedger, session } = await setup()
    await newLedger()
    prompts.show.mockResolvedValueOnce({ kind: 'file', name: 'Business' })
    files.showSaveDialog.mockResolvedValueOnce(file('Business.tessera'))

    await run(LEDGER_COMMANDS.new)

    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Close “Home” and create a new ledger?' }))
    expect(files.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: path.join(DIR, 'Business.tessera') }))
    expect(session.current?.name).toBe('Business')
  })

  it('leaves the file alone when the dialog created a sub-ledger, and returns it for the caller to select', async () => {
    const { prompts, files, run, newLedger, session } = await setup()
    await newLedger()
    prompts.show.mockResolvedValueOnce({ kind: 'subLedger', id: 's1' })
    expect(await run(LEDGER_COMMANDS.new)).toEqual({ kind: 'subLedger', id: 's1' })
    expect(files.showSaveDialog).toHaveBeenCalledTimes(1)
    expect(session.current?.name).toBe('Home')
  })

  it('shows why opening failed in a message box, without logging it as a bug', async () => {
    const { files, prompts, run, log } = await setup()
    files.showOpenDialog.mockResolvedValueOnce(file('Gone.tessera'))
    await run(LEDGER_COMMANDS.open)
    expect(prompts.message).toHaveBeenCalledWith({
      kind: 'error', message: 'Could not open the ledger.', detail: '“Gone.tessera” can’t be found. It may have been moved or deleted.'
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('Close Ledger shows the start view; Delete Ledger sends the file to the trash and does the same', async () => {
    const { run, reveals, newLedger, trashed } = await setup()
    await newLedger()
    await run(LEDGER_COMMANDS.close)
    expect(reveals.at(-1)).toBe(LEDGER_VIEWS.start)

    await newLedger('Other.tessera')
    reveals.length = 0
    expect(await run(LEDGER_COMMANDS.delete)).toBe(true)
    expect(trashed).toEqual([file('Other.tessera')])
    expect(reveals).toEqual([LEDGER_VIEWS.start])
  })

  it('renames a sub-ledger through its dialog, with its name and revision', async () => {
    const { prompts, run, newLedger, session } = await setup()
    await newLedger()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    await run(LEDGER_COMMANDS.renameSubLedger, { id: personal.id })
    expect(prompts.show).toHaveBeenCalledWith(LEDGER_DIALOGS.renameSubLedger, { id: personal.id, name: 'Personal', rev: personal.rev })
    await expect(run(LEDGER_COMMANDS.renameSubLedger)).rejects.toThrow('needs { id }')
  })

  it('confirms deleting a sub-ledger, saying what moves where, then deletes it', async () => {
    const { prompts, answers, run, newLedger, session } = await setup()
    await newLedger()
    const business = await session.createSubLedger({ name: 'Business', parentId: null })
    await session.createSubLedger({ name: 'Shop', parentId: business.id })
    session.participate('accounts', { describe: async () => '4 accounts', reparent: async () => {} })

    answers.push(false)
    expect(await run(LEDGER_COMMANDS.deleteSubLedger, { id: business.id })).toBe(false)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Delete sub-ledger “Business”?',
      detail: 'Its 1 sub-ledger and 4 accounts will move to “Home”. Nothing in it is deleted.'
    }))
    expect(await run(LEDGER_COMMANDS.deleteSubLedger, { id: business.id })).toBe(true)
    expect((await session.tree()).subLedgers.map(s => s.name)).toEqual(['Shop'])
  })

  it('says an empty sub-ledger is empty', async () => {
    const { prompts, run, newLedger, session } = await setup()
    await newLedger()
    const empty = await session.createSubLedger({ name: 'Empty', parentId: null })
    await run(LEDGER_COMMANDS.deleteSubLedger, { id: empty.id })
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ detail: 'It is empty.' }))
  })
})

describe('the ledger plugin: views\' requests and events', () => {
  it('answers the start view and the tree, and pushes their changes', async () => {
    const { ask, last, newLedger, run, session } = await setup()
    expect(await ask(LEDGER_CHANNELS.state)).toEqual({ isOpen: false })
    expect(await ask(LEDGER_CHANNELS.tree)).toBeNull()

    await newLedger()
    await session.createSubLedger({ name: 'Personal', parentId: null })
    expect(last(LEDGER_EVENTS.state)).toMatchObject({ isOpen: true, ledger: { name: 'Home' } })
    expect(last(LEDGER_EVENTS.tree).subLedgers.map((s: any) => s.name)).toEqual(['Personal'])
    expect(last(LEDGER_EVENTS.recent)).toEqual([expect.objectContaining({ name: 'Home', exists: true })])
    expect((await ask(LEDGER_CHANNELS.tree)).ledger.name).toBe('Home')

    await run(LEDGER_COMMANDS.close)
    expect(last(LEDGER_EVENTS.state)).toEqual({ isOpen: false })
    expect(last(LEDGER_EVENTS.tree)).toBeNull()
  })

  it('creates and renames sub-ledgers for the dialogs, with errors as results', async () => {
    const { ask, newLedger } = await setup()
    await newLedger()
    const created = await ask(LEDGER_CHANNELS.createSubLedger, { name: 'Personal', parentId: null })
    expect(created).toMatchObject({ ok: true, value: { name: 'Personal' } })
    expect(await ask(LEDGER_CHANNELS.createSubLedger, { name: 'personal' }))
      .toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a “personal” there.', field: 'name' } })
    expect(await ask(LEDGER_CHANNELS.renameSubLedger, { id: created.value.id, name: 'Home', expectedRev: created.value.rev }))
      .toMatchObject({ ok: true, value: { name: 'Home' } })
  })

  it('opens, forgets and deletes recent ledgers for the start view', async () => {
    const { ask, newLedger, run, trashed, driver } = await setup()
    await newLedger('A.tessera')
    await run(LEDGER_COMMANDS.close)     // with a ledger open, New Ledger… would show its dialog
    await newLedger('B.tessera')
    await run(LEDGER_COMMANDS.close)
    driver.databases.delete(file('B.tessera'))    // moved away behind the app's back

    expect((await ask(LEDGER_CHANNELS.recent)).map((r: any) => [r.name, r.exists])).toEqual([['B', false], ['A', true]])
    expect(await ask(LEDGER_CHANNELS.open, { path: file('B.tessera') })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })
    await ask(LEDGER_CHANNELS.recentRemove, { path: file('B.tessera') })
    expect(await ask(LEDGER_CHANNELS.open, { path: file('A.tessera') })).toMatchObject({ ok: true, value: { name: 'A' } })
    await run(LEDGER_COMMANDS.close)
    expect(await ask(LEDGER_CHANNELS.delete, { path: file('A.tessera') })).toBe(true)
    expect(trashed).toEqual([file('A.tessera')])
    expect(await ask(LEDGER_CHANNELS.recent)).toEqual([])
  })
})

describe('the ledger plugin: lifecycle', () => {
  it('reopens the ledger that was open when the app quit', async () => {
    const first = await setup()
    await first.newLedger()
    await first.runtime.lifecycle.markStarted()
    await first.runtime.lifecycle.requestShutdown()
    expect(first.session.current).toBeUndefined()
    expect(first.state.values.get('ledger.last')).toBe(file('Home.tessera'))
  })

  it('reopens the last ledger once the app has started', async () => {
    const env = await setup({ last: file('Home.tessera') })
    // The file exists: made through the engine, as a previous run would have
    await env.runtime.services.get<any>('storage.engine').open({ path: file('Home.tessera') }).then(async (db: any) => {
      await db.meta.set('ledger.format', 1); await db.close()
    })

    await env.runtime.lifecycle.markStarted()

    expect(env.session.current?.name).toBe('Home')
    expect(env.reveals).not.toContain(LEDGER_VIEWS.start)
  })

  it('shows the start view, with the reason, when the last ledger can\'t be reopened', async () => {
    const env = await setup({ last: file('Gone.tessera') })
    await env.runtime.lifecycle.markStarted()
    expect(env.session.current).toBeUndefined()
    expect(env.reveals).toEqual([LEDGER_VIEWS.start])
    expect(await env.ask(LEDGER_CHANNELS.state)).toEqual({
      isOpen: false, error: '“Gone” could not be reopened. “Gone.tessera” can’t be found. It may have been moved or deleted.'
    })
  })

  it('clears that reason once a ledger opens', async () => {
    const env = await setup({ last: file('Gone.tessera') })
    await env.runtime.lifecycle.markStarted()
    await env.newLedger()
    expect(await env.ask(LEDGER_CHANNELS.state)).toEqual({ isOpen: true, ledger: expect.objectContaining({ name: 'Home' }) })
  })
})

describe('the ledger plugin: settings', () => {
  /** A ledger file a previous run left, so there is something to reopen. */
  const leaveLedger = async (env: Awaited<ReturnType<typeof setup>>, name: string) => {
    const db = await env.runtime.services.get<any>('storage.engine').open({ path: file(name) })
    await db.meta.set('ledger.format', 1)
    await db.close()
  }

  it('contributes a page the shell draws, for settings it registered', async () => {
    const { runtime, log } = await setup()
    const pages = runtime.settings.pages()

    expect(pages.map(p => [p.id, p.settings, p.fields?.map(f => f.key)])).toEqual([[LEDGER_SETTINGS_PAGE, 'ledger', ['reopenLast', 'recentLimit']]])
    expect(runtime.settings.snapshot('ledger')?.value).toEqual({ reopenLast: true, recentLimit: 10 })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('starts at the start view, not the last ledger, when the user said so', async () => {
    const env = await setup({ last: file('Home.tessera'), settings: { reopenLast: false } })
    await leaveLedger(env, 'Home.tessera')

    await env.runtime.lifecycle.markStarted()

    expect(env.session.current).toBeUndefined()
    expect(env.reveals).toEqual([LEDGER_VIEWS.start])
    expect(await env.ask(LEDGER_CHANNELS.state)).toEqual({ isOpen: false })
  })

  it('lists as many recent ledgers as the user chose, at once when the number changes', async () => {
    const env = await setup({ recent: ['A.tessera', 'B.tessera', 'C.tessera', 'D.tessera'], settings: { recentLimit: 3 } })
    expect((await env.ask(LEDGER_CHANNELS.recent)).map((r: { name: string }) => r.name)).toEqual(['A.tessera', 'B.tessera', 'C.tessera'])

    const result = await env.runtime.settings.commit([{ id: 'ledger', value: { reopenLast: true, recentLimit: 2 } }])

    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(env.last(LEDGER_EVENTS.recent)?.map((r: { name: string }) => r.name)).toEqual(['A.tessera', 'B.tessera']))
    await env.newLedger('E.tessera')
    expect((env.state.values.get('ledger.recent') as { name: string }[]).map(r => r.name)).toEqual(['E', 'A.tessera'])
  })

  it('refuses a number of recent ledgers it cannot list, from the dialog or a file edited by hand', async () => {
    const env = await setup()
    expect(await env.runtime.settings.commit([{ id: 'ledger', value: { recentLimit: 0 } }]))
      .toEqual({ ok: false, errors: { ledger: ['Recent ledgers to list: enter a number from 1 to 30.', 'List from 1 to 30 recent ledgers.'] } })

    const edited = await setup({ settings: { recentLimit: 500 } })
    expect(edited.runtime.settings.snapshot('ledger')?.value).toEqual({ reopenLast: true, recentLimit: 10 })
    expect(edited.log.warn).toHaveBeenCalledWith(expect.stringContaining('List from 1 to 30 recent ledgers.'))
  })
})
