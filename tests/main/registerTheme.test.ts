import { describe, expect, it, vi } from 'vitest'
import type { AppState, ThemeSnapshot, ThemeState } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { ThemeService } from '../../core/theme/ThemeService'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { normalizeMenuNodes } from '../../shared/menus/normalize'
import { MENUS_EXTENSION_POINT } from '../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { THEMES_EXTENSION_POINT, THEME_CHANGED, THEME_CHOOSER_OPEN, THEME_COMMANDS, THEME_GET, DEFAULT_THEME_ID, themeKey, themeUseCommand, themeWindowUseCommand } from '../../shared/theme/types'
import { createThemePersistence } from '../../shell/main/theme/appStatePersistence'
import { layoutMenus } from '../../shell/main/layout/layoutMenus'
import { registerTheme } from '../../shell/main/theme/registerTheme'
import { createLogger } from '../helpers/runtime'
import { fakeThemePort, memoryThemePersistence, midnight, sunrise } from '../helpers/theme'

const SHELL = DEFAULT_THEME_ID

function setup(saved: { global?: unknown, overrides?: Record<string, unknown> } = {}, systemDark = false) {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const platform = fakeThemePort(systemDark)
  const { store, persistence } = memoryThemePersistence(saved)
  const theme = new ThemeService(runtime.extensions, platform.port, { persistence, log })
  const host = registerTheme(shell, runtime, theme, log)

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const contribute = (descriptor: unknown) =>
    runtime.extensions.contribute('p', THEMES_EXTENSION_POINT, (descriptor as any).id, descriptor)

  /** A request as the Electron adapter would deliver it: attributed to a window by the main process. */
  const ask = (channel: string, data?: unknown, windowId?: number) =>
    runtime.ipc.dispatch({ channel, data }, windowId === undefined ? undefined : { windowId })
  const run = (command: string, ...args: unknown[]) => runtime.commands.execute(command, ...args)
  const changes = () => events.filter(e => e.name === THEME_CHANGED).map(e => e.data as ThemeSnapshot)

  return { runtime, theme, host, platform, log, store, persistence, events, changes, contribute, ask, run }
}

describe('registerTheme: requests', () => {
  it("answers a window with its own state and the registered themes", async () => {
    const { host, ask, contribute, theme } = setup()
    contribute(midnight())
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    theme.setOverride(2, { theme: 'p.midnight', mode: 'dark' })

    const first = await ask(THEME_GET, undefined, 1)
    const second = await ask(THEME_GET, undefined, 2)

    expect(first).toMatchObject({ ok: true, data: { state: { windowId: 1, theme: SHELL, mode: 'light' } } })
    expect(second).toMatchObject({ ok: true, data: { state: { windowId: 2, theme: 'p.midnight', mode: 'dark', override: { theme: 'p.midnight' } } } })
    expect((first as any).data.themes.map((t: any) => t.id)).toEqual([SHELL, 'p.midnight'])
  })

  it('rejects a request from a window it does not know, or from no window', async () => {
    const { host, ask } = setup()
    await host.attachWindow(1, 'main')

    await expect(ask(THEME_GET, undefined, 5)).resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'Unknown window: 5' } })
    await expect(ask(THEME_GET)).resolves.toMatchObject({ ok: false, error: { message: 'Unknown window: undefined' } })
  })

  it('offers no request that changes the theme', () => {
    const { runtime } = setup()

    expect(runtime.ipc.has(THEME_GET)).toBe(true)
    expect(runtime.ipc.has('shell:theme.set')).toBe(false)
  })
})

