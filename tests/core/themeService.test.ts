import { describe, it, expect, vi } from 'vitest'
import type { PersistedTheme, ThemeSelection } from '@tessera/types'
import { createPluginRuntime } from '../../core/plugins/PluginContext'
import { SystemModeSource, ThemeService, sanitizeTheme } from '../../core/theme/ThemeService'
import { SHELL_THEME, THEMES_EXTENSION_POINT } from '../../shared/themes/types'
import { createLogger } from '../helpers/runtime'

function fakeSystem(dark = false) {
  const listeners = new Set<() => void>()
  return {
    dark,
    isDark() { return this.dark },
    onDidChange: (listener: () => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
    change(dark: boolean) { this.dark = dark; listeners.forEach(l => l()) }
  } satisfies SystemModeSource & { dark: boolean, change(dark: boolean): void }
}

function setup(saved?: PersistedTheme | unknown, dark = false) {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const store: { value?: unknown } = { value: saved }
  const persistence = {
    load: vi.fn(async () => store.value as PersistedTheme | undefined),
    save: vi.fn(async (theme: PersistedTheme) => { store.value = theme })
  }
  const system = fakeSystem(dark)
  const service = new ThemeService(runtime.extensions, { system, persistence, log })
  const selections: ThemeSelection[] = []
  let themeChanges = 0
  service.onDidChangeSelection(s => selections.push(s))
  service.onDidChangeThemes(() => themeChanges++)

  runtime.extensions.contribute('shell', THEMES_EXTENSION_POINT, SHELL_THEME.id, SHELL_THEME)
  const contribute = (id: string, extra: Record<string, unknown> = {}) =>
    runtime.extensions.contribute('p', THEMES_EXTENSION_POINT, id, { id, label: id, dark: { palette: { background: { default: '#000001' } } }, ...extra })

  return { service, runtime, log, store, persistence, system, selections, contribute, themeChanges: () => themeChanges }
}

describe('ThemeService', () => {
  it('starts on the shell\'s theme following the system, and lists the themes contributed', async () => {
    const { service, contribute } = setup()
    contribute('p.x')
    await service.load()

    expect(service.themes().map(t => t.id)).toEqual(['shell.default', 'p.x'])
    expect(service.selection()).toEqual({ themeId: 'shell.default', mode: 'system', resolvedMode: 'light', effectiveThemeId: 'shell.default' })
  })

  it('loads the saved choice, resolving system from the source', async () => {
    const { service, contribute } = setup({ themeId: 'p.x', mode: 'system' }, true)
    contribute('p.x')

    expect(await service.load()).toEqual({ themeId: 'p.x', mode: 'system', resolvedMode: 'dark', effectiveThemeId: 'p.x' })
  })

  it('uses what is valid of damaged saved data and defaults for the rest', async () => {
    expect(sanitizeTheme({ themeId: 'p.x', mode: 'sepia' })).toEqual({ themeId: 'p.x', mode: 'system' })
    expect(sanitizeTheme({ themeId: 42, mode: 'dark' })).toEqual({ themeId: 'shell.default', mode: 'dark' })
    expect(sanitizeTheme('dark')).toEqual({ themeId: 'shell.default', mode: 'system' })
    const { service, log } = setup(null)
    await expect(service.load()).resolves.toMatchObject({ themeId: 'shell.default' })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('survives a persistence that fails to load', async () => {
    const { service, persistence, log } = setup()
    persistence.load.mockRejectedValueOnce(new Error('disk'))
    await expect(service.load()).resolves.toMatchObject({ themeId: 'shell.default' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('disk'))
  })

  it('sets the theme, the mode, or both, saving and announcing each change once', async () => {
    const { service, contribute, persistence, selections } = setup()
    contribute('p.x')
    await service.load()
    selections.length = 0

    await service.set({ themeId: 'p.x' })
    await service.set({ mode: 'dark' })
    await service.set({ mode: 'dark' })             // no change: nothing announced
    await service.set({})                           // nothing requested: nothing saved or announced
    await service.flush()

    expect(selections).toEqual([
      { themeId: 'p.x', mode: 'system', resolvedMode: 'light', effectiveThemeId: 'p.x' },
      { themeId: 'p.x', mode: 'dark', resolvedMode: 'dark', effectiveThemeId: 'p.x' }
    ])
    expect(persistence.save.mock.calls.map(([theme]) => theme)).toEqual([{ themeId: 'p.x', mode: 'system' }, { themeId: 'p.x', mode: 'dark' }])
  })

  it('refuses an unknown theme or mode and changes nothing', async () => {
    const { service, persistence } = setup()
    await service.load()

    await expect(service.set({ themeId: 'nope' })).rejects.toThrow('Unknown theme: nope')
    await expect(service.set({ mode: 'sepia' as any })).rejects.toThrow('Unknown theme mode: sepia')
    await expect(service.set(null as any)).rejects.toThrow()
    expect(persistence.save).not.toHaveBeenCalled()
    expect(service.selection().mode).toBe('system')
  })

  it('toggles light and dark, and from system goes to the opposite of what the system is', async () => {
    const { service, system } = setup(undefined, true)
    await service.load()

    expect((await service.toggleMode()).mode).toBe('light')     // system was dark
    expect((await service.toggleMode()).mode).toBe('dark')
    system.change(false)
    expect((await service.set({ mode: 'system' })).resolvedMode).toBe('light')
    expect((await service.toggleMode()).mode).toBe('dark')
  })

  it('follows the system while in system mode, and ignores it otherwise', async () => {
    const { service, system, selections } = setup()
    await service.load()
    selections.length = 0

    system.change(true)
    expect(selections.map(s => s.resolvedMode)).toEqual(['dark'])

    await service.set({ mode: 'light' })
    selections.length = 0
    system.change(false)
    system.change(true)
    expect(selections).toEqual([])
  })

  it('falls back to the shell\'s theme while the chosen one is missing, keeps the choice, and returns to it', async () => {
    const { service, contribute, selections, store } = setup({ themeId: 'p.x', mode: 'light' })
    await service.load()
    expect(service.selection()).toMatchObject({ themeId: 'p.x', effectiveThemeId: 'shell.default' })
    expect(service.effectiveTheme()?.id).toBe('shell.default')
    selections.length = 0

    const contribution = contribute('p.x')
    expect(selections).toEqual([{ themeId: 'p.x', mode: 'light', resolvedMode: 'light', effectiveThemeId: 'p.x' }])

    contribution.dispose()
    expect(selections.at(-1)).toMatchObject({ themeId: 'p.x', effectiveThemeId: 'shell.default' })
    expect(store.value).toEqual({ themeId: 'p.x', mode: 'light' })   // the choice was never overwritten
  })

  it('fires onDidChangeThemes when contributions change and warns about invalid ones', async () => {
    const { service, contribute, runtime, log, themeChanges } = setup()
    const before = themeChanges()
    contribute('p.ok')
    runtime.extensions.contribute('p', THEMES_EXTENSION_POINT, 'p.bad', { id: 'p.bad', label: 'Bad' })
    expect(themeChanges()).toBe(before + 2)
    expect(service.themes().map(t => t.id)).toEqual(['shell.default', 'p.ok'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"p.bad" defines neither'))
  })

  it('reports the page background of the theme in effect, for painting the window', async () => {
    const { service, contribute } = setup(undefined, true)
    await service.load()
    expect(service.backgroundColor()).toBe('#121212')                 // shell theme, system is dark

    contribute('p.x')
    await service.set({ themeId: 'p.x' })
    expect(service.backgroundColor()).toBe('#000001')                 // the plugin's dark scheme
    await service.set({ mode: 'light' })
    expect(service.backgroundColor()).toBe('#000001')                 // it has no light scheme, so its dark one is used
    contribute('p.y', { light: { palette: {} } })
    await service.set({ themeId: 'p.y' })
    expect(service.backgroundColor()).toBe('#fff')                    // a scheme without a background: MUI's default
  })

  it('stops listening when disposed', async () => {
    const { service, system, selections } = setup()
    await service.load()
    service.dispose()
    selections.length = 0
    system.change(true)
    expect(selections).toEqual([])
  })
})
