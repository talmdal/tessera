import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, BorderItemDescriptor, LayoutState, PersistedLayout } from '@tessera/types'
import { LayoutService } from '../../core/layout/LayoutService'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import {
  BAR_ITEMS_CHANGED,
  BAR_ITEMS_EXTENSION_POINT,
  BAR_ITEMS_LIST_CHANNEL,
  LAYOUT_CHANGED,
  LAYOUT_COMMANDS,
  LAYOUT_GET,
  LAYOUT_RESET,
  LAYOUT_REVEAL,
  LAYOUT_REVEALED,
  LAYOUT_SLOT_SET,
  layoutKey
} from '../../shared/layout/types'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { MENUS_EXTENSION_POINT, VIEW_MENU } from '../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { COMMANDS_EXECUTE } from '../../shared/shellEvents'
import { VIEWS_EXTENSION_POINT } from '../../shared/views/types'
import { registerCommandsIpc } from '../../shell/main/commands/commandsIpc'
import { createAppStatePersistence, layoutStateKey } from '../../shell/main/layout/appStatePersistence'
import { registerLayout } from '../../shell/main/layout/registerLayout'
import { memoryPersistence } from '../helpers/layout'
import { createLogger } from '../helpers/runtime'

const iconUrlFor = (pluginId: string, relative: string) => `tessera-plugin://${pluginId}/${relative}`

function setup(saved: Record<string, PersistedLayout> = {}) {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const { store, persistence } = memoryPersistence(saved)
  const layout = new LayoutService(runtime.extensions, runtime.contextKeys,
    { remoteEntryFor: () => 'tessera-plugin://p/remoteEntry.js', iconUrlFor }, { persistence, log, saveDelayMs: 500 })
  const host = registerLayout(shell, runtime, layout, iconUrlFor)
  registerCommandsIpc(shell, log)

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const contribute = (id: string, slot: string, extra: Record<string, unknown> = {}) =>
    runtime.extensions.contribute('p', VIEWS_EXTENSION_POINT, id, {
      id, title: id, slot, module: './V', ...(slot !== 'shell.main' && { icon: 'Home' }), ...extra
    })
  const contributeItem = (id: string, extra: Record<string, unknown> = {}) =>
    runtime.extensions.contribute('p', BAR_ITEMS_EXTENSION_POINT, id, { kind: 'button', id, slot: 'shell.top', label: id, command: 'p.run', ...extra })

  /** A request as the Electron adapter would deliver it: attributed to a window by the main process. */
  const ask = (channel: string, data?: unknown, windowId?: number) =>
    runtime.ipc.dispatch({ channel, data }, windowId === undefined ? undefined : { windowId })
  const layoutEvents = (name = LAYOUT_CHANGED) => events.filter(e => e.name === name).map(e => e.data)

  return { runtime, layout, host, log, store, persistence, events, layoutEvents, contribute, contributeItem, ask }
}