describe('registerTheme: events', () => {
  it("publishes a window's new state and the themes when it changes", async () => {
    const { host, run, changes } = setup()
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.useDark)

    const published = changes()
    expect(published).toHaveLength(1)
    expect(published[0].state).toMatchObject({ windowId: 1, mode: 'dark', global: { mode: 'dark' } })
    expect(published[0].themes.map(t => t.id)).toEqual([SHELL])
  })

  it('publishes for every window, each carrying its own id', async () => {
    const { host, run, changes } = setup()
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')

    await run(THEME_COMMANDS.useDark)

    expect(changes().map(s => s.state.windowId)).toEqual([1, 2])
  })

  it('publishes when the OS changes under the system setting, and not under an explicit one', async () => {
    const { host, platform, run, changes } = setup()
    await host.attachWindow(1, 'main')

    platform.setSystemDark(true)
    expect(changes().map(s => s.state.mode)).toEqual(['dark'])

    await run(THEME_COMMANDS.useLight)
    const before = changes().length
    platform.setSystemDark(false)
    platform.setSystemDark(true)
    expect(changes()).toHaveLength(before)
  })

  it('publishes nothing for a command that changes nothing', async () => {
    const { host, run, events } = setup()
    await host.attachWindow(1, 'main')
    events.length = 0

    await run(THEME_COMMANDS.useSystem)

    expect(events.filter(e => e.name === THEME_CHANGED)).toEqual([])
  })

  it('publishes to windows when a plugin contributes a theme', async () => {
    const { host, contribute, changes } = setup()
    await host.attachWindow(1, 'main')

    contribute(sunrise())

    expect(changes().map(s => s.themes.map(t => t.id))).toEqual([[SHELL, 'p.sunrise']])
  })
})

describe('registerTheme: commands', () => {
  it('registers the theme commands under the shell\'s name', () => {
    const { runtime } = setup()

    for (const id of Object.values(THEME_COMMANDS)) expect(runtime.commands.has(id)).toBe(true)
  })

  it('sets the application-wide mode, keeping the theme', async () => {
    const { host, theme, run, contribute } = setup()
    contribute(sunrise())
    theme.setGlobal({ theme: 'p.sunrise', mode: 'system' })
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.useDark)
    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'dark' })
    await run(THEME_COMMANDS.useLight)
    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'light' })
    await run(THEME_COMMANDS.useSystem)
    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'system' })
  })

  it('toggles to the opposite of what the application shows', async () => {
    const { host, theme, run } = setup({}, true)
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.toggle)
    expect(theme.getGlobal().mode).toBe('light')
    await run(THEME_COMMANDS.toggle)
    expect(theme.getGlobal().mode).toBe('dark')
  })

  it('warns and changes nothing when the theme has no such mode', async () => {
    const { host, theme, run, log, contribute } = setup()
    contribute(midnight())
    theme.setGlobal({ theme: 'p.midnight', mode: 'dark' })
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.useLight)
    await run(THEME_COMMANDS.useSystem)

    expect(theme.getGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })
    expect(log.warn).toHaveBeenCalledWith('[theme] Theme "p.midnight" cannot show "light"')
    expect(log.warn).toHaveBeenCalledWith('[theme] Theme "p.midnight" cannot show "system"')
  })

  it('chooses a theme, keeping the mode when the new theme has it and using its own when it does not', async () => {
    const { theme, run, contribute } = setup()
    contribute(sunrise())
    contribute(midnight())
    theme.setGlobal({ theme: SHELL, mode: 'light' })

    await run(THEME_COMMANDS.select, 'p.sunrise')
    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'light' })

    await run(THEME_COMMANDS.select, 'p.midnight')
    expect(theme.getGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })

    await run(THEME_COMMANDS.select, SHELL)
    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it('refuses to choose a theme that does not exist', async () => {
    const { theme, run } = setup()

    await expect(run(THEME_COMMANDS.select, 'p.nope')).rejects.toThrow('Unknown theme "p.nope"')
    await expect(run(THEME_COMMANDS.select)).rejects.toThrow('Unknown theme "undefined"')
    expect(theme.getGlobal().theme).toBe(SHELL)
  })

  it('gives the focused window its own theme, and takes it back', async () => {
    const { host, theme, run, contribute } = setup()
    contribute(midnight())
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    host.focus(2)

    await run(THEME_COMMANDS.setForWindow, { theme: 'p.midnight', mode: 'dark' })
    expect(theme.getState(2).override).toEqual({ theme: 'p.midnight', mode: 'dark' })
    expect(theme.getState(1).override).toBeUndefined()

    await run(THEME_COMMANDS.clearWindowOverride)
    expect(theme.getState(2).override).toBeUndefined()
  })

  it('refuses an invalid override with the reason', async () => {
    const { host, run } = setup()
    await host.attachWindow(1, 'main')

    await expect(run(THEME_COMMANDS.setForWindow, { theme: 'p.nope', mode: 'dark' })).rejects.toThrow('Unknown theme "p.nope"')
    await expect(run(THEME_COMMANDS.setForWindow, 'dark')).rejects.toThrow('must be an object')
  })

  it('falls back to the primary window when none has focus, or the focused one has closed', async () => {
    const { host, theme, run, contribute } = setup()
    contribute(midnight())
    await host.attachWindow(2, 'window-2')
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.setForWindow, { theme: 'p.midnight', mode: 'dark' })
    expect(theme.getState(1).override).toBeDefined()

    host.focus(2)
    await host.detachWindow(2)
    await run(THEME_COMMANDS.clearWindowOverride)
    expect(theme.getState(1).override).toBeUndefined()
  })

  it('fails to act on a window when there is none', async () => {
    const { run } = setup()

    await expect(run(THEME_COMMANDS.setForWindow, { theme: SHELL, mode: 'dark' })).rejects.toThrow('There is no window')
  })

  it('enables clearing the override only while the focused window has one', async () => {
    const { host, runtime, theme } = setup()
    await host.attachWindow(1, 'main')

    expect(runtime.commands.isEnabled(THEME_COMMANDS.clearWindowOverride)).toBe(false)
    theme.setOverride(1, { theme: SHELL, mode: 'dark' })
    expect(runtime.commands.isEnabled(THEME_COMMANDS.clearWindowOverride)).toBe(true)
    theme.setOverride(1, undefined)
    expect(runtime.commands.isEnabled(THEME_COMMANDS.clearWindowOverride)).toBe(false)
  })
})

