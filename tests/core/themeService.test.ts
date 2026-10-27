import type { ColorDefinition, ThemeDefinition, ThemeKind, ThemePreference } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { ThemeContentSource, ThemeService } from '../../core/theme/ThemeService'
import { shellColorCatalogue, shellThemeDefinitions } from '../../shared/theme/builtin'
import { createLogger } from '../helpers/runtime'

/** A content source the test mutates, with a manual change event. */
function fakeContent(colors: ColorDefinition[], themes: ThemeDefinition[]) {
  const listeners = new Set<() => void>()
  return {
    colors: () => colors,
    themes: () => themes,
    onDidChange: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    set(nextColors: ColorDefinition[], nextThemes: ThemeDefinition[] = themes) {
      colors = nextColors
      themes = nextThemes
      listeners.forEach(l => l())
    }
  } satisfies ThemeContentSource & { set: unknown }
}

/** A system appearance the test switches. */
function fakeAppearance(initial: ThemeKind = 'light') {
  let kind = initial
  const listeners = new Set<(kind: ThemeKind) => void>()
  return {
    kind: () => kind,
    onDidChange: (listener: (kind: ThemeKind) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    set(next: ThemeKind) {
      kind = next
      listeners.forEach(l => l(next))
    }
  }
}

const token = (id: string, light: string, dark = light, pluginId = 'acc'): ColorDefinition =>
  ({ id, description: id, defaults: { light, dark }, pluginId })

const sepia: ThemeDefinition = {
  id: 'm.sepia', label: 'Sepia', kind: 'light', extends: 'shell.light', pluginId: 'm',
  colors: { 'shell.accent': '#7a5c1e', 'acc.positive': '#3f6b1c' }
}
const night: ThemeDefinition = { id: 'm.night', label: 'Night', kind: 'dark', extends: 'shell.dark', pluginId: 'm', colors: { 'shell.accent': '#ff00ff' } }

function setup(options: { kind?: ThemeKind, colors?: ColorDefinition[], themes?: ThemeDefinition[] } = {}) {
  const content = fakeContent(
    options.colors ?? [...shellColorCatalogue()],
    options.themes ?? [...shellThemeDefinitions()]
  )
  const appearance = fakeAppearance(options.kind)
  const log = createLogger()
  const service = new ThemeService(content, appearance, { log })
  const changed = vi.fn()
  service.onDidChange(changed)
  return { content, appearance, log, service, changed }
}

describe('ThemeService', () => {
  it('starts on the system kind with the shell theme and every token resolved', () => {
    const { service } = setup({ kind: 'dark' })
    const state = service.get()

    expect(state.preference).toEqual({ theme: 'system', light: 'shell.light', dark: 'shell.dark' })
    expect(state.activeTheme).toBe('shell.dark')
    expect(state.kind).toBe('dark')
    expect(state.colors['shell.accent']).toBe('#3794ff')
    expect(Object.keys(state.colors)).toHaveLength(shellColorCatalogue().length)
    expect(state.themes.map(t => t.id)).toEqual(['shell.light', 'shell.dark'])
  })

  it('follows the system while the preference is system, and not otherwise', () => {
    const { service, appearance, changed } = setup()

    appearance.set('dark')
    expect(service.get()).toMatchObject({ activeTheme: 'shell.dark', kind: 'dark' })
    expect(changed).toHaveBeenCalledTimes(1)

    service.setPreference({ theme: 'shell.light' })
    appearance.set('light')
    appearance.set('dark')
    expect(service.get()).toMatchObject({ activeTheme: 'shell.light', kind: 'light' })
    expect(changed).toHaveBeenCalledTimes(2)       // the preference change only
  })

  it('selects a contributed theme and resolves through its chain', () => {
    const { service } = setup({ colors: [...shellColorCatalogue(), token('acc.positive', '#107c10', '#89d185')], themes: [...shellThemeDefinitions(), sepia] })

    const state = service.setPreference({ theme: 'm.sepia' })

    expect(state.activeTheme).toBe('m.sepia')
    expect(state.colors).toMatchObject({ 'shell.accent': '#7a5c1e', 'shell.link': '#7a5c1e', 'acc.positive': '#3f6b1c', 'shell.background': '#ffffff' })
    expect(state.themes.map(t => t.id)).toEqual(['shell.light', 'shell.dark', 'm.sepia'])
  })

  it('uses the per-kind system themes from the preference', () => {
    const { service, appearance } = setup({ themes: [...shellThemeDefinitions(), sepia, night] })

    service.setPreference({ light: 'm.sepia', dark: 'm.night' })
    expect(service.get()).toMatchObject({ activeTheme: 'm.sepia', kind: 'light' })

    appearance.set('dark')
    expect(service.get()).toMatchObject({ activeTheme: 'm.night', kind: 'dark' })
    expect(service.get().colors['shell.accent']).toBe('#ff00ff')
  })

  it('rejects an unknown theme or a malformed request without changing anything', () => {
    const { service, changed } = setup()

    expect(() => service.setPreference({ theme: 'nope.missing' })).toThrow('Unknown theme "nope.missing"')
    expect(() => service.setPreference({ light: 'system' })).toThrow('Unknown theme "system"')
    expect(() => service.setPreference({ theme: 42 as unknown as string })).toThrow('Unknown theme "42"')
    expect(() => service.setPreference({ light: 'shell.dark' })).toThrow('"shell.dark" is not a light theme')
    expect(() => service.setPreference({ dark: 'shell.light' })).toThrow('"shell.light" is not a dark theme')
    expect(changed).not.toHaveBeenCalled()
    expect(service.get().preference.theme).toBe('system')
  })

  it('layers customisations and keeps only the well-formed entries', () => {
    const { service, log } = setup({ themes: [...shellThemeDefinitions(), sepia] })

    service.setPreference({
      customizations: {
        global: { 'shell.accent': '#111111', 'shell.border': 'red' },
        byTheme: { 'm.sepia': { 'shell.accent': '#333333' }, 'shell.light': { 'bad id': '#000' } }
      }
    })

    expect(service.get().preference.customizations).toEqual({
      global: { 'shell.accent': '#111111' },
      byTheme: { 'm.sepia': { 'shell.accent': '#333333' }, 'shell.light': {} }
    })
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(service.get().colors['shell.accent']).toBe('#111111')
    expect(service.get().colors['shell.focusBorder']).toBe('#111111')

    service.setPreference({ theme: 'm.sepia' })
    expect(service.get().colors['shell.accent']).toBe('#333333')
  })

  it('re-resolves when the content changes, and only announces a difference', () => {
    const { service, content, changed } = setup()
    const before = service.get()

    content.set([...shellColorCatalogue()])                                  // same content
    expect(changed).not.toHaveBeenCalled()
    expect(service.get()).toBe(before)

    content.set([...shellColorCatalogue(), token('acc.positive', '#107c10')])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(service.get().colors['acc.positive']).toBe('#107c10')
  })

  it('applies a theme to tokens that arrive after it, whatever the order', () => {
    const { service, content } = setup({ themes: [...shellThemeDefinitions(), sepia] })
    service.setPreference({ theme: 'm.sepia' })
    expect(service.get().colors).not.toHaveProperty('acc.positive')

    content.set([...shellColorCatalogue(), token('acc.positive', '#107c10')])
    expect(service.get().colors['acc.positive']).toBe('#3f6b1c')
  })

  it('falls back to the shell theme of the same kind when the chosen theme disappears, and comes back with it', () => {
    const { service, content, log } = setup({ themes: [...shellThemeDefinitions(), night] })
    service.setPreference({ theme: 'm.night' })

    content.set([...shellColorCatalogue()], [...shellThemeDefinitions()])
    expect(service.get()).toMatchObject({ activeTheme: 'shell.dark', kind: 'dark', preference: { theme: 'm.night' } })
    expect(log.warn).toHaveBeenCalledWith('[theme] Theme "m.night" is not available; using "shell.dark"')
    expect(log.warn).toHaveBeenCalledTimes(1)

    content.set([...shellColorCatalogue()], [...shellThemeDefinitions()])    // still absent: no second warning
    expect(log.warn).toHaveBeenCalledTimes(1)

    content.set([...shellColorCatalogue()], [...shellThemeDefinitions(), night])
    expect(service.get()).toMatchObject({ activeTheme: 'm.night', kind: 'dark' })
  })

  it('reports a resolution problem once and leaves that token out', () => {
    const { service, content, log } = setup()
    content.set([...shellColorCatalogue(), token('acc.dangling', 'acc.missing')])
    content.set([...shellColorCatalogue(), token('acc.dangling', 'acc.missing'), token('acc.other', '#fff')])

    expect(service.get().colors).not.toHaveProperty('acc.dangling')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('[theme] Colour token "acc.dangling" references unknown token "acc.missing"')
  })

  it('loads a stored preference, ignoring fields it cannot use, and saves changes', async () => {
    const saved: ThemePreference[] = []
    const persistence = {
      load: vi.fn(async () => ({ theme: 'shell.dark', light: 'bad id', dark: 'shell.light', customizations: { global: { 'shell.accent': '#123456' } } } as unknown as ThemePreference)),
      save: vi.fn(async (preference: ThemePreference) => { saved.push(preference) })
    }
    const service = new ThemeService(fakeContent([...shellColorCatalogue()], [...shellThemeDefinitions()]), fakeAppearance(), { persistence })

    const state = await service.load()
    expect(state.preference).toEqual({ theme: 'shell.dark', light: 'shell.light', dark: 'shell.dark', customizations: { global: { 'shell.accent': '#123456' } } })
    expect(state).toMatchObject({ activeTheme: 'shell.dark', kind: 'dark' })
    expect(state.colors['shell.accent']).toBe('#123456')

    service.setPreference({ theme: 'system' })
    await Promise.resolve()
    expect(saved).toEqual([{ theme: 'system', light: 'shell.light', dark: 'shell.dark', customizations: { global: { 'shell.accent': '#123456' } } }])
  })

  it('survives a persistence that fails', async () => {
    const log = createLogger()
    const persistence = { load: vi.fn(async () => { throw new Error('disk') }), save: vi.fn(async () => { throw new Error('disk') }) }
    const service = new ThemeService(fakeContent([...shellColorCatalogue()], [...shellThemeDefinitions()]), fakeAppearance(), { persistence, log })

    await service.load()
    service.setPreference({ theme: 'shell.dark' })
    await Promise.resolve()

    expect(service.get().activeTheme).toBe('shell.dark')
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('stops listening when disposed', () => {
    const { service, appearance, content, changed } = setup()
    service.dispose()

    appearance.set('dark')
    content.set([])

    expect(changed).not.toHaveBeenCalled()
  })
})
