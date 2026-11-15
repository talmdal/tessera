// @vitest-environment node
// The options dialog's main-process half: the command, its menu item, and the page tree the dialog asks for.
import { describe, it, expect, vi } from 'vitest'
import { MENUS_EXTENSION_POINT, TOOLS_MENU } from '../../shared/menus/types'
import { normalizeMenuNodes } from '../../shared/menus/normalize'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import {
  OPTIONS_CATEGORIES, OPTIONS_CLOSED, OPTIONS_COMMANDS, OPTIONS_COMMIT, OPTIONS_EXTENSION_POINT, OPTIONS_GET,
  OPTIONS_OPEN, OPTIONS_PAGES
} from '../../shared/options/types'
import type { OptionsPageNode } from '../../shared/options/types'
import { OptionsService } from '../../core/options/OptionsService'
import { createMemoryOptionsStore } from '../../core/options/memoryOptionsStore'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { registerOptions } from '../../shell/main/options/registerOptions'
import { createLogger } from '../helpers/runtime'

function setup(over: { windows?: number[] } = {}) {
  const { windows = [7] } = over
  const log = createLogger()
  const options = new OptionsService(createMemoryOptionsStore(), { log })
  const runtime = createPluginRuntime(undefined, log, options)
  const shell = createPluginContext('shell', runtime).context
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  let minted = 0
  registerOptions(shell, runtime, {
    options,
    remoteEntryFor: pluginId => pluginId === 'noui' ? undefined : `tessera-plugin://${pluginId}/remoteEntry.js`,
    targetWindow: () => windows[0],
    log,
    newSessionId: () => `session-${++minted}`
  })

  const ask = async (channel: string, data?: unknown, ...sender: [{ windowId: number } | undefined] | []) => {
    const reply = await runtime.ipc.dispatch({ channel, data }, sender.length ? sender[0] : { windowId: 7 })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }

  /** Runs the open command and returns the session the event carried. */
  const opened = async () => {
    await runtime.commands.execute(OPTIONS_COMMANDS.open)
    return (events.filter(e => e.name === OPTIONS_OPEN).at(-1)!.data as { session: string }).session
  }

  const contribute = (contributor: string, impl: Record<string, unknown>) =>
    runtime.extensions.contribute(contributor, OPTIONS_EXTENSION_POINT, String(impl.id), impl)

  return { runtime, shell, events, log, options, ask, opened, contribute }
}

const BACKUP_DEFAULTS = { autoBackup: true, backup: { count: 5 } }

describe('opening the options dialog', () => {
  it('registers the command the Tools menu item runs', async () => {
    const { runtime } = setup()
    expect(runtime.commands.has(OPTIONS_COMMANDS.open)).toBe(true)
  })

  it('asks the focused window to open it, since the dialog is drawn in the window itself', async () => {
    const { runtime, events } = setup({ windows: [7] })

    await runtime.commands.execute(OPTIONS_COMMANDS.open)

    expect(events).toContainEqual({ name: OPTIONS_OPEN, data: { windowId: 7, session: 'session-1' } })
  })

  it('says so plainly when there is no window to open it in', async () => {
    const { runtime } = setup({ windows: [] })

    await expect(runtime.commands.execute(OPTIONS_COMMANDS.open)).rejects.toThrow(/no window/)
  })

  it('puts Options… in the Tools menu, above the developer tools, with Ctrl+,', () => {
    const { runtime } = setup()

    const { menus, diagnostics } = resolveMenus([
      { kind: 'menu', id: TOOLS_MENU, label: '&Tools' },
      ...runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)
    ])
    expect(diagnostics).toEqual([])
    const tools = normalizeMenuNodes(menus.find(menu => menu.id === TOOLS_MENU)!.children)
    const items = tools.filter(node => node.type === 'item') as { label: string, accelerator?: string, command: string }[]

    expect(items.map(item => item.label)).toContain('&Options…')
    const options = items.find(item => item.label === '&Options…')!
    expect(options.accelerator).toBe('CmdOrCtrl+,')
    expect(options.command).toBe(OPTIONS_COMMANDS.open)
  })
})

describe('the page tree the dialog asks for', () => {
  it('offers the shell categories, so a plugin always has somewhere to nest', async () => {
    const { ask } = setup()

    expect((await ask(OPTIONS_PAGES)).map(page => page.id))
      .toEqual([OPTIONS_CATEGORIES.general, OPTIONS_CATEGORIES.appearance])
  })

  it('includes a plugin page, nested where it asked to be', async () => {
    const { ask, contribute } = setup()
    contribute('book', { id: 'book.options', title: 'Book', parent: OPTIONS_CATEGORIES.general, module: './BookOptions' })

    const general = (await ask(OPTIONS_PAGES)).find(page => page.id === OPTIONS_CATEGORIES.general)!

    expect(general.children).toEqual([expect.objectContaining({
      id: 'book.options', title: 'Book', pluginId: 'book', module: './BookOptions',
      remoteEntry: 'tessera-plugin://book/remoteEntry.js'
    })])
  })

  it('is resolved per request, so a plugin that activates later still appears', async () => {
    const { ask, contribute } = setup()
    expect(await ask(OPTIONS_PAGES)).toHaveLength(2)

    contribute('book', { id: 'book.options', title: 'Book' })

    expect(await ask(OPTIONS_PAGES)).toHaveLength(3)
  })

  it('skips an invalid contribution with a warning, and still answers', async () => {
    const { ask, contribute, log } = setup()
    contribute('book', { id: 'ledger.sneaky', title: 'Not mine' })

    expect((await ask(OPTIONS_PAGES)).map(page => page.id)).not.toContain('ledger.sneaky')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[options]'))
  })

  it('answers only a request that came from a window', async () => {
    const { ask } = setup()

    await expect(ask(OPTIONS_PAGES, undefined, undefined)).rejects.toThrow(/only be read by a window/)
    await expect(ask(OPTIONS_PAGES, undefined, { windowId: -1 })).rejects.toThrow(/only be read by a window/)
    await expect(ask(OPTIONS_PAGES, undefined, { windowId: 7 })).resolves.toBeDefined()
  })
})