describe('registerTheme: context keys', () => {
  it('describes the application theme before any window exists', () => {
    const { runtime } = setup({}, true)

    expect(runtime.contextKeys.snapshot()).toMatchObject({
      [themeKey.mode]: 'dark', [themeKey.id]: SHELL, [themeKey.overridden]: false
    })
  })

  it('follows the focused window, including its override', async () => {
    const { host, runtime, theme, contribute } = setup()
    contribute(midnight())
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    theme.setOverride(2, { theme: 'p.midnight', mode: 'dark' })

    host.focus(1)
    expect(runtime.contextKeys.snapshot()).toMatchObject({ [themeKey.mode]: 'light', [themeKey.id]: SHELL, [themeKey.overridden]: false })

    host.focus(2)
    expect(runtime.contextKeys.snapshot()).toMatchObject({ [themeKey.mode]: 'dark', [themeKey.id]: 'p.midnight', [themeKey.overridden]: true })
  })

  it('updates when the theme changes', async () => {
    const { host, runtime, run } = setup()
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.useDark)

    expect(runtime.contextKeys.get(themeKey.mode)).toBe('dark')
  })

  it('ignores focus on a window that is not attached', async () => {
    const { host, runtime } = setup()
    await host.attachWindow(1, 'main')

    host.focus(99)

    expect(runtime.contextKeys.get(themeKey.mode)).toBe('light')
  })
})

/** The resolved View ▸ Theme submenu, as the menu bar would show it. */
function themeSubmenu(runtime: ReturnType<typeof setup>['runtime']) {
  // The View menu itself belongs to the layout, as in the app
  for (const menu of layoutMenus) runtime.extensions.contribute('shell', MENUS_EXTENSION_POINT, menu.id, menu)

  const { menus, diagnostics } = resolveMenus([
    { kind: 'menu', id: 'shell.file', label: 'File' }, { kind: 'menu', id: 'shell.tools', label: 'Tools' }, { kind: 'menu', id: 'shell.help', label: 'Help' },
    ...runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)
  ] as never)
  const view = menus.find(m => m.id === 'shell.view')!
  return { theme: view.children.find(c => c.type === 'submenu' && c.id === 'shell.view.theme') as any, diagnostics }
}

