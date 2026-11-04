import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_THEME_ID } from '../../shared/theme/types'
import { createLogger } from '../helpers/runtime'
import { memoryThemePersistence, midnight, setupTheme, sunrise } from '../helpers/theme'

const SHELL = DEFAULT_THEME_ID

describe('ThemeService: defaults', () => {
  it("starts on the shell's theme following the system, and tells the platform", () => {
    const { theme, platform } = setupTheme()

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'system' })
    expect(theme.list().map(t => t.id)).toEqual([SHELL])
    expect(theme.resolveGlobal()).toEqual({ theme: SHELL, mode: 'light' })
    expect(platform.sources).toEqual(['system'])
  })

  it('shows what the OS shows to a window with no override', async () => {
    const { theme } = setupTheme({ systemDark: true })
    await theme.attach(1)

    expect(theme.getState(1)).toEqual({ windowId: 1, global: { theme: SHELL, mode: 'system' }, theme: SHELL, mode: 'dark' })
  })

  it('rejects a window it does not know', () => {
    const { theme } = setupTheme()

    expect(() => theme.getState(9)).toThrow('Unknown window: 9')
    expect(() => theme.setOverride(9, undefined)).toThrow('Unknown window: 9')
  })
})

describe('ThemeService: following the system', () => {
  it('updates every window that follows the system when the OS changes', async () => {
    const { theme, platform, changes } = setupTheme()
    await theme.attach(1)
    await theme.attach(2)

    platform.setSystemDark(true)

    expect(changes.map(s => [s.windowId, s.mode])).toEqual([[1, 'dark'], [2, 'dark']])
    expect(theme.getState(1).mode).toBe('dark')
  })

  it('stays silent when the OS changes under an explicit mode', async () => {
    const { theme, platform, changes } = setupTheme()
    await theme.attach(1)
    theme.setGlobal({ theme: SHELL, mode: 'light' })
    changes.length = 0

    platform.setSystemDark(true)

    expect(changes).toEqual([])
    expect(theme.getState(1).mode).toBe('light')
  })

  it('stays silent when the OS changes but nothing a window shows does', async () => {
    const { theme, platform, changes } = setupTheme({ systemDark: true })
    await theme.attach(1)

    platform.setSystemDark(true)

    expect(changes).toEqual([])
  })

  it('does not listen after it is disposed', async () => {
    const { theme, platform, changes } = setupTheme()
    await theme.attach(1)

    theme.dispose()
    platform.setSystemDark(true)

    expect(changes).toEqual([])
    expect(platform.listeners.size).toBe(0)
  })
})

describe('ThemeService: the application-wide selection', () => {
  it('changes every window and the platform chrome', async () => {
    const { theme, platform, changes } = setupTheme()
    await theme.attach(1)
    await theme.attach(2)

    theme.setGlobal({ theme: SHELL, mode: 'dark' })

    expect(changes.map(s => [s.windowId, s.mode, s.global.mode])).toEqual([[1, 'dark', 'dark'], [2, 'dark', 'dark']])
    expect(platform.sources).toEqual(['system', 'dark'])
  })

  it('says nothing when set to what it already is', async () => {
    const { theme, platform, changes } = setupTheme()
    await theme.attach(1)

    theme.setGlobal({ theme: SHELL, mode: 'system' })

    expect(changes).toEqual([])
    expect(platform.sources).toEqual(['system'])
  })

  it('refuses a selection that cannot be used, with a reason, and changes nothing', async () => {
    const { theme, contribute, changes } = setupTheme()
    contribute(midnight())
    await theme.attach(1)

    expect(() => theme.setGlobal({ theme: 'p.nope', mode: 'dark' })).toThrow('Unknown theme "p.nope"')
    expect(() => theme.setGlobal({ theme: 'p.midnight', mode: 'system' })).toThrow('cannot follow the system')
    expect(() => theme.setGlobal({ theme: SHELL, mode: 'sepia' as never })).toThrow('Unknown theme mode')
    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'system' })
    expect(changes).toEqual([])
  })

  it('keeps the platform on the theme\'s own mode when the theme has one variant', () => {
    const { theme, platform, contribute } = setupTheme()
    contribute(midnight())

    theme.setGlobal({ theme: 'p.midnight', mode: 'dark' })

    expect(platform.sources.at(-1)).toBe('dark')
    expect(theme.resolveGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })
  })

  it('returns a copy, so a caller cannot change it', () => {
    const { theme } = setupTheme()
    theme.getGlobal().mode = 'dark'

    expect(theme.getGlobal().mode).toBe('system')
  })
})

