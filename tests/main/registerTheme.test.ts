import type { ColorContribution, ThemeContribution } from '@tessera/types'
import { describe, it, expect } from 'vitest'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { MENUS_EXTENSION_POINT } from '../../shared/menus/types'
import { fixedAppearance } from '../../shell/main/theme/nativeAppearance'
import { THEME_COMMANDS, registerTheme } from '../../shell/main/theme/registerTheme'
import { SHELL_COLOR_TOKENS } from '../../shared/theme/tokens'
import { COLORS_EXTENSION_POINT, THEMES_EXTENSION_POINT } from '../../shared/theme/types'
import { createLogger, createRuntime } from '../helpers/runtime'

const sepia: ThemeContribution = {
  id: 'money.sepia', label: 'Sepia', kind: 'light', extends: 'shell.light',
  colors: { 'shell.accent': '#7a5c1e', 'acc.positive': '#3f6b1c' }
}
const positive: ColorContribution = { id: 'acc.positive', description: 'Credits', defaults: { light: '#107c10', dark: '#89d185' } }

function setup() {
  const runtime = createRuntime()
  const log = createLogger()
  const shell = createPluginContext('shell', runtime)
  const applied: string[] = []
  const { service } = registerTheme(shell.context, runtime, {
    appearance: fixedAppearance('light'),
    focusedWindowId: () => 7,
    applyNative: state => applied.push(state.activeTheme),
    log
  })
  const events: { name: string, data?: unknown }[] = []
  runtime.events.subscribe(event => events.push(event))

  /** A plugin that contributes through its own context, disposable like a deactivation. */
  const plugin = (id: string, colors: ColorContribution[] = [], themes: ThemeContribution[] = []) => {
    const scope = createPluginContext(id, runtime)
    for (const c of colors) scope.context.subscriptions.push(scope.context.extensions.contribute(id, COLORS_EXTENSION_POINT, c.id, c))
    for (const t of themes) scope.context.subscriptions.push(scope.context.extensions.contribute(id, THEMES_EXTENSION_POINT, t.id, t))
    return scope
  }

  return { runtime, shell, service, log, events, applied, plugin, request: (channel: string, data?: unknown) => runtime.ipc.dispatch({ channel, data }, { windowId: 7 }) }
}