const itemsOf = (menu: any) => menu.children.filter((c: any) => c.type === 'item')

describe('registerTheme: the View ▸ Theme menu', () => {
  it('resolves cleanly into a submenu of the View menu with the modes, the themes and a submenu for this window', () => {
    const { runtime } = setup()

    const { theme, diagnostics } = themeSubmenu(runtime)

    expect(diagnostics).toEqual([])
    expect(theme).toMatchObject({ type: 'submenu', label: '&Theme' })
    expect(itemsOf(theme).map((i: any) => i.command)).toEqual([
      THEME_COMMANDS.choose, THEME_COMMANDS.useSystem, THEME_COMMANDS.useLight, THEME_COMMANDS.useDark, THEME_COMMANDS.toggle, themeUseCommand(SHELL)
    ])
    const window = theme.children.find((c: any) => c.type === 'submenu')
    expect(window).toMatchObject({ label: 'This &Window' })
    expect(itemsOf(window).map((i: any) => i.command)).toEqual([themeWindowUseCommand(SHELL), THEME_COMMANDS.clearWindowOverride])
  })

  it('has a working command behind every item', () => {
    const { runtime, contribute } = setup()
    contribute(sunrise())

    const { theme } = themeSubmenu(runtime)

    const all = [...itemsOf(theme), ...itemsOf(theme.children.find((c: any) => c.type === 'submenu'))]
    expect(all.length).toBeGreaterThan(8)
    for (const { command } of all) expect(runtime.commands.has(command), command).toBe(true)
  })

  it('separates the chooser, the modes, the themes and this window with separators', () => {
    const { runtime } = setup()

    const { theme } = themeSubmenu(runtime)

    // The resolver surrounds every group with separators; the menu bar consolidates them
    const shown = normalizeMenuNodes(theme.children)
    expect(shown.map((c: any) => c.type === 'separator' ? '-' : c.type === 'submenu' ? 'submenu' : 'item')).toEqual([
      'item', '-', 'item', 'item', 'item', 'item', '-', 'item', '-', 'submenu'
    ])
  })
})

describe('registerTheme: the theme chooser', () => {
  it('opens in the focused window, by telling that window', async () => {
    const { host, run, events } = setup()
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    host.focus(2)

    await run(THEME_COMMANDS.choose)

    expect(events.filter(e => e.name === THEME_CHOOSER_OPEN)).toEqual([{ name: THEME_CHOOSER_OPEN, data: { windowId: 2 } }])
  })

  it('falls back to the primary window when none has focus, and fails when there is none', async () => {
    const { host, run, events } = setup()
    await expect(run(THEME_COMMANDS.choose)).rejects.toThrow('There is no window')

    await host.attachWindow(2, 'window-2')
    await host.attachWindow(1, 'main')
    await run(THEME_COMMANDS.choose)

    expect(events.find(e => e.name === THEME_CHOOSER_OPEN)?.data).toEqual({ windowId: 1 })
  })

  it('is the first item of View ▸ Theme', () => {
    const { runtime } = setup()

    const { theme } = themeSubmenu(runtime)

    expect(itemsOf(theme)[0]).toMatchObject({ label: '&Choose Theme…', command: THEME_COMMANDS.choose })
  })

  it('sets the application theme and mode exactly, by a selection', async () => {
    const { theme, run, contribute } = setup()
    contribute(sunrise())

    await run(THEME_COMMANDS.set, { theme: 'p.sunrise', mode: 'light' })

    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'light' })
  })

  it('refuses a selection that cannot be used, with the reason', async () => {
    const { theme, run, contribute } = setup()
    contribute(midnight())

    await expect(run(THEME_COMMANDS.set, { theme: 'p.midnight', mode: 'system' })).rejects.toThrow('cannot follow the system')
    await expect(run(THEME_COMMANDS.set, { theme: 'p.nope', mode: 'dark' })).rejects.toThrow('Unknown theme "p.nope"')
    await expect(run(THEME_COMMANDS.set, 'dark')).rejects.toThrow('must be an object')
    expect(theme.getGlobal().theme).toBe(SHELL)
  })

  it('sends, with each snapshot, whether the system wants dark, so "follow the system" can be previewed', async () => {
    const { host, ask, platform } = setup({}, true)
    await host.attachWindow(1, 'main')

    expect(await ask(THEME_GET, undefined, 1)).toMatchObject({ data: { systemPrefersDark: true } })
    platform.setSystemDark(false)
    expect(await ask(THEME_GET, undefined, 1)).toMatchObject({ data: { systemPrefersDark: false } })
  })
})

