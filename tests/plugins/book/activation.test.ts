// @vitest-environment node
// The book plugin as the app runs it: activated on a plugin runtime, driven through its commands, IPC and lifecycle.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { OPTIONS_EXTENSION_POINT, SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import type { OptionsService } from '../../../core/options/OptionsService'
import {
  BACKUP_FILE_FILTER, BOOK_CHANNELS, BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_EVENTS, BOOK_SESSION_SERVICE, BOOK_VIEWS,
  type BookSession, BOOK_OPTIONS_DEFAULTS, BOOK_PLUGIN_ID, type BookInfo, type BookOptions
} from '@tessera/book-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { resolveViews } from '../../../shared/views/resolveViews'
import { activate } from '../../../plugins/book/src/privileged/index'
import { DIR, fakeFiles, fakePrompts, file, logger, memoryAppState, memoryBackupDisk, memoryDisk } from './harness'

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
  const backupDisk = memoryBackupDisk()
  await activate(context, { disk: disk.disk, backupDisk: backupDisk.disk })

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
  return { runtime, log, driver, disk, backupDisk, files, trashed, prompts, answers, state, reveals, events, run, ask, session, key, last, newBook }
}

describe('the book plugin: contributions', () => {
  it('adds valid File menu items, views, dialogs and a status item, as the shell resolves them', async () => {
    const { runtime } = await setup()
    const impls = (point: string) => runtime.extensions.getContributions(point)

    const menus = resolveMenus([{ kind: 'menu', id: 'shell.file', label: '&File' }, ...impls('shell.menus').map(c => c.impl)])
    expect(menus.diagnostics).toEqual([])
    expect(menus.menus[0].children.filter(n => n.type === 'item').map(n => (n as any).label))
      .toEqual(['&New Book…', '&Open Book…', '&Close Book', 'Back &Up Now', 'Back Up &To…', '&Restore from Backup…', '&Delete Book…'])

    const views = resolveViews(impls('shell.views'), () => 'tessera-plugin://book/remoteEntry.js')
    expect(views.diagnostics).toEqual([])
    expect(views.views.map(v => [v.id, v.slot, v.when])).toEqual([
      [BOOK_VIEWS.start, 'shell.main', '!book.isOpen'], [BOOK_VIEWS.tree, 'shell.left', 'book.isOpen && !book.hasNavigator']
    ])

    const dialogs = resolveDialogs(impls('shell.dialogs'), () => 'tessera-plugin://book/remoteEntry.js')
    expect(dialogs.diagnostics).toEqual([])
    expect(dialogs.dialogs.map(d => d.id)).toEqual([BOOK_DIALOGS.newBook, BOOK_DIALOGS.renameSubBook, BOOK_DIALOGS.restore])

    const items = resolveBarItems(impls('shell.bar.items'))
    expect(items.diagnostics).toEqual([])
    expect(items.items[0]).toMatchObject({ kind: 'text', text: 'Book: {book.name}', when: 'book.isOpen' })
    expect(items.items[1]).toMatchObject({
      kind: 'text', icon: 'Warning', text: 'Last backup failed', when: 'book.backup.failed', command: BOOK_COMMANDS.backupSettings
    })
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

  it('backs the book up when the app quits, before quitting finishes', async () => {
    const env = await setup()
    const book = await env.newBook()
    await env.runtime.lifecycle.markStarted()
    await env.runtime.lifecycle.requestShutdown()

    expect(env.backupDisk.writes).toHaveLength(1)
    expect(env.backupDisk.writes[0]).toMatch(/Tessera Backups[\\/]Home \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.tessera-backup$/)
    expect((env.state.values.get('book.backups') as any)?.[(book as any).id]).toMatchObject({ lastResult: 'ok', changed: false })
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

describe('the Backups options page', () => {
  const DEFAULT_FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')

  it('is contributed under a Book category, naming a module the plugin exposes', async () => {
    const { runtime } = await setup()
    const pages = runtime.extensions.getContributions(OPTIONS_EXTENSION_POINT).filter(c => c.contributor === BOOK_PLUGIN_ID).map(c => c.impl)
    expect(pages).toEqual([
      expect.objectContaining({ id: 'book.options', title: 'Book' }),
      expect.objectContaining({ id: 'book.options.backups', title: 'Backups', parent: 'book.options', module: './BackupsOptionsPage' })
    ])
    expect((pages[0] as { module?: string }).module).toBeUndefined()      // a category only groups pages
  })

  it('registers the book’s options, starting at the defaults', async () => {
    const { runtime } = await setup()
    const options = runtime.options as OptionsService
    expect(options.get<BookOptions>(BOOK_PLUGIN_ID)).toEqual(BOOK_OPTIONS_DEFAULTS)
  })

  it('refuses a setting the page would refuse, through the same check', async () => {
    const { runtime } = await setup()
    const options = runtime.options as OptionsService
    const backups = BOOK_OPTIONS_DEFAULTS.backups
    expect(options.commit(BOOK_PLUGIN_ID, { backups: { ...backups, keep: 0 } })).toEqual(['Keep between 1 and 999 automatic backups.'])
    expect(options.commit(BOOK_PLUGIN_ID, { backups: { ...backups, folder: 'relative/folder' } }))
      .toEqual(['The backup folder must be a full path, such as one chosen with Browse….'])
    expect(options.get<BookOptions>(BOOK_PLUGIN_ID)).toEqual(BOOK_OPTIONS_DEFAULTS)
  })

  it('takes effect at the next close: what the user applies is what the backups use', async () => {
    const env = await setup()
    const usb = path.resolve('/media/kim/USB')
    env.backupDisk.folders.add(usb)
    expect((env.runtime.options as OptionsService).commit(BOOK_PLUGIN_ID, {
      backups: { ...BOOK_OPTIONS_DEFAULTS.backups, folder: usb }
    })).toEqual([])

    await env.newBook()
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(env.backupDisk.writes).toHaveLength(1))
    expect(path.dirname(env.backupDisk.writes[0])).toBe(usb)
  })

  it('reports the status of the open book, then of the last book once it has closed, and pushes each change', async () => {
    const env = await setup()
    expect(await env.ask(BOOK_CHANNELS.backupsStatus)).toEqual({ defaultFolder: DEFAULT_FOLDER })

    const book = await env.newBook() as BookInfo
    expect(await env.ask(BOOK_CHANNELS.backupsStatus)).toEqual({ book: { id: book.id, name: 'Home' }, defaultFolder: DEFAULT_FOLDER })

    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(env.last(BOOK_EVENTS.backups)?.lastResult).toBe('ok'))
    const status = await env.ask(BOOK_CHANNELS.backupsStatus)
    expect(status).toEqual({
      book: { id: book.id, name: 'Home' },        // closed: found through the recent list, by its path
      lastBackupAt: expect.any(String), lastFile: env.backupDisk.writes[0], lastResult: 'ok', defaultFolder: DEFAULT_FOLDER
    })
    expect(env.last(BOOK_EVENTS.backups)).toEqual(status)
  })

  it('reports a failed backup with its reason', async () => {
    const env = await setup()
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')
    await env.newBook()
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(env.last(BOOK_EVENTS.backups)?.lastResult).toBe('failed'))
    expect(env.last(BOOK_EVENTS.backups)?.lastError).toContain('ENOSPC')
  })

  it('shows the folder picker in the current folder, or the default one, modal to the window that asked', async () => {
    const env = await setup()
    env.files.showFolderDialog.mockResolvedValueOnce('/picked').mockResolvedValueOnce(undefined)

    // The sender comes from the main process, never from the request: a window can't claim to be another
    const reply = await env.runtime.ipc.dispatch({ channel: BOOK_CHANNELS.backupsChooseFolder, data: { current: null } }, { windowId: 7 })
    expect(reply).toMatchObject({ ok: true, data: '/picked' })
    expect(env.files.showFolderDialog).toHaveBeenLastCalledWith({
      title: 'Choose Backup Folder', defaultPath: DEFAULT_FOLDER, buttonLabel: 'Choose Folder', windowId: 7
    })

    expect(await env.ask(BOOK_CHANNELS.backupsChooseFolder, { current: '/media/kim/USB' })).toBeUndefined()
    expect(env.files.showFolderDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: '/media/kim/USB' }))
    await expect(env.ask(BOOK_CHANNELS.backupsChooseFolder, { current: 42 })).rejects.toThrow('current must be a folder path or null')
  })
})

describe('backing up on demand: File › Back Up Now and Back Up To…', () => {
  const DEFAULT_FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')

  it('Back Up Now writes a manual backup into the backup folder, says where, and keeps the book open', async () => {
    const env = await setup()
    await env.newBook()
    const written = await env.run(BOOK_COMMANDS.backupNow) as string

    expect(env.backupDisk.writes).toEqual([written])
    expect(written).toMatch(/[\\/]Tessera Backups[\\/]Home \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} \(manual\)\.tessera-backup$/)
    expect(env.prompts.message).toHaveBeenLastCalledWith({
      kind: 'info', message: 'Backed up “Home”.', detail: `Saved as “${path.basename(written)}” in ${DEFAULT_FOLDER}.`
    })
    expect(env.session.current?.name).toBe('Home')
    expect(env.last(BOOK_EVENTS.backups)).toMatchObject({ lastFile: written, lastResult: 'ok' })
  })

  it('both are enabled only while a book is open', async () => {
    const env = await setup()
    const enabled = (id: string) => env.runtime.commands.isEnabled(id)
    expect([enabled(BOOK_COMMANDS.backupNow), enabled(BOOK_COMMANDS.backupTo)]).toEqual([false, false])
    await env.newBook()
    expect([enabled(BOOK_COMMANDS.backupNow), enabled(BOOK_COMMANDS.backupTo)]).toEqual([true, true])
  })

  it('Back Up To… asks where, suggesting a dated name in the backup folder, and writes there', async () => {
    const env = await setup()
    await env.newBook()
    const usb = path.resolve('/media/kim/USB')
    env.backupDisk.folders.add(usb)
    env.files.showSaveDialog.mockResolvedValueOnce(path.join(usb, 'For the accountant'))     // typed without the extension

    const written = await env.run(BOOK_COMMANDS.backupTo) as string
    expect(env.files.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Back Up To', buttonLabel: 'Back Up', filters: [BACKUP_FILE_FILTER],
      defaultPath: expect.stringMatching(/[\\/]Tessera Backups[\\/]Home \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} \(manual\)\.tessera-backup$/)
    }))
    expect(written).toBe(path.join(usb, 'For the accountant.tessera-backup'))
    expect(env.backupDisk.files.has(written)).toBe(true)
    // Outside the backup folder: not the book's last backup, since Tessera manages only that folder
    expect((await env.ask(BOOK_CHANNELS.backupsStatus)).lastBackupAt).toBeUndefined()
  })

  it('Back Up To… does nothing when the save dialog is cancelled', async () => {
    const env = await setup()
    await env.newBook()
    env.files.showSaveDialog.mockResolvedValueOnce(undefined)
    expect(await env.run(BOOK_COMMANDS.backupTo)).toBeUndefined()
    expect(env.backupDisk.writes).toEqual([])
  })

  it('a failure is shown in a message, and the book stays open', async () => {
    const env = await setup()
    await env.newBook()
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')
    expect(await env.run(BOOK_COMMANDS.backupNow)).toBeUndefined()
    expect(env.prompts.message).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'error', message: 'Could not back up the book.', detail: expect.stringContaining('ENOSPC')
    }))
    expect(env.session.current?.name).toBe('Home')
  })
})