describe('ThemeService: window overrides', () => {
  it('lets one window differ, and leaves the others on the global setting', async () => {
    const { theme, changes, contribute } = setupTheme()
    contribute(midnight())
    await theme.attach(1)
    await theme.attach(2)

    theme.setOverride(2, { theme: 'p.midnight', mode: 'dark' })

    expect(changes.map(s => s.windowId)).toEqual([2])
    expect(theme.getState(1)).toMatchObject({ theme: SHELL, mode: 'light' })
    expect(theme.getState(2)).toMatchObject({
      theme: 'p.midnight', mode: 'dark', override: { theme: 'p.midnight', mode: 'dark' }, global: { theme: SHELL, mode: 'system' }
    })
  })

  it('keeps a window pinned to a theme that cannot follow the system, whatever the OS does', async () => {
    const { theme, platform, changes, contribute } = setupTheme()
    contribute(midnight())
    await theme.attach(1)
    await theme.attach(2)
    theme.setOverride(2, { theme: 'p.midnight', mode: 'dark' })
    changes.length = 0

    platform.setSystemDark(true)
    platform.setSystemDark(false)

    expect(changes.filter(s => s.windowId === 2)).toEqual([])
    expect(theme.getState(2).mode).toBe('dark')
  })

  it('does not ask the platform to change: native chrome follows the global setting only', async () => {
    const { theme, platform, contribute } = setupTheme()
    contribute(midnight())
    await theme.attach(1)
    const before = [...platform.sources]

    theme.setOverride(1, { theme: 'p.midnight', mode: 'dark' })

    expect(platform.sources).toEqual(before)
  })

  it('lets an override follow the system independently of an explicit global mode', async () => {
    const { theme, platform, contribute } = setupTheme({ systemDark: true })
    contribute(sunrise())
    await theme.attach(1)
    theme.setGlobal({ theme: SHELL, mode: 'light' })

    theme.setOverride(1, { theme: 'p.sunrise', mode: 'system' })
    expect(theme.getState(1)).toMatchObject({ theme: 'p.sunrise', mode: 'dark' })

    platform.setSystemDark(false)
    expect(theme.getState(1).mode).toBe('light')
  })

  it('clears an override with undefined, returning the window to the global setting', async () => {
    const { theme, changes, contribute } = setupTheme()
    contribute(midnight())
    await theme.attach(1)
    theme.setOverride(1, { theme: 'p.midnight', mode: 'dark' })
    changes.length = 0

    theme.setOverride(1, undefined)

    expect(changes).toHaveLength(1)
    expect(theme.getState(1)).toEqual({ windowId: 1, global: { theme: SHELL, mode: 'system' }, theme: SHELL, mode: 'light' })
  })

  it('says nothing when the override is unchanged, or there is none to clear', async () => {
    const { theme, changes, contribute } = setupTheme()
    contribute(midnight())
    await theme.attach(1)

    theme.setOverride(1, undefined)
    theme.setOverride(1, { theme: 'p.midnight', mode: 'dark' })
    changes.length = 0
    theme.setOverride(1, { theme: 'p.midnight', mode: 'dark' })

    expect(changes).toEqual([])
  })

  it('refuses an invalid override', async () => {
    const { theme } = setupTheme()
    await theme.attach(1)

    expect(() => theme.setOverride(1, { theme: 'p.nope', mode: 'dark' })).toThrow('Unknown theme "p.nope"')
    expect(theme.getState(1).override).toBeUndefined()
  })

  it('finds a window by its key, and forgets it when it is detached', async () => {
    const { theme } = setupTheme()
    await theme.attach(4, 'main')

    expect(theme.windowIdOf('main')).toBe(4)
    expect(theme.windowIds()).toEqual([4])

    await theme.detach(4)

    expect(theme.isAttached(4)).toBe(false)
    expect(theme.windowIdOf('main')).toBeUndefined()
  })
})

