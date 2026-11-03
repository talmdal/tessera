import { describe, expect, it, vi } from 'vitest'
import type { AppState, ThemeSelection } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { ThemeService } from '../../core/theme/ThemeService'
import { normalizeMenuNodes } from '../../shared/menus/normalize'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { MENUS_EXTENSION_POINT, SubmenuNode, VIEW_MENU } from '../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { COMMANDS_EXECUTE } from '../../shared/shellEvents'
import {
  THEME_CHANGED, THEME_COMMANDS, THEME_GET, THEME_PICKER_OPEN, THEME_SET, THEMES_CHANGED, THEMES_EXTENSION_POINT, THEMES_LIST, themeKey
} from '../../shared/themes/types'
import { registerCommandsIpc } from '../../shell/main/commands/commandsIpc'
import { createAppStateThemePersistence } from '../../shell/main/theme/appStateThemePersistence'
import { registerTheme } from '../../shell/main/theme/registerTheme'
import { createLogger } from '../helpers/runtime'

/** An app.state service over a Map. */
function memoryAppState(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const appState: AppState = {
    get: async <T,>(key: string, defaultFn?: () => T) => (store.has(key) ? store.get(key) : defaultFn?.()) as T | undefined,
    set: async (key, value) => { store.set(key, value) },
    update: async () => {},
    remove: async key => { store.delete(key) }
  }
  return { store, appState }
}

function setup(saved: Record<string, unknown> = {}, dark = false) {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const { store, appState } = memoryAppState(saved)
  const system = { isDark: () => dark, onDidChange: () => ({ dispose() {} }) }
  const themes = new ThemeService(runtime.extensions, { system, persistence: createAppStateThemePersistence(() => appState), log })
  const applyNative = vi.fn()
  let focused: number | undefined = 7
  // The View menu itself comes from registerLayout, which is not under test here.
  shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, VIEW_MENU, { kind: 'menu', id: VIEW_MENU, label: '&View' })
  registerTheme(shell, runtime, themes, { focusedWindow: () => focused, applyNative })
  registerCommandsIpc(shell, log)

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const contribute = (id: string, extra: Record<string, unknown> = {}) =>
    runtime.extensions.contribute('p', THEMES_EXTENSION_POINT, id, { id, label: `Label ${id}`, dark: {}, ...extra })
  const ask = (channel: string, data?: unknown) => runtime.ipc.dispatch({ channel, data }, { windowId: 7 })
  const run = (id: string, ...args: unknown[]) => ask(COMMANDS_EXECUTE, { id, args })
  const menu = () => {
    const { menus } = resolveMenus(runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl))
    const view = menus.find(m => m.id === VIEW_MENU)!
    const theme = view.children.find((c): c is SubmenuNode => c.type === 'submenu' && c.label === '&Theme')!
    return normalizeMenuNodes(theme.children).map(c => c.type === 'item' ? c.label : c.type)   // as the Electron menu does
  }

  return { runtime, themes, log, store, events, applyNative, contribute, ask, run, menu, unfocus: () => { focused = undefined } }
}