describe('registerTheme: choosing a theme from the menu', () => {
  it('lists each registered theme, the shell\'s first, once for the application and once for this window', () => {
    const { runtime, contribute } = setup()
    contribute(sunrise())
    contribute(midnight())

    const { theme } = themeSubmenu(runtime)

    const labels = (menu: any) => itemsOf(menu).map((i: any) => i.label)
    expect(labels(theme)).toEqual(expect.arrayContaining(['Tessera', 'Sunrise', 'Midnight']))
    expect(labels(theme.children.find((c: any) => c.type === 'submenu'))).toEqual(['Tessera', 'Sunrise', 'Midnight', 'Use the &Application Theme'])
  })

  it('shows a plugin\'s ampersand as an ampersand, not a mnemonic', () => {
    const { runtime, contribute } = setup()
    contribute(sunrise({ label: 'Salt & Pepper' }))

    const { theme } = themeSubmenu(runtime)

    expect(itemsOf(theme).map((i: any) => i.label)).toContain('Salt && Pepper')
  })

  it('chooses the theme for the application, keeping the mode when the theme has it', async () => {
    const { theme, run, contribute } = setup()
    contribute(sunrise())
    theme.setGlobal({ theme: SHELL, mode: 'dark' })

    await run(themeUseCommand('p.sunrise'))

    expect(theme.getGlobal()).toEqual({ theme: 'p.sunrise', mode: 'dark' })
  })

  it('uses a single-variant theme\'s own mode when it has no such mode', async () => {
    const { theme, run, contribute } = setup()
    contribute(midnight())

    await run(themeUseCommand('p.midnight'))

    expect(theme.getGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })
  })

  it('gives the focused window the theme, and no other window', async () => {
    const { host, theme, run, contribute } = setup()
    contribute(sunrise())
    await host.attachWindow(1, 'main')
    await host.attachWindow(2, 'window-2')
    host.focus(2)

    await run(themeWindowUseCommand('p.sunrise'))

    expect(theme.getState(2).override).toEqual({ theme: 'p.sunrise', mode: 'system' })
    expect(theme.getState(1).override).toBeUndefined()
  })

  it('keeps the window\'s own mode when it changes its theme', async () => {
    const { host, theme, run, contribute } = setup()
    contribute(sunrise())
    await host.attachWindow(1, 'main')
    theme.setOverride(1, { theme: SHELL, mode: 'dark' })

    await run(themeWindowUseCommand('p.sunrise'))

    expect(theme.getState(1).override).toEqual({ theme: 'p.sunrise', mode: 'dark' })
  })

  it('adds the items of a theme that is contributed later, and drops those of one that goes away', () => {
    const { runtime, contribute } = setup()
    const registration = contribute(midnight())
    expect(runtime.commands.has(themeUseCommand('p.midnight'))).toBe(true)
    expect(itemsOf(themeSubmenu(runtime).theme).map((i: any) => i.label)).toContain('Midnight')

    registration.dispose()

    expect(runtime.commands.has(themeUseCommand('p.midnight'))).toBe(false)
    expect(runtime.commands.has(themeWindowUseCommand('p.midnight'))).toBe(false)
    expect(runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.id)).not.toContain('shell.view.theme.use.p.midnight')
  })

  it('renames an item when a theme\'s label changes', () => {
    const { runtime, contribute } = setup()
    const first = contribute(sunrise({ label: 'Old' }))
    first.dispose()

    contribute(sunrise({ label: 'New' }))

    const labels = itemsOf(themeSubmenu(runtime).theme).map((i: any) => i.label)
    expect(labels).toContain('New')
    expect(labels).not.toContain('Old')
  })

  it('does not add items twice for a theme it already lists', () => {
    const { runtime, contribute } = setup()
    contribute(sunrise())
    contribute(midnight())

    const ids = runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.id)

    expect(ids.filter(id => id === 'shell.view.theme.use.p.sunrise')).toHaveLength(1)
  })
})