describe('registerTheme', () => {
  it('contributes the shell catalogue and themes, and answers shell:theme.get with them resolved', async () => {
    const { runtime, request, log } = setup()

    expect(runtime.extensions.getContributions(COLORS_EXTENSION_POINT).map(c => c.contributor)).toEqual(SHELL_COLOR_TOKENS.map(() => 'shell'))
    expect(runtime.extensions.getContributions(THEMES_EXTENSION_POINT).map(c => c.id)).toEqual(['shell.light', 'shell.dark'])

    const response = await request('shell:theme.get')
    expect(response).toMatchObject({ ok: true, data: { activeTheme: 'shell.light', kind: 'light', preference: { theme: 'system' } } })
    const { colors, themes } = (response as { data: { colors: Record<string, string>, themes: unknown[] } }).data
    expect(Object.keys(colors)).toHaveLength(SHELL_COLOR_TOKENS.length)
    expect(themes).toHaveLength(2)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('publishes shell:theme.changed with the whole state when the theme changes', () => {
    const { service, events } = setup()

    const state = service.setPreference({ theme: 'shell.dark' })

    expect(events).toEqual([{ name: 'shell:theme.changed', data: state }])
    expect(state.colors['shell.background']).toBe('#1e1e1e')
  })

  it('takes a plugin theme and token into account, whichever is contributed first', () => {
    const { service, plugin, events } = setup()

    plugin('money', [], [sepia])
    expect(service.get().themes.map(t => t.id)).toEqual(['shell.light', 'shell.dark', 'money.sepia'])
    expect(service.get().colors).not.toHaveProperty('acc.positive')

    service.setPreference({ theme: 'money.sepia' })
    expect(service.get().colors['shell.accent']).toBe('#7a5c1e')

    plugin('acc', [positive])                                   // the token the theme already colours
    expect(service.get().colors['acc.positive']).toBe('#3f6b1c')
    expect(events.map(e => e.name)).toEqual(['shell:theme.changed', 'shell:theme.changed', 'shell:theme.changed'])
  })

  it('falls back when the active theme is deactivated, and restores it when it returns', () => {
    const { service, plugin, log } = setup()
    const money = plugin('money', [], [sepia])
    service.setPreference({ theme: 'money.sepia' })

    money.dispose()
    expect(service.get()).toMatchObject({ activeTheme: 'shell.light', preference: { theme: 'money.sepia' } })
    expect(service.get().colors['shell.accent']).toBe('#0063b1')
    expect(log.warn).toHaveBeenCalledWith('[theme] Theme "money.sepia" is not available; using "shell.light"')

    plugin('money', [], [sepia])
    expect(service.get()).toMatchObject({ activeTheme: 'money.sepia' })
    expect(service.get().colors['shell.accent']).toBe('#7a5c1e')
  })

  it('skips invalid contributions with one warning each, and a plugin cannot claim another prefix', () => {
    const { service, plugin, log } = setup()

    plugin('acc', [
      { id: 'shell.accent', description: 'mine now', defaults: '#000000' },
      { id: 'acc.bad', description: 'bad', defaults: 'red' },
      positive
    ], [
      { id: 'acc.loop', label: 'Loop', kind: 'light', extends: 'acc.loop' }
    ])
    plugin('other', [{ id: 'other.x', description: 'x', defaults: '#123' }])   // another change: no repeat warnings

    expect(service.get().colors['shell.accent']).toBe('#0063b1')
    expect(service.get().colors['acc.positive']).toBe('#107c10')
    expect(service.get().themes.map(t => t.id)).not.toContain('acc.loop')
    expect(log.warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      '[theme] Colour token "shell.accent" ignored: "acc" may only contribute tokens starting with "acc."',
      '[theme] Colour token "acc.bad" has an invalid default "red": use a hex colour or a token id',
      '[theme] Theme "acc.loop" is part of an extends cycle'
    ])
  })

  it('ignores changes to other extension points', () => {
    const { runtime, events } = setup()

    runtime.extensions.contribute('p', 'shell.views', 'p.v', {})

    expect(events).toEqual([])
  })

  it('applies shell:theme.set from a window, and rejects a bad request', async () => {
    const { request, service, log } = setup()

    const response = await request('shell:theme.set', { theme: 'shell.dark' })
    expect(response).toMatchObject({ ok: true, data: { activeTheme: 'shell.dark' } })
    expect(service.get().activeTheme).toBe('shell.dark')
    expect(log.info).toHaveBeenCalledWith('[theme] Window 7 set {"theme":"shell.dark"}')

    await expect(request('shell:theme.set', 'shell.dark')).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('preference is required') } })
    await expect(request('shell:theme.set', { theme: 'nope.x' })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('Unknown theme') } })
  })

  it('offers select, useSystem and toggleDark commands, and keeps the context keys current', async () => {
    const { runtime, service } = setup()
    const keys = () => ({
      active: runtime.contextKeys.get('shell.theme.active'),
      kind: runtime.contextKeys.get('shell.theme.kind'),
      system: runtime.contextKeys.get('shell.theme.system')
    })
    expect(keys()).toEqual({ active: 'shell.light', kind: 'light', system: true })
    expect(runtime.commands.isEnabled(THEME_COMMANDS.useSystem)).toBe(false)

    await runtime.commands.execute(THEME_COMMANDS.toggleDark)
    expect(service.get()).toMatchObject({ activeTheme: 'shell.dark', preference: { theme: 'shell.dark' } })
    expect(keys()).toEqual({ active: 'shell.dark', kind: 'dark', system: undefined })
    expect(runtime.commands.isEnabled(THEME_COMMANDS.useSystem)).toBe(true)

    await runtime.commands.execute(THEME_COMMANDS.toggleDark)
    expect(service.get().activeTheme).toBe('shell.light')

    await runtime.commands.execute(THEME_COMMANDS.select, 'shell.dark')
    expect(service.get().activeTheme).toBe('shell.dark')
    await expect(runtime.commands.execute(THEME_COMMANDS.select, 42)).rejects.toThrow('needs a theme id')

    await runtime.commands.execute(THEME_COMMANDS.useSystem)
    expect(keys()).toEqual({ active: 'shell.light', kind: 'light', system: true })
  })

  it('asks the focused window to open the chooser', async () => {
    const { runtime, events } = setup()

    await runtime.commands.execute(THEME_COMMANDS.choose)

    expect(events).toEqual([{ name: 'shell:theme.chooseRequested', data: { windowId: 7 } }])
  })

  it('registers a command and a menu item per present theme, following contributions', async () => {
    const { runtime, plugin, service } = setup()
    const themeMenu = () => {
      // The View menu itself comes from registerLayout in the real shell.
      const viewMenu = { kind: 'menu', id: 'shell.view', label: '&View' }
      const { menus } = resolveMenus([viewMenu, ...runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)])
      const view = menus.find(m => m.id === 'shell.view')!
      const theme = view.children.find(c => c.type === 'submenu' && c.id === 'shell.view.theme')
      // Groups are fenced by separators the Electron adapter collapses; labels are what matters here.
      return theme?.type === 'submenu' ? theme.children.flatMap(c => c.type === 'item' ? [c.label] : []) : undefined
    }

    expect(runtime.commands.has(THEME_COMMANDS.use('shell.dark'))).toBe(true)
    expect(themeMenu()).toEqual(['&Choose Theme…', 'Follow &System', 'Toggle &Light/Dark', 'Tessera Light', 'Tessera Dark'])

    const money = plugin('money', [], [sepia])
    expect(themeMenu()).toEqual(['&Choose Theme…', 'Follow &System', 'Toggle &Light/Dark', 'Tessera Light', 'Tessera Dark', 'Sepia'])
    await runtime.commands.execute(THEME_COMMANDS.use('money.sepia'))
    expect(service.get().activeTheme).toBe('money.sepia')

    money.dispose()
    expect(runtime.commands.has(THEME_COMMANDS.use('money.sepia'))).toBe(false)
    expect(themeMenu()).not.toContain('Sepia')
  })

  it('lets the platform follow every new state', () => {
    const { service, applied } = setup()
    service.setPreference({ theme: 'shell.dark' })
    service.setPreference({ theme: 'shell.dark' })           // no change: not applied again
    expect(applied).toEqual(['shell.dark'])
  })

  it('tears down its contributions, handlers and listeners when the shell context is disposed', async () => {
    const { runtime, shell, events, plugin, request } = setup()
    shell.dispose()

    expect(runtime.extensions.getContributions(COLORS_EXTENSION_POINT)).toEqual([])
    expect(runtime.extensions.getContributions(THEMES_EXTENSION_POINT)).toEqual([])
    plugin('money', [], [sepia])                                 // a change after disposal
    expect(events).toEqual([])
    await expect(request('shell:theme.get')).resolves.toMatchObject({ ok: false, error: { code: 'NO_HANDLER' } })
    expect(runtime.commands.has(THEME_COMMANDS.use('shell.dark'))).toBe(false)
    expect(runtime.extensions.getContributions(MENUS_EXTENSION_POINT)).toEqual([])
  })
})