describe('registerLayout: requests', () => {
  it('answers a window with its own layout', async () => {
    const { host, ask, contribute } = setup()
    contribute('accounts', 'shell.left')
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    await ask(LAYOUT_SLOT_SET, { slot: 'shell.left', collapsed: true }, 2)

    const first = await ask(LAYOUT_GET, undefined, 1)
    const second = await ask(LAYOUT_GET, undefined, 2)

    expect(first).toMatchObject({ ok: true, data: { windowId: 1, bars: { left: { views: ['accounts'], collapsed: false } } } })
    expect(second).toMatchObject({ ok: true, data: { windowId: 2, bars: { left: { collapsed: true } } } })
  })

  it('applies a gesture to the sending window only, and replies with the new state', async () => {
    const { host, layout, ask } = setup()
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')

    const response = await ask(LAYOUT_SLOT_SET, { slot: 'shell.right', collapsed: true, size: 410 }, 2)

    expect(response).toMatchObject({ ok: true, data: { windowId: 2, bars: { right: { collapsed: true, size: 410 } } } })
    expect(layout.get(1).bars.right.collapsed).toBe(false)
  })

  it('rejects a request from a window the controller does not know, or from no window', async () => {
    const { host, ask } = setup()
    await host.attachWindow(1, 'main')

    for (const channel of [LAYOUT_GET, LAYOUT_SLOT_SET, LAYOUT_RESET, LAYOUT_REVEAL]) {
      await expect(ask(channel, {}, 5)).resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'Unknown window: 5' } })
      await expect(ask(channel, {})).resolves.toMatchObject({ ok: false, error: { message: 'Unknown window: undefined' } })
    }
  })

  it('reports an invalid gesture as a handler error naming the problem', async () => {
    const { host, ask } = setup()
    await host.attachWindow(1, 'main')

    await expect(ask(LAYOUT_SLOT_SET, { slot: 'shell.nowhere' }, 1))
      .resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'Unknown slot: shell.nowhere' } })
    await expect(ask(LAYOUT_SLOT_SET, undefined, 1)).resolves.toMatchObject({ ok: false, error: { message: 'A slot is required' } })
  })

  it('resets the sending window only', async () => {
    const { host, layout, ask } = setup()
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    layout.setSlot(1, { slot: 'shell.top', size: 300 })
    layout.setSlot(2, { slot: 'shell.top', size: 300 })

    const response = await ask(LAYOUT_RESET, undefined, 1)

    expect(response).toMatchObject({ ok: true, data: { bars: { top: { size: 120 } } } })
    expect(layout.get(2).bars.top.size).toBe(300)
  })

  it('reveals a view for the sending window, and rejects one that is not there', async () => {
    const { host, ask, contribute } = setup()
    contribute('home', 'shell.main')
    contribute('register', 'shell.main')
    await host.attachWindow(1, 'main')

    await expect(ask(LAYOUT_REVEAL, { viewId: 'register' }, 1)).resolves.toMatchObject({ ok: true, data: { main: { activeView: 'register' } } })
    await expect(ask(LAYOUT_REVEAL, { viewId: 'ghost' }, 1))
      .resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'View "ghost" is not present' } })
    await expect(ask(LAYOUT_REVEAL, undefined, 1)).resolves.toMatchObject({ ok: false })
  })
})

describe('registerLayout: events', () => {
  it('publishes a window\'s new state as a push event when it changes', async () => {
    const { host, layoutEvents, ask, contribute } = setup()
    await host.attachWindow(1, 'main')
    const before = layoutEvents().length

    await ask(LAYOUT_SLOT_SET, { slot: 'shell.top', collapsed: true }, 1)
    contribute('toolbar', 'shell.top')

    const states = layoutEvents().slice(before) as LayoutState[]
    expect(states).toHaveLength(2)
    expect(states[0]).toMatchObject({ windowId: 1, bars: { top: { collapsed: true, views: [] } } })
    expect(states[1]).toMatchObject({ windowId: 1, bars: { top: { collapsed: true, views: ['toolbar'] } } })
  })

  it('publishes nothing for a gesture that changes nothing', async () => {
    const { host, events, ask } = setup()
    await host.attachWindow(1, 'main')
    events.length = 0

    await ask(LAYOUT_SLOT_SET, { slot: 'shell.top', collapsed: false }, 1)

    expect(events.filter(e => e.name === LAYOUT_CHANGED)).toEqual([])
  })

  it('publishes the reveal after the state change that shows the view', async () => {
    const { host, events, ask, contribute } = setup()
    contribute('a', 'shell.right')
    contribute('b', 'shell.right')
    await host.attachWindow(1, 'main')
    events.length = 0

    await ask(LAYOUT_REVEAL, { viewId: 'b' }, 1)

    expect(events.map(e => e.name)).toEqual([LAYOUT_CHANGED, LAYOUT_REVEALED])
    expect(events[1].data).toEqual({ windowId: 1, viewId: 'b', slot: 'shell.right' })
  })
})