describe('registerTheme: windows and persistence', () => {
  it("loads the saved choice, and each window's override when it attaches", async () => {
    const { host, theme, contribute } = setup({ global: 'dark', overrides: { main: { theme: 'p.midnight', mode: 'dark' } } })
    contribute(midnight())

    await host.load()
    const state = await host.attachWindow(1, 'main')

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
    expect(state).toMatchObject({ theme: 'p.midnight', override: { theme: 'p.midnight' } })
  })

  it('refreshes the context keys once the saved choice is loaded', async () => {
    const { host, runtime } = setup({ global: 'dark' })

    await host.load()

    expect(runtime.contextKeys.get(themeKey.mode)).toBe('dark')
  })

  it('saves what commands change, under the keys the app-state adapter uses', async () => {
    const { host, run, persistence, store } = setup()
    await host.attachWindow(1, 'main')

    await run(THEME_COMMANDS.useDark)
    await run(THEME_COMMANDS.setForWindow, { theme: SHELL, mode: 'light' })
    await vi.waitFor(() => expect(persistence.saveOverride).toHaveBeenCalled())

    expect(store.global).toEqual({ theme: SHELL, mode: 'dark' })
    expect(store.overrides.get('main')).toEqual({ theme: SHELL, mode: 'light' })
  })

  it('finishes its writes on shutdown', async () => {
    const { host, runtime, run, store } = setup()
    await host.attachWindow(1, 'main')
    await run(THEME_COMMANDS.useDark)

    await runtime.lifecycle.requestShutdown('system')

    expect(store.global).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it('stops following a window that closed', async () => {
    const { host, theme, events } = setup()
    await host.attachWindow(1, 'main')
    await host.detachWindow(1)
    events.length = 0

    theme.setGlobal({ theme: SHELL, mode: 'dark' })

    expect(events.filter(e => e.name === THEME_CHANGED)).toEqual([])
  })

  it('works over the real app-state adapter', async () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    const data = new Map<string, unknown>([['theme', 'dark']])
    const appState = {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => { data.set(key, value) },
      remove: async (key: string) => { data.delete(key) }
    } as unknown as AppState
    const theme = new ThemeService(runtime.extensions, fakeThemePort().port, { persistence: createThemePersistence(() => appState), log })
    const host = registerTheme(shell, runtime, theme, log)

    await host.load()
    await host.attachWindow(1, 'main')
    await runtime.commands.execute(THEME_COMMANDS.setForWindow, { theme: SHELL, mode: 'light' })
    await theme.flush()

    expect(theme.getGlobal().mode).toBe('dark')
    expect(data.get('shell.theme.main')).toEqual({ theme: SHELL, mode: 'light' })
  })
})

// A window's state is typed; keep the compiler honest about the shape tests rely on.
const _shape: ThemeState = { windowId: 1, global: { theme: SHELL, mode: 'system' }, theme: SHELL, mode: 'light' }
void _shape
