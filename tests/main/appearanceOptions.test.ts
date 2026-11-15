// @vitest-environment node
// The theme as an option: the shell namespace, the split persistence, the option→theme bridge, and the one-time
// move of the selection earlier builds kept in app-state.
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@tessera/types'
import { OptionsService } from '../../core/options/OptionsService'
import { createMemoryOptionsStore } from '../../core/options/memoryOptionsStore'
import { ThemeService } from '../../core/theme/ThemeService'
import { createPluginRuntime } from '../../core/plugins/PluginContext'
import { SHELL_OPTIONS_DEFAULTS } from '../../shared/options/types'
import { THEMES_EXTENSION_POINT, DEFAULT_THEME_ID, THEME_STATE_KEY } from '../../shared/theme/types'
import {
  bindAppearanceToTheme, createThemeOptionsPersistence, importLegacyThemeSelection, registerShellOptions
} from '../../shell/main/theme/appearanceOptions'
import { createLogger } from '../helpers/runtime'
import { fakeThemePort, midnight } from '../helpers/theme'

const SHELL = DEFAULT_THEME_ID

function fakeAppState(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  const state = {
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value) }),
    update: vi.fn(),
    remove: vi.fn(async (key: string) => { data.delete(key) })
  } as unknown as AppState
  return { data, state }
}

function setup(stored: Record<string, unknown> = {}, appStateData: Record<string, unknown> = {}) {
  const log = createLogger()
  const store = createMemoryOptionsStore(stored as never)
  const options = new OptionsService(store, { log })
  const handle = registerShellOptions(options)
  const { data, state } = fakeAppState(appStateData)
  const appState = () => state

  const runtime = createPluginRuntime(undefined, log, options)
  const theme = new ThemeService(runtime.extensions, fakeThemePort().port, {
    persistence: createThemeOptionsPersistence(handle, options, appState),
    log
  })
  bindAppearanceToTheme(handle, theme)

  const contribute = (descriptor: { id: string }) =>
    runtime.extensions.contribute('p', THEMES_EXTENSION_POINT, descriptor.id, descriptor)

  return { log, store, options, handle, data, appState, theme, contribute }
}