describe('registerLayout: commands', () => {
  it('registers the layout commands under the shell\'s name', () => {
    const { runtime } = setup()

    for (const id of [...Object.values(LAYOUT_COMMANDS.toggle), LAYOUT_COMMANDS.collapseAll, LAYOUT_COMMANDS.expandAll, LAYOUT_COMMANDS.reset, LAYOUT_COMMANDS.reveal]) {
      expect(runtime.commands.has(id)).toBe(true)
    }
  })

  it('acts on the focused window', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')

    host.focus(2)
    await runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)

    expect(layout.get(2).bars.left.collapsed).toBe(true)
    expect(layout.get(1).bars.left.collapsed).toBe(false)
  })

  it('falls back to the primary window when none has focus, or the focused one has closed', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(2, 'window-2')
    await host.attachWindow(1, 'main')

    await runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)
    expect(layout.get(1).bars.left.collapsed).toBe(true)

    host.focus(2)
    await host.detachWindow(2)
    await runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)
    expect(layout.get(1).bars.left.collapsed).toBe(false)
  })

  it('falls back to the oldest window when there is no primary one', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(4, 'window-2')

    await runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)

    expect(layout.get(4).bars.left.collapsed).toBe(true)
  })

  it('ignores focus on a window it does not know', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(1, 'main')

    host.focus(99)
    await runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)

    expect(layout.get(1).bars.left.collapsed).toBe(true)
  })

  it('has no window to act on until one is attached', async () => {
    const { runtime } = setup()

    await expect(runtime.commands.execute(LAYOUT_COMMANDS.collapseAll)).rejects.toThrow('There is no window')
  })

  it('enables a bar\'s toggle only while the bar has content', async () => {
    const { host, runtime, contribute, contributeItem } = setup()
    await host.attachWindow(1, 'main')
    expect(runtime.commands.isEnabled(LAYOUT_COMMANDS.toggle.left)).toBe(false)
    await expect(runtime.commands.execute(LAYOUT_COMMANDS.toggle.left)).rejects.toThrow(`Command is disabled: ${LAYOUT_COMMANDS.toggle.left}`)

    const view = contribute('a', 'shell.left')
    contributeItem('b', { slot: 'shell.top' })
    expect(runtime.commands.isEnabled(LAYOUT_COMMANDS.toggle.left)).toBe(true)
    expect(runtime.commands.isEnabled(LAYOUT_COMMANDS.toggle.top)).toBe(true)
    expect(runtime.commands.isEnabled(LAYOUT_COMMANDS.toggle.right)).toBe(false)

    view.dispose()
    expect(runtime.commands.isEnabled(LAYOUT_COMMANDS.toggle.left)).toBe(false)
  })

  it('collapses and expands every bar with content, and resets', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    contribute('b', 'shell.bottom')
    await host.attachWindow(1, 'main')
    layout.setSlot(1, { slot: 'shell.left', size: 400 })

    await runtime.commands.execute(LAYOUT_COMMANDS.collapseAll)
    expect([layout.get(1).bars.left.collapsed, layout.get(1).bars.bottom.collapsed]).toEqual([true, true])

    await runtime.commands.execute(LAYOUT_COMMANDS.expandAll)
    expect([layout.get(1).bars.left.collapsed, layout.get(1).bars.bottom.collapsed]).toEqual([false, false])

    await runtime.commands.execute(LAYOUT_COMMANDS.reset)
    expect(layout.get(1).bars.left.size).toBe(260)
  })

  it('reveals a view named by its argument, so a plugin\'s navigation command can delegate to it', async () => {
    const { host, layout, runtime, contribute } = setup()
    contribute('home', 'shell.main')
    contribute('register', 'shell.main')
    await host.attachWindow(1, 'main')

    await runtime.commands.execute(LAYOUT_COMMANDS.reveal, 'register')

    expect(layout.get(1).main.activeView).toBe('register')
  })

  it('treats revealing a view that is not there as a no-op with a warning', async () => {
    const { host, layout, runtime, log } = setup()
    await host.attachWindow(1, 'main')

    await expect(runtime.commands.execute(LAYOUT_COMMANDS.reveal, 'ghost')).resolves.toBeUndefined()

    expect(log.warn).toHaveBeenCalledWith('[layout] Could not reveal ghost: View "ghost" is not present')
    expect(layout.get(1).main.activeView).toBeUndefined()
  })
})