describe('ThemeService: contributed themes', () => {
  it('registers valid contributions after the shell theme, and reports invalid ones once', () => {
    const log = createLogger()
    const { theme, contribute } = setupTheme({ log })

    contribute(sunrise())
    contribute({ id: 'p.bad', label: 'Bad' })
    contribute(midnight())

    expect(theme.list().map(t => t.id)).toEqual([SHELL, 'p.sunrise', 'p.midnight'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[theme] Theme "p.bad" needs a light or a dark variant'))
    // A later contribution does not repeat a problem that was already reported
    expect(vi.mocked(log.warn).mock.calls.filter((c: unknown[]) => String(c[0]).includes('p.bad'))).toHaveLength(1)
  })

  it('republishes every window when the themes change, so renderers get the new list', async () => {
    const { theme, changes, contribute } = setupTheme()
    await theme.attach(1)
    await theme.attach(2)

    contribute(sunrise())

    expect(changes.map(s => s.windowId)).toEqual([1, 2])
  })

  it('ignores contributions to other extension points', async () => {
    const { theme, extensions, changes } = setupTheme()
    await theme.attach(1)

    extensions.contribute('p', 'shell.views', 'p.v', { id: 'p.v' })

    expect(changes).toEqual([])
  })

  it('falls back to the shell theme when the selected one goes away, and keeps the choice for when it returns', async () => {
    const log = createLogger()
    const { theme, contribute } = setupTheme({ log })
    const registration = contribute(midnight())
    await theme.attach(1)
    theme.setGlobal({ theme: 'p.midnight', mode: 'dark' })

    registration.dispose()

    expect(theme.getState(1)).toMatchObject({ theme: SHELL, mode: 'dark', global: { theme: 'p.midnight', mode: 'dark' } })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Theme "p.midnight" is not available'))

    contribute(midnight())
    expect(theme.getState(1)).toMatchObject({ theme: 'p.midnight', mode: 'dark' })
  })

  it('warns about a missing theme once, not on every update', async () => {
    const log = createLogger()
    const { persistence } = memoryThemePersistence({ overrides: { main: { theme: 'p.gone', mode: 'light' } } })
    const { theme, platform } = setupTheme({ log, persistence })
    await theme.attach(1, 'main')

    platform.setSystemDark(true)
    platform.setSystemDark(false)
    theme.getState(1)

    expect(vi.mocked(log.warn).mock.calls.filter((c: unknown[]) => String(c[0]).includes('"p.gone" is not available'))).toHaveLength(1)
  })
})

describe('ThemeService: persistence', () => {
  it('loads the saved global selection and applies it to the platform', async () => {
    const { persistence } = memoryThemePersistence({ global: { theme: SHELL, mode: 'dark' } })
    const { theme, platform } = setupTheme({ persistence })

    await theme.loadGlobal()

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
    expect(platform.sources.at(-1)).toBe('dark')
  })

  it("migrates the old hook's value", async () => {
    const { persistence } = memoryThemePersistence({ global: 'dark' })
    const { theme } = setupTheme({ persistence })

    await theme.loadGlobal()

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it('announces to windows that already exist when the saved choice arrives', async () => {
    const { persistence } = memoryThemePersistence({ global: 'dark' })
    const { theme, changes } = setupTheme({ persistence })
    await theme.attach(1)

    await theme.loadGlobal()

    expect(changes).toHaveLength(1)
  })

  it('warns about, and ignores, a saved value it cannot read', async () => {
    const log = createLogger()
    const { persistence } = memoryThemePersistence({ global: 'purple' })
    const { theme } = setupTheme({ persistence, log })

    await theme.loadGlobal()

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'system' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[theme] Ignored an unreadable saved theme: "purple"'))
  })

  it('keeps the defaults, with a warning, when loading fails', async () => {
    const log = createLogger()
    const { persistence } = memoryThemePersistence()
    vi.mocked(persistence.loadGlobal).mockRejectedValue(new Error('disk gone'))
    const { theme } = setupTheme({ persistence, log })

    await theme.loadGlobal()

    expect(theme.getGlobal().mode).toBe('system')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not load the saved theme: disk gone'))
  })

  it('saves the global selection when it changes, and only then', async () => {
    const { persistence, store } = memoryThemePersistence()
    const { theme } = setupTheme({ persistence })

    theme.setGlobal({ theme: SHELL, mode: 'system' })
    theme.setGlobal({ theme: SHELL, mode: 'dark' })
    await theme.flush()

    expect(persistence.saveGlobal).toHaveBeenCalledTimes(1)
    expect(store.global).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it("loads a window's saved override when it attaches, and applies it to its first state", async () => {
    const { persistence } = memoryThemePersistence({ overrides: { main: { theme: 'p.midnight', mode: 'dark' } } })
    const { theme, contribute } = setupTheme({ persistence })
    contribute(midnight())

    const state = await theme.attach(1, 'main')

    expect(state).toMatchObject({ theme: 'p.midnight', mode: 'dark', override: { theme: 'p.midnight', mode: 'dark' } })
    expect(persistence.loadOverride).toHaveBeenCalledWith('main')
  })

  it('keeps a saved override whose theme is not registered, falling back to the shell theme meanwhile', async () => {
    const { persistence } = memoryThemePersistence({ overrides: { main: { theme: 'p.gone', mode: 'dark' } } })
    const { theme } = setupTheme({ persistence })

    const state = await theme.attach(1, 'main')

    expect(state).toMatchObject({ theme: SHELL, mode: 'dark', override: { theme: 'p.gone', mode: 'dark' } })
  })

  it('does not look up a window that has no key', async () => {
    const { persistence } = memoryThemePersistence()
    const { theme } = setupTheme({ persistence })

    await theme.attach(1)
    theme.setOverride(1, { theme: SHELL, mode: 'dark' })
    await theme.flush()

    expect(persistence.loadOverride).not.toHaveBeenCalled()
    expect(persistence.saveOverride).not.toHaveBeenCalled()
  })

  it("saves a window's override under its key, and removes it when cleared", async () => {
    const { persistence, store } = memoryThemePersistence()
    const { theme } = setupTheme({ persistence })
    await theme.attach(1, 'main')

    theme.setOverride(1, { theme: SHELL, mode: 'dark' })
    await theme.flush()
    expect(store.overrides.get('main')).toEqual({ theme: SHELL, mode: 'dark' })

    theme.setOverride(1, undefined)
    await theme.flush()
    expect(store.overrides.has('main')).toBe(false)
  })

  it('warns, and starts with no override, when a window\'s saved theme is unreadable or cannot be loaded', async () => {
    const log = createLogger()
    const { persistence } = memoryThemePersistence({ overrides: { main: 7 } })
    vi.mocked(persistence.loadOverride).mockImplementation(async key => {
      if (key === 'broken') throw new Error('nope')
      return 7
    })
    const { theme } = setupTheme({ persistence, log })

    const unreadable = await theme.attach(1, 'main')
    const failed = await theme.attach(2, 'broken')

    expect(unreadable.override).toBeUndefined()
    expect(failed.override).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('(window "main")'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not load the theme of window "broken": nope'))
  })

  it('logs a failed write and keeps going, rather than throwing into a command', async () => {
    const log = createLogger()
    const { persistence } = memoryThemePersistence()
    vi.mocked(persistence.saveGlobal).mockRejectedValueOnce(new Error('read-only'))
    const { theme } = setupTheme({ persistence, log })

    theme.setGlobal({ theme: SHELL, mode: 'dark' })
    await theme.flush()
    theme.setGlobal({ theme: SHELL, mode: 'light' })
    await theme.flush()

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Could not save the theme: read-only'))
    expect(persistence.saveGlobal).toHaveBeenCalledTimes(2)
  })

  it('works without persistence, for the session', async () => {
    const { theme } = setupTheme()

    await theme.loadGlobal()
    await theme.attach(1, 'main')
    theme.setGlobal({ theme: SHELL, mode: 'dark' })
    theme.setOverride(1, { theme: SHELL, mode: 'light' })
    await theme.flush()

    expect(theme.getState(1).mode).toBe('light')
  })
})

describe('ThemeService: themes changing', () => {
  it('tells listeners when a theme is added, changed or removed, even with no window', () => {
    const { theme, contribute } = setupTheme()
    const lists: string[][] = []
    theme.onDidChangeThemes(list => lists.push(list.map(t => t.id)))

    const sunriseReg = contribute(sunrise())
    contribute(midnight())
    sunriseReg.dispose()

    expect(lists).toEqual([
      ['tessera.default', 'p.sunrise'],
      ['tessera.default', 'p.sunrise', 'p.midnight'],
      ['tessera.default', 'p.midnight']
    ])
  })

  it('says nothing for a contribution that changes no theme, such as an invalid one', () => {
    const { theme, contribute } = setupTheme()
    const lists: unknown[] = []
    theme.onDidChangeThemes(list => lists.push(list))

    contribute({ id: 'p.bad', label: 'Bad' })

    expect(lists).toEqual([])
  })
})

describe('ThemeService: themes that are hard to read', () => {
  const fine = { id: 'p.fine', label: 'Fine', light: { primary: '#1565c0' }, dark: { primary: '#90caf9' } }
  const grey = { id: 'p.grey', label: 'Grey', light: { background: { default: '#cccccc', paper: '#cccccc' }, text: { primary: '#bbbbbb', secondary: '#bbbbbb' } } }

  it('warns about a contributed theme below WCAG AA, naming the pair and the ratio, but still registers it', () => {
    const log = createLogger()
    const { theme, contribute } = setupTheme({ log })

    contribute(grey)

    expect(theme.list().map(t => t.id)).toContain('p.grey')
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/\[theme\] Theme "p\.grey" may be hard to read: text\.primary on background\.default is \d+\.\d:1 in light mode \(WCAG AA asks for 4\.5:1\)/))
  })

  it('can be chosen anyway: the user may want it', () => {
    const { theme, contribute } = setupTheme()
    contribute(grey)

    expect(() => theme.setGlobal({ theme: 'p.grey', mode: 'light' })).not.toThrow()
  })

  it('warns once per theme, not on every update, and again when the theme changes', () => {
    const log = createLogger()
    const { theme, platform, contribute } = setupTheme({ log })
    const count = () => vi.mocked(log.warn).mock.calls.filter((c: unknown[]) => String(c[0]).includes('may be hard to read')).length

    contribute(grey)
    const first = count()
    contribute(fine)
    platform.setSystemDark(true)
    expect(count()).toBe(first)

    contribute({ ...grey, id: 'p.grey2' })
    expect(count()).toBeGreaterThan(first)
    expect(theme.list()).toHaveLength(4)
  })

  it('does not warn about themes that are readable, or about the shell\'s own', () => {
    const log = createLogger()
    const { contribute } = setupTheme({ log })

    contribute(fine)
    contribute(midnight())

    expect(vi.mocked(log.warn).mock.calls.filter((c: unknown[]) => String(c[0]).includes('hard to read'))).toEqual([])
  })
})