describe('the shell options namespace', () => {
  it('defaults to the shell theme, following the system', () => {
    const { handle } = setup()
    expect(handle.get()).toEqual(SHELL_OPTIONS_DEFAULTS)
    expect(handle.get().appearance).toEqual({ theme: SHELL, mode: 'system' })
  })

  it('checks the shape of a committed appearance, naming each problem', () => {
    const { options } = setup()

    expect(options.commit('shell', { appearance: { theme: '', mode: 'dusk' } }))
      .toEqual(['The appearance needs a theme', 'The appearance mode must be system, light or dark'])
  })

  it('accepts a theme id that is not registered: options outlive the plugin that owns a theme', () => {
    const { options } = setup()

    expect(options.commit('shell', { appearance: { theme: 'p.gone', mode: 'dark' } })).toEqual([])
  })

  it('falls back to the defaults when the stored entry is unusable', () => {
    const { handle, log } = setup({ shell: { version: 1, values: { appearance: { theme: '', mode: 7 } } } })

    expect(handle.get().appearance).toEqual({ theme: SHELL, mode: 'system' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not valid'))
  })
})

describe('the split persistence', () => {
  it('loads the global selection from the option, before any plugin or window exists', async () => {
    const { theme } = setup({ shell: { version: 1, values: { appearance: { theme: SHELL, mode: 'dark' } } } })

    await theme.loadGlobal()

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it('saves a global change into the options store, keeping the rest of the shell namespace', async () => {
    const { theme, store } = setup()
    await theme.loadGlobal()

    theme.setGlobal({ theme: SHELL, mode: 'dark' })
    await theme.flush()

    expect(store.read()).toEqual({ shell: { version: 1, values: { appearance: { mode: 'dark' } } } })
  })

  it("keeps a window's override in app-state, and removes it when cleared", async () => {
    const { theme, data } = setup()
    await theme.attach(1, 'main')

    theme.setOverride(1, { theme: SHELL, mode: 'dark' })
    await theme.flush()
    expect(data.get('shell.theme.main')).toEqual({ theme: SHELL, mode: 'dark' })

    theme.setOverride(1, undefined)
    await theme.flush()
    expect(data.has('shell.theme.main')).toBe(false)
  })

  it('never puts the global selection in app-state, nor overrides in the options file', async () => {
    const { theme, data, store } = setup()
    await theme.attach(1, 'main')

    theme.setGlobal({ theme: SHELL, mode: 'dark' })
    theme.setOverride(1, { theme: SHELL, mode: 'light' })
    await theme.flush()

    expect(data.has(THEME_STATE_KEY)).toBe(false)
    expect(JSON.stringify(store.read())).not.toContain('light')
  })
})

describe('the option → theme bridge', () => {
  it('applies a committed appearance to the running application', () => {
    const { options, theme } = setup()

    options.commit('shell', { appearance: { theme: SHELL, mode: 'dark' } })

    expect(theme.getGlobal()).toEqual({ theme: SHELL, mode: 'dark' })
  })

  it('does not loop: applying persists, persisting commits an equal value, and there it stops', async () => {
    const { options, handle, theme, store } = setup()
    const heard = vi.fn()
    handle.onDidChange(heard)

    options.commit('shell', { appearance: { theme: SHELL, mode: 'dark' } })
    await theme.flush()

    // One change event (the user's commit), not an echo per round trip; the write-back stored an equal value.
    expect(heard).toHaveBeenCalledTimes(1)
    expect(store.read().shell).toEqual({ version: 1, values: { appearance: { mode: 'dark' } } })
    expect(theme.getGlobal().mode).toBe('dark')
  })

  it('keeps a selection naming a theme that is not there, showing the default until its plugin arrives', () => {
    const { options, theme, contribute } = setup()

    options.commit('shell', { appearance: { theme: 'p.midnight', mode: 'dark' } })

    expect(theme.getGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })  // the choice is kept…
    expect(theme.resolveGlobal().theme).toBe(SHELL)                           // …the default is shown…

    contribute(midnight())
    expect(theme.resolveGlobal()).toEqual({ theme: 'p.midnight', mode: 'dark' })  // …and it resolves itself
  })
})

describe('importing the selection earlier builds kept in app-state', () => {
  it('moves a legacy value into the options file once, applying it', async () => {
    const { options, handle, data, appState, theme, log } = setup({}, { [THEME_STATE_KEY]: 'dark' })

    await importLegacyThemeSelection(appState, options, handle, log)

    expect(handle.get().appearance).toEqual({ theme: SHELL, mode: 'dark' })
    expect(theme.getGlobal().mode).toBe('dark')                          // applied through the bridge
    expect(data.has(THEME_STATE_KEY)).toBe(false)                        // what makes it once
  })

  it('leaves an appearance the user has already chosen alone, still removing the legacy key', async () => {
    const { options, handle, data, appState, log } = setup(
      { shell: { version: 1, values: { appearance: { theme: SHELL, mode: 'light' } } } },
      { [THEME_STATE_KEY]: 'dark' })

    await importLegacyThemeSelection(appState, options, handle, log)

    expect(handle.get().appearance.mode).toBe('light')
    expect(data.has(THEME_STATE_KEY)).toBe(false)
  })

  it('does nothing when there is nothing legacy, or no app-state at all', async () => {
    const { options, handle, appState, log } = setup()
    await importLegacyThemeSelection(appState, options, handle, log)
    await importLegacyThemeSelection(() => undefined, options, handle, log)

    expect(handle.get().appearance).toEqual({ theme: SHELL, mode: 'system' })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('ignores an unreadable legacy value, removing it', async () => {
    const { options, handle, data, appState, log } = setup({}, { [THEME_STATE_KEY]: { bogus: true } })

    await importLegacyThemeSelection(appState, options, handle, log)

    expect(handle.get().appearance).toEqual({ theme: SHELL, mode: 'system' })
    expect(data.has(THEME_STATE_KEY)).toBe(false)
  })

  it('survives an app-state that fails, with a warning', async () => {
    const { options, handle, log } = setup()
    const broken = { get: async () => { throw new Error('no store') } } as unknown as AppState

    await importLegacyThemeSelection(() => broken, options, handle, log)

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no store'))
  })
})