describe('registerLayout: context keys', () => {
  it('sets whether each bar has content, even before any window exists', () => {
    const { runtime, contribute } = setup()
    expect(runtime.contextKeys.get(layoutKey.hasContent('left'))).toBe(false)

    const view = contribute('a', 'shell.left')
    expect(runtime.contextKeys.get(layoutKey.hasContent('left'))).toBe(true)
    expect(runtime.contextKeys.get(layoutKey.hasContent('right'))).toBe(false)

    view.dispose()
    expect(runtime.contextKeys.get(layoutKey.hasContent('left'))).toBe(false)
  })

  it('describes the focused window: collapsed, visible, active view and the active main view', async () => {
    const { host, runtime, contribute, layout } = setup()
    contribute('a', 'shell.left')
    contribute('b', 'shell.left')
    contribute('home', 'shell.main')
    await host.attachWindow(1, 'main')
    const get = (key: string) => runtime.contextKeys.get(key)

    expect(get(layoutKey.collapsed('left'))).toBe(false)
    expect(get(layoutKey.visible('left'))).toBe(true)
    expect(get(layoutKey.activeView('left'))).toBe('a')
    expect(get(layoutKey.mainActiveView)).toBe('home')

    layout.setSlot(1, { slot: 'shell.left', collapsed: true, activeView: 'b' })
    expect(get(layoutKey.collapsed('left'))).toBe(true)
    expect(get(layoutKey.visible('left'))).toBe(false)
    expect(get(layoutKey.activeView('left'))).toBe('b')

    expect(get(layoutKey.visible('right'))).toBe(false)        // no content: hidden, not just collapsed
    expect(get(layoutKey.activeView('right'))).toBeUndefined()
  })

  it('follows the window that has focus', async () => {
    const { host, runtime, layout, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    layout.setSlot(2, { slot: 'shell.left', collapsed: true })
    expect(runtime.contextKeys.get(layoutKey.collapsed('left'))).toBe(false)     // the primary window, none focused

    host.focus(2)
    expect(runtime.contextKeys.get(layoutKey.collapsed('left'))).toBe(true)

    host.focus(1)
    expect(runtime.contextKeys.get(layoutKey.collapsed('left'))).toBe(false)
  })

  it('unsets the window\'s keys once its window is gone, keeping whether bars have content', async () => {
    const { host, runtime, contribute } = setup()
    contribute('a', 'shell.left')
    await host.attachWindow(1, 'main')

    await host.detachWindow(1)

    expect(runtime.contextKeys.get(layoutKey.collapsed('left'))).toBeUndefined()
    expect(runtime.contextKeys.get(layoutKey.activeView('left'))).toBeUndefined()
    expect(runtime.contextKeys.get(layoutKey.hasContent('left'))).toBe(true)
  })

  it('lets a plugin\'s view depend on the layout', async () => {
    const { host, layout, contribute } = setup()
    contribute('a', 'shell.left')
    contribute('details', 'shell.right', { when: "shell.layout.main.activeView == 'register'" })
    contribute('home', 'shell.main')
    contribute('register', 'shell.main')
    await host.attachWindow(1, 'main')
    expect(layout.get(1).bars.right.views).toEqual([])

    layout.reveal(1, 'register')

    expect(layout.get(1).bars.right.views).toEqual(['details'])
  })
})

describe('registerLayout: the View menu', () => {
  it('is contributed between File and the plugins\' menus, with every item bound to a registered command', () => {
    const { runtime } = setup()
    const contributions = runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)

    const { menus, diagnostics } = resolveMenus([
      { kind: 'menu', id: 'shell.file', label: 'File' }, { kind: 'menu', id: 'shell.tools', label: 'Tools' }, { kind: 'menu', id: 'shell.help', label: 'Help' },
      ...contributions
    ])
    const view = menus.find(m => m.id === VIEW_MENU)!

    expect(diagnostics).toEqual([])
    expect(menus.map(m => m.id).slice(0, 2)).toEqual(['shell.file', VIEW_MENU])
    const items = view.children.flatMap(node => node.type === 'item' ? [node] : [])
    expect(items.map(i => i.label)).toEqual([
      'Toggle &Left Bar', 'Toggle &Right Bar', 'Toggle &Top Bar', 'Toggle &Bottom Bar', '&Expand All Bars', '&Collapse All Bars', 'Reset La&yout'
    ])
    expect(items.map(i => i.accelerator)).toEqual(['CmdOrCtrl+B', 'CmdOrCtrl+Alt+B', undefined, 'CmdOrCtrl+J', undefined, undefined, undefined])
    for (const item of items) expect(runtime.commands.has(item.command)).toBe(true)
  })

  it('separates the bar toggles from expand, collapse and reset', () => {
    const { runtime } = setup()
    const { menus } = resolveMenus([
      { kind: 'menu', id: 'shell.file', label: 'File' },
      ...runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)
    ])
    const view = menus.find(m => m.id === VIEW_MENU)!

    expect(view.children.filter(node => node.type === 'separator').length).toBeGreaterThanOrEqual(3)
  })
})