describe('the failed-backup warning', () => {
  it('raises the status-bar warning when the last automatic backup failed, and lowers it when one succeeds', async () => {
    const env = await setup()
    await vi.waitFor(() => expect(env.key(BOOK_CONTEXT_KEYS.backupFailed)).toBe(false))

    env.backupDisk.failWrites = new Error('EIO')
    await env.newBook()
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(env.key(BOOK_CONTEXT_KEYS.backupFailed)).toBe(true))

    env.backupDisk.failWrites = undefined
    await env.session.open(file('Home.tessera'))
    await env.run(BOOK_COMMANDS.backupNow)
    await vi.waitFor(() => expect(env.key(BOOK_CONTEXT_KEYS.backupFailed)).toBe(false))
  })

  it('leads to the Backups page of the options dialog', async () => {
    const env = await setup()
    const opened: unknown[] = []
    createPluginContext('shell', env.runtime).context.commands.register('shell.options.open', (args: unknown) => { opened.push(args) })
    await env.run(BOOK_COMMANDS.backupSettings)
    expect(opened).toEqual([{ page: 'book.options.backups' }])
  })
})

describe('File › Restore from Backup…', () => {
  const DEFAULT_FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')
  const subBooks = async (env: Awaited<ReturnType<typeof setup>>) => (await env.session.tree()).subBooks.map(s => s.name).sort()

  /** A book with a sub-book "Before", backed up, then given "After". Resolves the backup's path. */
  const bookWithBackup = async (env: Awaited<ReturnType<typeof setup>>) => {
    await env.newBook()
    await env.session.createSubBook({ name: 'Before', parentId: null })
    const backup = await env.run(BOOK_COMMANDS.backupNow) as string
    await env.session.createSubBook({ name: 'After', parentId: null })
    env.prompts.message.mockClear()
    return backup
  }

  it('is on the File menu, always enabled: someone who lost a book may have none open', async () => {
    const env = await setup()
    expect(env.runtime.commands.isEnabled(BOOK_COMMANDS.restore)).toBe(true)
    const dialogs = resolveDialogs(env.runtime.extensions.getContributions('shell.dialogs'), () => 'x')
    expect(dialogs.dialogs.find(d => d.id === BOOK_DIALOGS.restore)).toMatchObject({ module: './RestoreDialog', size: 'md' })
  })

  it('shows the Restore dialog with the open book and the backup folder', async () => {
    const env = await setup()
    const book = await env.newBook() as BookInfo
    await env.run(BOOK_COMMANDS.restore)
    expect(env.prompts.show).toHaveBeenLastCalledWith(BOOK_DIALOGS.restore, {
      open: { id: book.id, name: 'Home', readOnly: false }, folder: DEFAULT_FOLDER
    })
  })

  it('does nothing when the dialog is cancelled', async () => {
    const env = await setup()
    await bookWithBackup(env)
    expect(await env.run(BOOK_COMMANDS.restore)).toBeUndefined()
    expect(await subBooks(env)).toEqual(['After', 'Before'])
  })

  it('replaces the open book after a destructive confirmation, and says what it did', async () => {
    const env = await setup()
    const backup = await bookWithBackup(env)
    env.prompts.show.mockResolvedValueOnce({ file: backup, target: 'replace' })

    const restored = await env.run(BOOK_COMMANDS.restore) as BookInfo
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.stringMatching(/^Replace “Home” with the backup from .+\?$/),
      detail: '“Home” as it is now is backed up first, then its file is moved to the Trash.',
      confirmLabel: 'Replace', destructive: true
    }))
    expect(restored.path).toBe(file('Home.tessera'))
    expect(await subBooks(env)).toEqual(['Before'])
    expect(env.trashed).toContain(file('Home.tessera'))
    const safety = [...env.backupDisk.files.keys()].find(f => f.includes('(before restore)'))
    expect(safety).toBeDefined()
    expect(env.prompts.message).toHaveBeenLastCalledWith({
      kind: 'info', message: expect.stringMatching(/^Restored “Home” from the backup of .+\.$/),
      detail: `The book as it was before was saved as “${path.basename(safety!)}” in ${DEFAULT_FOLDER}.`
    })
  })

  it('changes nothing when the replacement is not confirmed', async () => {
    const env = await setup()
    const backup = await bookWithBackup(env)
    env.prompts.show.mockResolvedValueOnce({ file: backup, target: 'replace' })
    env.answers.push(false)
    expect(await env.run(BOOK_COMMANDS.restore)).toBeUndefined()
    expect(await subBooks(env)).toEqual(['After', 'Before'])
    expect(env.trashed).toEqual([])
  })

  it('restores as a new book where the user says, suggesting a dated name beside the original', async () => {
    const env = await setup()
    const backup = await bookWithBackup(env)
    env.prompts.show.mockResolvedValueOnce({ file: backup, target: 'new' })
    env.files.showSaveDialog.mockResolvedValueOnce(file('A copy'))       // typed without the extension

    const restored = await env.run(BOOK_COMMANDS.restore) as BookInfo
    expect(env.files.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Restore as a New Book', buttonLabel: 'Restore',
      defaultPath: expect.stringMatching(new RegExp(`^${DIR.replace(/[\\\\/]/g, '[\\\\\\\\/]')}[\\\\\\\\/]Home \\(restored \\d{4}-\\d{2}-\\d{2}\\)\\.tessera$`))
    }))
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Close “Home” and open the restored copy?', detail: '“Home” is not changed.'
    }))
    expect(restored.path).toBe(file('A copy.tessera'))
    expect(await subBooks(env)).toEqual(['Before'])
    expect(env.trashed).toEqual([])
  })

  it('does nothing when the save dialog is cancelled', async () => {
    const env = await setup()
    const backup = await bookWithBackup(env)
    env.prompts.show.mockResolvedValueOnce({ file: backup, target: 'new' })
    env.files.showSaveDialog.mockResolvedValueOnce(undefined)
    expect(await env.run(BOOK_COMMANDS.restore)).toBeUndefined()
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await subBooks(env)).toEqual(['After', 'Before'])
  })

  it('shows why when the chosen file can’t be restored, and changes nothing', async () => {
    const env = await setup()
    await bookWithBackup(env)
    const junk = path.join(DEFAULT_FOLDER, 'Junk.tessera-backup')
    env.backupDisk.files.set(junk, { bytes: Buffer.from('not a backup'), modifiedAt: new Date() })
    env.prompts.show.mockResolvedValueOnce({ file: junk, target: 'replace' })

    expect(await env.run(BOOK_COMMANDS.restore)).toBeUndefined()
    expect(env.prompts.message).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'error', message: 'Could not restore the backup.', detail: 'This is not a Tessera backup.'
    }))
    expect(await subBooks(env)).toEqual(['After', 'Before'])
  })

  it('lists the backups in a folder for the dialog, and none for a folder that isn’t there', async () => {
    const env = await setup()
    expect(await env.ask(BOOK_CHANNELS.backupsList)).toEqual([])
    const backup = await bookWithBackup(env)
    expect(await env.ask(BOOK_CHANNELS.backupsList)).toEqual([expect.objectContaining({ file: backup, header: expect.objectContaining({ bookName: 'Home' }) })])
    expect(await env.ask(BOOK_CHANNELS.backupsList, { folder: path.resolve('/media/unplugged') })).toEqual([])
    await expect(env.ask(BOOK_CHANNELS.backupsList, { folder: 7 })).rejects.toThrow('folder must be a folder path')
  })

  it('picks a backup from anywhere, modal to the window that asked', async () => {
    const env = await setup()
    const backup = await bookWithBackup(env)
    env.files.showOpenDialog.mockResolvedValueOnce(backup).mockResolvedValueOnce(undefined)

    const reply = await env.runtime.ipc.dispatch({ channel: BOOK_CHANNELS.backupsChoose, data: undefined }, { windowId: 4 })
    expect(reply).toMatchObject({ ok: true, data: { file: backup, header: expect.objectContaining({ bookName: 'Home' }) } })
    expect(env.files.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Choose a Backup', defaultPath: DEFAULT_FOLDER, filters: [BACKUP_FILE_FILTER, { name: 'All files', extensions: ['*'] }], windowId: 4
    }))
    expect(await env.ask(BOOK_CHANNELS.backupsChoose)).toBeUndefined()
  })
})