describe('the dialog session', () => {
  it('reads a namespace with the session the open event carried', async () => {
    const { runtime, opened, ask } = setup()
    createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const session = await opened()

    expect(await ask(OPTIONS_GET, { session, namespace: 'book' }))
      .toEqual({ value: BACKUP_DEFAULTS, defaults: BACKUP_DEFAULTS })
  })

  it('answers null for a namespace nothing registered, so the dialog can say so', async () => {
    const { opened, ask } = setup()
    const session = await opened()

    expect(await ask(OPTIONS_GET, { session, namespace: 'ghost' })).toBeNull()
  })

  it.each([
    ['no session', {}],
    ['a session nobody minted', { session: 'made-up' }]
  ])('refuses a read with %s', async (_label, data) => {
    const { opened, ask } = setup()
    await opened()

    await expect(ask(OPTIONS_GET, { ...data, namespace: 'book' })).rejects.toThrow(/only be edited by the options dialog/)
  })

  it('refuses a session used from a window it does not belong to', async () => {
    const { runtime, opened, ask } = setup()
    createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const session = await opened()      // minted for window 7

    await expect(ask(OPTIONS_GET, { session, namespace: 'book' }, { windowId: 8 }))
      .rejects.toThrow(/only be edited by the options dialog/)
  })

  it('ends the session when the dialog closes', async () => {
    const { runtime, opened, ask } = setup()
    createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const session = await opened()

    await ask(OPTIONS_CLOSED, { session })

    await expect(ask(OPTIONS_GET, { session, namespace: 'book' })).rejects.toThrow(/only be edited/)
  })

  it('keeps the session when the dialog is asked for again in the same window, so nothing pending is stranded', async () => {
    const { runtime, opened, ask } = setup()
    createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const first = await opened()
    const again = await opened()

    expect(again).toBe(first)
    await expect(ask(OPTIONS_GET, { session: first, namespace: 'book' })).resolves.toBeDefined()
  })

  it('mints a new session once the dialog has closed', async () => {
    const { runtime, opened, ask } = setup()
    createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const first = await opened()
    await ask(OPTIONS_CLOSED, { session: first })

    const second = await opened()

    expect(second).not.toBe(first)
    await expect(ask(OPTIONS_GET, { session: first, namespace: 'book' })).rejects.toThrow(/only be edited/)
    await expect(ask(OPTIONS_GET, { session: second, namespace: 'book' })).resolves.toBeDefined()
  })
})

describe('committing through the dialog', () => {
  it('saves each namespace on its own, answering its validation messages', async () => {
    const { runtime, options, opened, ask } = setup()
    const book = createPluginContext('book', runtime).context.options.register({
      defaults: BACKUP_DEFAULTS,
      validate: (value: typeof BACKUP_DEFAULTS) => value.backup.count >= 1 ? [] : ['Keep at least one backup']
    })
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    const session = await opened()

    const results = await ask(OPTIONS_COMMIT, {
      session,
      changes: {
        book: { autoBackup: false, backup: { count: 0 } },      // invalid: refused with its message
        ledger: { tidy: true }                                  // valid: saved
      }
    })

    expect(results).toEqual({ book: ['Keep at least one backup'], ledger: [] })
    expect(book.get().backup.count).toBe(5)
    expect(options.get('ledger')).toEqual({ tidy: true })
  })

  it('answers a message, not a crash, for a namespace nothing registered', async () => {
    const { opened, ask } = setup()
    const session = await opened()

    expect(await ask(OPTIONS_COMMIT, { session, changes: { ghost: { a: 1 } } }))
      .toEqual({ ghost: [expect.stringMatching(/No options are registered/)] })
  })

  it('tells the owning plugin, which sees the new value at once', async () => {
    const { runtime, opened, ask } = setup()
    const handle = createPluginContext('book', runtime).context.options.register({ defaults: BACKUP_DEFAULTS })
    const heard = vi.fn()
    handle.onDidChange(heard)
    const session = await opened()

    await ask(OPTIONS_COMMIT, { session, changes: { book: { autoBackup: false, backup: { count: 5 } } } })

    expect(heard).toHaveBeenCalledWith({ autoBackup: false, backup: { count: 5 } }, BACKUP_DEFAULTS)
  })

  it('refuses a commit without a live session, whatever it carries', async () => {
    const { opened, ask } = setup()
    const session = await opened()
    await ask(OPTIONS_CLOSED, { session })

    await expect(ask(OPTIONS_COMMIT, { session, changes: { book: {} } })).rejects.toThrow(/only be edited/)
  })

  it('refuses a malformed commit', async () => {
    const { opened, ask } = setup()
    const session = await opened()

    await expect(ask(OPTIONS_COMMIT, { session, changes: [] })).rejects.toThrow(/Malformed commit/)
  })
})