describe('registerLayout: bar items', () => {
  it('lists items with their command\'s enablement and resolved icons', async () => {
    const { runtime, ask, contributeItem } = setup()
    runtime.commands.register('p.on', () => {})
    runtime.commands.register('p.off', () => {}, { enablement: 'never' })
    contributeItem('on', { command: 'p.on', icon: './icons/on.svg' })
    contributeItem('off', { command: 'p.off', icon: 'Save' })
    contributeItem('text', { kind: 'text', text: 'Ready', command: undefined, label: undefined, slot: 'shell.bottom' })
    contributeItem('text-cmd', { kind: 'text', text: 'Open', command: 'p.off', label: undefined, slot: 'shell.bottom' })

    const response = await ask(BAR_ITEMS_LIST_CHANNEL)

    const items = (response as any).data as BorderItemDescriptor[]
    expect(items.map(i => [i.id, i.enabled])).toEqual([['on', true], ['off', false], ['text', true], ['text-cmd', false]])
    expect(items[0]).toMatchObject({ pluginId: 'p', icon: 'tessera-plugin://p/icons/on.svg' })
    expect(items[1].icon).toBe('Save')
  })

  it('treats a button whose command does not exist as disabled', async () => {
    const { ask, contributeItem } = setup()
    contributeItem('orphan', { command: 'p.missing' })

    expect(((await ask(BAR_ITEMS_LIST_CHANNEL)) as any).data[0]).toMatchObject({ id: 'orphan', enabled: false })
  })

  it('warns about invalid items and leaves them out', async () => {
    const { ask, contributeItem, log } = setup()
    contributeItem('bad', { slot: 'shell.main' })

    expect(((await ask(BAR_ITEMS_LIST_CHANNEL)) as any).data).toEqual([])
    expect(log.warn).toHaveBeenCalledWith('[layout] Bar item "bad" must target a bar slot, not "shell.main"')
  })

  it('announces a change when an item is contributed or removed, and for nothing else', () => {
    const { runtime, events, contributeItem, contribute } = setup()
    runtime.commands.register('p.on', () => {})
    events.length = 0

    contribute('v', 'shell.left')
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toEqual([])

    const registration = contributeItem('a', { command: 'p.on' })
    registration.dispose()
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toHaveLength(2)
  })

  it('announces a change when a button\'s command becomes enabled or disabled, and not when nothing flips', () => {
    const { runtime, events, contributeItem } = setup()
    runtime.commands.register('p.save', () => {}, { enablement: 'vault.isDirty' })
    contributeItem('save', { command: 'p.save' })
    events.length = 0

    runtime.contextKeys.set('unrelated', 1)
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toEqual([])

    runtime.contextKeys.set('vault.isDirty', true)
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toHaveLength(1)

    runtime.contextKeys.set('vault.isDirty', true)       // same value
    runtime.contextKeys.set('other', true)
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toHaveLength(1)

    runtime.contextKeys.set('vault.isDirty', false)
    expect(events.filter(e => e.name === BAR_ITEMS_CHANGED)).toHaveLength(2)
  })
})

describe('registerCommandsIpc', () => {
  it('runs a command with its arguments and returns its result', async () => {
    const { runtime, ask, log } = setup()
    runtime.commands.register('p.add', (a, b) => (a as number) + (b as number))

    const response = await ask(COMMANDS_EXECUTE, { id: 'p.add', args: [2, 3] }, 4)

    expect(response).toMatchObject({ ok: true, data: 5 })
    expect(log.info).toHaveBeenCalledWith('[commands] 4 executed p.add')
  })

  it('runs a command that takes no arguments', async () => {
    const { runtime, ask } = setup()
    const run = vi.fn(() => 'done')
    runtime.commands.register('p.run', run)

    await expect(ask(COMMANDS_EXECUTE, { id: 'p.run' }, 1)).resolves.toMatchObject({ ok: true, data: 'done' })
    expect(run).toHaveBeenCalledWith()
  })

  it('rejects a disabled command, an unknown one, and one that throws', async () => {
    const { runtime, ask } = setup()
    runtime.commands.register('p.off', () => {}, { enablement: 'never' })
    runtime.commands.register('p.boom', () => { throw new Error('kaboom') })

    await expect(ask(COMMANDS_EXECUTE, { id: 'p.off' }, 1)).resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'Command is disabled: p.off' } })
    await expect(ask(COMMANDS_EXECUTE, { id: 'p.none' }, 1)).resolves.toMatchObject({ ok: false, error: { message: 'Unknown command: p.none' } })
    await expect(ask(COMMANDS_EXECUTE, { id: 'p.boom' }, 1)).resolves.toMatchObject({ ok: false, error: { message: 'kaboom' } })
  })

  it('rejects a malformed request', async () => {
    const { ask } = setup()

    await expect(ask(COMMANDS_EXECUTE, undefined, 1)).resolves.toMatchObject({ ok: false, error: { message: 'A command id is required' } })
    await expect(ask(COMMANDS_EXECUTE, { id: '' }, 1)).resolves.toMatchObject({ ok: false, error: { message: 'A command id is required' } })
    await expect(ask(COMMANDS_EXECUTE, { id: 3 }, 1)).resolves.toMatchObject({ ok: false, error: { message: 'A command id is required' } })
    await expect(ask(COMMANDS_EXECUTE, { id: 'x', args: 'no' }, 1)).resolves.toMatchObject({ ok: false, error: { message: 'args must be an array' } })
  })

  it('can run the layout commands for a view in the renderer', async () => {
    const { host, layout, ask } = setup()
    await host.attachWindow(1, 'main')

    await ask(COMMANDS_EXECUTE, { id: LAYOUT_COMMANDS.reset }, 1)

    expect(layout.isAttached(1)).toBe(true)
  })
})

