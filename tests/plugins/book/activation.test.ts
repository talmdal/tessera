// @vitest-environment node
// The book plugin as the app runs it: activated on a plugin runtime, driven through its commands, IPC and lifecycle.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import {
  BOOK_CHANNELS, BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_EVENTS, BOOK_SESSION_SERVICE, BOOK_VIEWS,
  type BookSession
} from '@tessera/book-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { activate } from '../../../plugins/book/src/privileged/index'
import { DIR, fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from './harness'

async function setup(options: { last?: string } = {}) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files, trashed } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  const state = memoryAppState()
  if (options.last) state.values.set('ledger.last', options.last)
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', state)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)

  const shell = createPluginContext('shell', runtime).context
  const reveals: string[] = []
  shell.commands.register('shell.layout.reveal', (viewId: unknown) => { reveals.push(String(viewId)) })

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const context = createPluginContext('book', runtime).context
  await activate(context, { disk: disk.disk })

  const run = (id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args)
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const session = runtime.services.get<BookSession>(BOOK_SESSION_SERVICE)
  const key = (k: string) => runtime.contextKeys.get(k)
  const last = (name: string) => events.filter(e => e.name === name).at(-1)?.data
  /** Opens a new book through File › New Book…, answering the save dialog. */
  const newBook = async (name = 'Home.tessera') => {
    files.showSaveDialog.mockResolvedValueOnce(file(name))
    return run(BOOK_COMMANDS.new)
  }
  return { runtime, log, driver, disk, files, trashed, prompts, answers, state, reveals, events, run, ask, session, key, last, newBook }
}

describe('the book plugin: contributions', () => {
  it('adds valid File menu items, views, dialogs and a status item, as the shell resolves them', async () => {
    const { runtime } = await setup()
    const impls = (point: string) => runtime.extensions.getContributions(point)

    const menus = resolveMenus([{ kind: 'menu', id: 'shell.file', label: '&File' }, ...impls('shell.menus').map(c => c.impl)])
    expect(menus.diagnostics).toEqual([])
    expect(menus.menus[0].children.filter(n => n.type === 'item').map(n => (n as any).label))
      .toEqual(['&New Book…', '&Open Book…', '&Close Book', '&Delete Book…'])

    const views = resolveViews(impls('shell.views'), () => 'tessera-plugin://book/remoteEntry.js')
    expect(views.diagnostics).toEqual([])
    expect(views.views.map(v => [v.id, v.slot, v.when])).toEqual([
      [BOOK_VIEWS.start, 'shell.main', '!book.isOpen'], [BOOK_VIEWS.tree, 'shell.left', 'book.isOpen && !book.hasNavigator']
    ])

    const dialogs = resolveDialogs(impls('shell.dialogs'), () => 'tessera-plugin://book/remoteEntry.js')
    expect(dialogs.diagnostics).toEqual([])
    expect(dialogs.dialogs.map(d => d.id)).toEqual([BOOK_DIALOGS.newBook, BOOK_DIALOGS.renameSubBook])

    const items = resolveBarItems(impls('shell.bar.items'))
    expect(items.diagnostics).toEqual([])
    expect(items.items[0]).toMatchObject({ kind: 'text', text: 'Book: {book.name}', when: 'book.isOpen' })
  })

  it('provides exactly the BookSession contract, not the implementation', async () => {
    const { session } = await setup()
    expect(Object.keys(session).sort()).toEqual([
      'close', 'create', 'createSubBook', 'current', 'database', 'delete', 'deleteSubBook', 'moveSubBook',
      'onDidChange', 'onDidChangeTree', 'onWillClose', 'open', 'participate', 'registerNavigator', 'renameSubBook', 'tree'
    ])
  })

  it('hides its Book panel while another plugin\'s navigator shows the tree, and brings it back when that goes', async () => {
    const { session, key, reveals, newBook } = await setup()
    expect(key(BOOK_CONTEXT_KEYS.hasNavigator)).toBe(false)

    const first = session.registerNavigator('accounts')
    const second = session.registerNavigator('budgets')
    expect(key(BOOK_CONTEXT_KEYS.hasNavigator)).toBe(true)
    // A navigator shows its own view of a new book; the hidden panel isn't revealed
    await newBook()
    expect(reveals).not.toContain(BOOK_VIEWS.tree)

    first.dispose()
    first.dispose()
    expect(key(BOOK_CONTEXT_KEYS.hasNavigator)).toBe(true)
    second.dispose()
    expect(key(BOOK_CONTEXT_KEYS.hasNavigator)).toBe(false)
  })
})