describe('deleting a book forgets its backup bookkeeping', () => {
  const ledger = (env: Awaited<ReturnType<typeof setup>>) => (env.state.values.get('book.backups') ?? {}) as Record<string, unknown>

  it('drops the deleted book’s entry, keeps its backup files, and stops describing it', async () => {
    const env = await setup()
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')
    const book = await env.newBook() as BookInfo
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(env.key(BOOK_CONTEXT_KEYS.backupFailed)).toBe(true))
    expect(Object.keys(ledger(env))).toEqual([book.id])

    // A backup made earlier stays: someone who deletes a book may want it back
    env.backupDisk.failWrites = undefined
    await env.session.open(file('Home.tessera'))
    const backup = await env.run(BOOK_COMMANDS.backupNow) as string
    expect(await env.run(BOOK_COMMANDS.delete)).toBe(true)

    await vi.waitFor(() => expect(ledger(env)).toEqual({}))
    expect(env.backupDisk.files.has(backup)).toBe(true)
    await vi.waitFor(() => expect(env.last(BOOK_EVENTS.backups)).toEqual({ defaultFolder: expect.any(String) }))
    expect(env.key(BOOK_CONTEXT_KEYS.backupFailed)).toBe(false)
  })

  it('forgets a book deleted from the recent list without being open, and leaves other books’ entries', async () => {
    const env = await setup()
    const home = await env.newBook('Home.tessera') as BookInfo
    await env.run(BOOK_COMMANDS.close)
    const rental = await env.newBook('Rental.tessera') as BookInfo
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(Object.keys(ledger(env)).sort()).toEqual([home.id, rental.id].sort()))

    expect(await env.ask(BOOK_CHANNELS.delete, { path: file('Home.tessera') })).toBe(true)
    await vi.waitFor(() => expect(Object.keys(ledger(env))).toEqual([rental.id]))
  })

  it('keeps the entry when the delete is not confirmed', async () => {
    const env = await setup()
    const book = await env.newBook() as BookInfo
    await env.run(BOOK_COMMANDS.close)
    await vi.waitFor(() => expect(Object.keys(ledger(env))).toEqual([book.id]))
    env.answers.push(false)
    expect(await env.ask(BOOK_CHANNELS.delete, { path: file('Home.tessera') })).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(Object.keys(ledger(env))).toEqual([book.id])
  })
})