describe('registerLayout: persistence', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts the primary window from its saved layout before it loads', async () => {
    const { host, ask } = setup({ main: { bars: { left: { collapsed: true, size: 333 } } } })

    const state = await host.attachWindow(1, 'main')

    expect(state.bars.left).toMatchObject({ collapsed: true, size: 333 })
    await expect(ask(LAYOUT_GET, undefined, 1)).resolves.toMatchObject({ data: { bars: { left: { collapsed: true, size: 333 } } } })
  })

  it('starts a second window from the primary window\'s current layout', async () => {
    const { host, layout } = setup()
    await host.attachWindow(1, 'main')
    layout.setSlot(1, { slot: 'shell.right', size: 450 })

    const second = await host.attachWindow(2, 'window-2')

    expect(second.bars.right.size).toBe(450)
  })

  it('saves the layout of a window when it closes', async () => {
    const { host, layout, store } = setup()
    await host.attachWindow(1, 'main')
    layout.setSlot(1, { slot: 'shell.left', collapsed: true })

    await host.detachWindow(1)

    expect(store.get('main')?.bars?.left?.collapsed).toBe(true)
  })

  it('saves pending changes when the application shuts down', async () => {
    const { host, layout, runtime, store } = setup()
    await host.attachWindow(1, 'main')
    layout.setSlot(1, { slot: 'shell.left', size: 321 })
    expect(store.has('main')).toBe(false)

    await runtime.lifecycle.requestShutdown('system')

    expect(store.get('main')?.bars?.left?.size).toBe(321)
  })
})

describe('createAppStatePersistence', () => {
  const fakeAppState = () => {
    const data = new Map<string, unknown>()
    const appState = {
      get: vi.fn(async (key: string) => data.get(key)),
      set: vi.fn(async (key: string, value: unknown) => { data.set(key, value) }),
      update: vi.fn(),
      remove: vi.fn()
    } as unknown as AppState
    return { data, appState }
  }

  it('keeps each window under its own app.state key', async () => {
    const { data, appState } = fakeAppState()
    const persistence = createAppStatePersistence(() => appState)

    await persistence.save('main', { bars: { left: { size: 300 } } })
    await persistence.save('window-2', { bars: { left: { size: 200 } } })

    expect([...data.keys()]).toEqual(['shell.layout.main', 'shell.layout.window-2'])
    expect(layoutStateKey('main')).toBe('shell.layout.main')
    await expect(persistence.load('main')).resolves.toEqual({ bars: { left: { size: 300 } } })
    await expect(persistence.load('window-3')).resolves.toBeUndefined()
  })

  it('looks the service up on every use, so it works once the app-state plugin has activated', async () => {
    const { appState } = fakeAppState()
    let available: AppState | undefined
    const persistence = createAppStatePersistence(() => available)

    await expect(persistence.load('main')).resolves.toBeUndefined()
    await expect(persistence.save('main', {})).resolves.toBeUndefined()

    available = appState
    await persistence.save('main', { main: { activeView: 'x' } })
    await expect(persistence.load('main')).resolves.toEqual({ main: { activeView: 'x' } })
  })

  it('lets a failing store reject, for the controller to report', async () => {
    const appState = { get: vi.fn(async () => { throw new Error('db') }), set: vi.fn(async () => { throw new Error('db') }) } as unknown as AppState
    const persistence = createAppStatePersistence(() => appState)

    await expect(persistence.load('main')).rejects.toThrow('db')
    await expect(persistence.save('main', {})).rejects.toThrow('db')
  })
})