describe('the book plugin: commands', () => {
  it('enables Close and Delete only while a book is open, and publishes its state as context keys', async () => {
    const { runtime, key, newBook } = await setup()
    expect(key(BOOK_CONTEXT_KEYS.isOpen)).toBe(false)
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.close)).toBe(false)
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.delete)).toBe(false)
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.new)).toBe(true)
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.open)).toBe(true)

    await newBook()

    expect(key(BOOK_CONTEXT_KEYS.isOpen)).toBe(true)
    expect(key(BOOK_CONTEXT_KEYS.name)).toBe('Home')
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.close)).toBe(true)
    expect(runtime.commands.isEnabled(BOOK_COMMANDS.delete)).toBe(true)
  })

  it('New Book with nothing open goes straight to the save dialog, then shows the new book\'s tree', async () => {
    const { prompts, reveals, newBook, session } = await setup()
    await newBook()
    expect(prompts.show).not.toHaveBeenCalled()
    expect(session.current?.name).toBe('Home')
    expect(reveals).toContain(BOOK_VIEWS.tree)
  })

  it('New Book with a book open shows the dialog, with the parent asked for, or None', async () => {
    const { prompts, run, newBook, session } = await setup()
    await newBook()
    const personal = await session.createSubBook({ name: 'Personal', parentId: null })

    await run(BOOK_COMMANDS.new)
    await run(BOOK_COMMANDS.new, { parentId: personal.id })
    await run(BOOK_COMMANDS.new, { parentId: null })
    await run(BOOK_COMMANDS.new, { parentId: 'gone' })

    const inputs = prompts.show.mock.calls.map(call => call[1] as any)
    expect(prompts.show.mock.calls.every(call => call[0] === BOOK_DIALOGS.newBook)).toBe(true)
    expect(inputs.map(input => 'parentId' in input ? input.parentId : 'none')).toEqual(['none', personal.id, null, 'none'])
    expect(inputs[0].tree.subBooks.map((s: any) => s.name)).toEqual(['Personal'])
  })

  it('creates a new file when the dialog chooses no parent: asks to close the open one, suggests the name', async () => {
    const { prompts, files, run, newBook, session } = await setup()
    await newBook()
    prompts.show.mockResolvedValueOnce({ kind: 'file', name: 'Business' })
    files.showSaveDialog.mockResolvedValueOnce(file('Business.tessera'))

    await run(BOOK_COMMANDS.new)

    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Close “Home” and create a new book?' }))
    expect(files.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: path.join(DIR, 'Business.tessera') }))
    expect(session.current?.name).toBe('Business')
  })

  it('leaves the file alone when the dialog created a sub-book, and returns it for the caller to select', async () => {
    const { prompts, files, run, newBook, session } = await setup()
    await newBook()
    prompts.show.mockResolvedValueOnce({ kind: 'subBook', id: 's1' })
    expect(await run(BOOK_COMMANDS.new)).toEqual({ kind: 'subBook', id: 's1' })
    expect(files.showSaveDialog).toHaveBeenCalledTimes(1)
    expect(session.current?.name).toBe('Home')
  })

  it('shows why opening failed in a message box, without logging it as a bug', async () => {
    const { files, prompts, run, log } = await setup()
    files.showOpenDialog.mockResolvedValueOnce(file('Gone.tessera'))
    await run(BOOK_COMMANDS.open)
    expect(prompts.message).toHaveBeenCalledWith({
      kind: 'error', message: 'Could not open the book.', detail: '“Gone.tessera” can’t be found. It may have been moved or deleted.'
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('Close Book shows the start view; Delete Book sends the file to the trash and does the same', async () => {
    const { run, reveals, newBook, trashed } = await setup()
    await newBook()
    await run(BOOK_COMMANDS.close)
    expect(reveals.at(-1)).toBe(BOOK_VIEWS.start)

    await newBook('Other.tessera')
    reveals.length = 0
    expect(await run(BOOK_COMMANDS.delete)).toBe(true)
    expect(trashed).toEqual([file('Other.tessera')])
    expect(reveals).toEqual([BOOK_VIEWS.start])
  })

  it('renames a sub-book through its dialog, with its name and revision', async () => {
    const { prompts, run, newBook, session } = await setup()
    await newBook()
    const personal = await session.createSubBook({ name: 'Personal', parentId: null })
    await run(BOOK_COMMANDS.renameSubBook, { id: personal.id })
    expect(prompts.show).toHaveBeenCalledWith(BOOK_DIALOGS.renameSubBook, { id: personal.id, name: 'Personal', rev: personal.rev })
    await expect(run(BOOK_COMMANDS.renameSubBook)).rejects.toThrow('needs { id }')
  })

  it('confirms deleting a sub-book, saying what moves where, then deletes it', async () => {
    const { prompts, answers, run, newBook, session } = await setup()
    await newBook()
    const business = await session.createSubBook({ name: 'Business', parentId: null })
    await session.createSubBook({ name: 'Shop', parentId: business.id })
    session.participate('accounts', { describe: async () => '4 accounts', reparent: async () => {} })

    answers.push(false)
    expect(await run(BOOK_COMMANDS.deleteSubBook, { id: business.id })).toBe(false)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Delete sub-book “Business”?',
      detail: 'Its 1 sub-book and 4 accounts will move to “Home”. Nothing in it is deleted.'
    }))
    expect(await run(BOOK_COMMANDS.deleteSubBook, { id: business.id })).toBe(true)
    expect((await session.tree()).subBooks.map(s => s.name)).toEqual(['Shop'])
  })

  it('says an empty sub-book is empty', async () => {
    const { prompts, run, newBook, session } = await setup()
    await newBook()
    const empty = await session.createSubBook({ name: 'Empty', parentId: null })
    await run(BOOK_COMMANDS.deleteSubBook, { id: empty.id })
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ detail: 'It is empty.' }))
  })
})