describe('registerTheme', () => {
  it('contributes the shell\'s theme and answers the list and the choice', async () => {
    const { themes, contribute, ask } = setup()
    contribute('p.x')
    await themes.load()

    expect(await ask(THEMES_LIST)).toMatchObject({ ok: true, data: [{ id: 'shell.default', pluginId: 'shell' }, { id: 'p.x', pluginId: 'p' }] })
    expect(await ask(THEME_GET)).toEqual({ ok: true, data: { themeId: 'shell.default', mode: 'system', resolvedMode: 'light', effectiveThemeId: 'shell.default' } })
  })

  it('applies a request, then publishes the selection, sets the context keys and the native mode', async () => {
    const { themes, runtime, contribute, ask, events, applyNative } = setup()
    contribute('p.x')
    await themes.load()
    events.length = 0

    const response = await ask(THEME_SET, { themeId: 'p.x', mode: 'dark' })
    const selection: ThemeSelection = { themeId: 'p.x', mode: 'dark', resolvedMode: 'dark', effectiveThemeId: 'p.x' }
    expect(response).toEqual({ ok: true, data: selection })
    expect(events).toEqual([{ name: THEME_CHANGED, data: selection }])
    expect(runtime.contextKeys.get(themeKey.id)).toBe('p.x')
    expect(runtime.contextKeys.get(themeKey.mode)).toBe('dark')
    expect(runtime.contextKeys.get(themeKey.resolvedMode)).toBe('dark')
    expect(applyNative).toHaveBeenLastCalledWith(selection)
  })

  it('refuses a bad request as a handler error', async () => {
    const { themes, ask } = setup()
    await themes.load()
    expect(await ask(THEME_SET, { themeId: 'nope' })).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: 'Unknown theme: nope' } })
  })

  it('registers the mode, toggle and set commands', async () => {
    const { themes, contribute, run, ask } = setup()
    contribute('p.x')
    await themes.load()

    await run(THEME_COMMANDS.mode('dark'))
    expect((await ask(THEME_GET) as any).data.mode).toBe('dark')
    await run(THEME_COMMANDS.toggleMode)
    expect((await ask(THEME_GET) as any).data.mode).toBe('light')
    await run(THEME_COMMANDS.set, 'p.x', 'system')
    expect((await ask(THEME_GET) as any).data).toMatchObject({ themeId: 'p.x', mode: 'system' })
    await run(THEME_COMMANDS.set, { themeId: 'shell.default' })
    expect((await ask(THEME_GET) as any).data).toMatchObject({ themeId: 'shell.default', mode: 'system' })
  })

  it('offers every theme in View › Theme with a command of its own, following the catalogue', async () => {
    const { runtime, themes, contribute, run, ask, menu, events } = setup()
    await themes.load()
    expect(menu()).toEqual(['&Light', '&Dark', 'Follow &System', 'separator', 'Tessera', 'separator', '&Choose Theme…'])

    const x = contribute('p.x', { label: 'Spooky & Co' })
    expect(menu()).toEqual(['&Light', '&Dark', 'Follow &System', 'separator', 'Tessera', 'Spooky && Co', 'separator', '&Choose Theme…'])
    expect(events.map(e => e.name)).toContain(THEMES_CHANGED)
    expect(runtime.commands.has(THEME_COMMANDS.use('p.x'))).toBe(true)

    await run(THEME_COMMANDS.use('p.x'))
    expect((await ask(THEME_GET) as any).data.effectiveThemeId).toBe('p.x')

    x.dispose()
    expect(runtime.commands.has(THEME_COMMANDS.use('p.x'))).toBe(false)
    expect(menu()).not.toContain('Spooky && Co')
    expect((await ask(THEME_GET) as any).data).toMatchObject({ themeId: 'p.x', effectiveThemeId: 'shell.default' })
  })

  it('asks the focused window to open the chooser, and warns when there is none', async () => {
    const { themes, run, events, unfocus, log } = setup()
    await themes.load()

    await run(THEME_COMMANDS.choose)
    expect(events.filter(e => e.name === THEME_PICKER_OPEN).map(e => e.data)).toEqual([{ windowId: 7 }])

    unfocus()
    await run(THEME_COMMANDS.choose)
    expect(events.filter(e => e.name === THEME_PICKER_OPEN)).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No window'))
  })
})

describe('the app.state theme persistence', () => {
  it('keeps the choice under shell.theme', async () => {
    const { themes, store, contribute } = setup()
    contribute('p.x')
    await themes.load()
    await themes.set({ themeId: 'p.x', mode: 'light' })
    await themes.flush()
    expect(store.get('shell.theme')).toEqual({ themeId: 'p.x', mode: 'light' })
  })

  it('migrates the old light/dark string once, into a choice of the shell\'s theme', async () => {
    const { themes, store } = setup({ theme: 'dark' })
    expect(await themes.load()).toMatchObject({ themeId: 'shell.default', mode: 'dark' })
    expect(store.get('shell.theme')).toEqual({ themeId: 'shell.default', mode: 'dark' })
    expect(store.has('theme')).toBe(false)
  })

  it('ignores an old value it does not understand', async () => {
    const { themes, store } = setup({ theme: 'sepia' })
    expect(await themes.load()).toMatchObject({ mode: 'system' })
    expect(store.has('shell.theme')).toBe(false)
  })

  it('does nothing while app.state is not there yet', async () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const persistence = createAppStateThemePersistence(() => undefined)
    const themes = new ThemeService(runtime.extensions, { system: { isDark: () => false, onDidChange: () => ({ dispose() {} }) }, persistence, log })
    await expect(themes.load()).resolves.toMatchObject({ themeId: 'shell.default' })
    await expect(persistence.save({ themeId: 'x', mode: 'dark' })).resolves.toBeUndefined()
  })
})