describe('the book plugin: views\' requests and events', () => {
  it('answers the start view and the tree, and pushes their changes', async () => {
    const { ask, last, newBook, run, session } = await setup()
    expect(await ask(BOOK_CHANNELS.state)).toEqual({ isOpen: false })
    expect(await ask(BOOK_CHANNELS.tree)).toBeNull()

    await newBook()
    await session.createSubBook({ name: 'Personal', parentId: null })
    expect(last(BOOK_EVENTS.state)).toMatchObject({ isOpen: true, book: { name: 'Home' } })
    expect(last(BOOK_EVENTS.tree).subBooks.map((s: any) => s.name)).toEqual(['Personal'])
    expect(last(BOOK_EVENTS.recent)).toEqual([expect.objectContaining({ name: 'Home', exists: true })])
    expect((await ask(BOOK_CHANNELS.tree)).book.name).toBe('Home')

    await run(BOOK_COMMANDS.close)
    expect(last(BOOK_EVENTS.state)).toEqual({ isOpen: false })
    expect(last(BOOK_EVENTS.tree)).toBeNull()
  })

  it('creates and renames sub-books for the dialogs, with errors as results', async () => {
    const { ask, newBook } = await setup()
    await newBook()
    const created = await ask(BOOK_CHANNELS.createSubBook, { name: 'Personal', parentId: null })
    expect(created).toMatchObject({ ok: true, value: { name: 'Personal' } })
    expect(await ask(BOOK_CHANNELS.createSubBook, { name: 'personal' }))
      .toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a “personal” there.', field: 'name' } })
    expect(await ask(BOOK_CHANNELS.renameSubBook, { id: created.value.id, name: 'Home', expectedRev: created.value.rev }))
      .toMatchObject({ ok: true, value: { name: 'Home' } })
  })

  it('opens, forgets and deletes recent books for the start view', async () => {
    const { ask, newBook, run, trashed, driver } = await setup()
    await newBook('A.tessera')
    await run(BOOK_COMMANDS.close)     // with a book open, New Book… would show its dialog
    await newBook('B.tessera')
    await run(BOOK_COMMANDS.close)
    driver.databases.delete(file('B.tessera'))    // moved away behind the app's back

    expect((await ask(BOOK_CHANNELS.recent)).map((r: any) => [r.name, r.exists])).toEqual([['B', false], ['A', true]])
    expect(await ask(BOOK_CHANNELS.open, { path: file('B.tessera') })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })
    await ask(BOOK_CHANNELS.recentRemove, { path: file('B.tessera') })
    expect(await ask(BOOK_CHANNELS.open, { path: file('A.tessera') })).toMatchObject({ ok: true, value: { name: 'A' } })
    await run(BOOK_COMMANDS.close)
    expect(await ask(BOOK_CHANNELS.delete, { path: file('A.tessera') })).toBe(true)
    expect(trashed).toEqual([file('A.tessera')])
    expect(await ask(BOOK_CHANNELS.recent)).toEqual([])
  })
})

describe('the book plugin: lifecycle', () => {
  it('reopens the book that was open when the app quit', async () => {
    const first = await setup()
    await first.newBook()
    await first.runtime.lifecycle.markStarted()
    await first.runtime.lifecycle.requestShutdown()
    expect(first.session.current).toBeUndefined()
    expect(first.state.values.get('ledger.last')).toBe(file('Home.tessera'))
  })

  it('reopens the last book once the app has started', async () => {
    const env = await setup({ last: file('Home.tessera') })
    // The file exists: made through the engine, as a previous run would have
    await env.runtime.services.get<any>('storage.engine').open({ path: file('Home.tessera') }).then(async (db: any) => {
      await db.meta.set('ledger.format', 1); await db.close()
    })

    await env.runtime.lifecycle.markStarted()

    expect(env.session.current?.name).toBe('Home')
    expect(env.reveals).not.toContain(BOOK_VIEWS.start)
  })

  it('shows the start view, with the reason, when the last book can\'t be reopened', async () => {
    const env = await setup({ last: file('Gone.tessera') })
    await env.runtime.lifecycle.markStarted()
    expect(env.session.current).toBeUndefined()
    expect(env.reveals).toEqual([BOOK_VIEWS.start])
    expect(await env.ask(BOOK_CHANNELS.state)).toEqual({
      isOpen: false, error: '“Gone” could not be reopened. “Gone.tessera” can’t be found. It may have been moved or deleted.'
    })
  })

  it('clears that reason once a book opens', async () => {
    const env = await setup({ last: file('Gone.tessera') })
    await env.runtime.lifecycle.markStarted()
    await env.newBook()
    expect(await env.ask(BOOK_CHANNELS.state)).toEqual({ isOpen: true, book: expect.objectContaining({ name: 'Home' }) })
  })
})
