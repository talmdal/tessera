// shell/main/theme/appearanceOptions.ts
//
// The application-wide theme selection is an option: the `appearance` branch of the shell's own namespace, chosen
// on the options dialog's Appearance page and read from tier 0 before any plugin activates — which is why
// `themeHost.load()` no longer waits for `app-state`. The per-window override stays application state: it is set
// from the View menu, applies at once, and belongs to a window, not the application.
// See docs/options-framework-design.md, decision 1.
import type { AppState, Disposable, Logger, OptionsHandle, ThemePersistence, ThemeSelection } from '@tessera/types'
import type { OptionsService } from '../../../core/options/OptionsService'
import { ThemeService } from '../../../core/theme/ThemeService'
import { SHELL_OPTIONS_DEFAULTS, ShellOptionsValue } from '../../../shared/options/types'
import { DEFAULT_SELECTION, THEME_MODES, parseStoredSelection } from '../../../shared/theme/selection'
import { THEME_STATE_KEY, themeOverrideKey } from '../../../shared/theme/types'

/**
 * Declares the shell's namespace. The theme id is checked only for shape, not against the registered themes:
 * options are read before theme-contributing plugins activate, and a selection naming a theme that is not there
 * is shown as the default until it returns — never refused, or an uninstalled plugin would wedge the setting.
 */
export function registerShellOptions(options: OptionsService): OptionsHandle<ShellOptionsValue> {
  return options.register<ShellOptionsValue>('shell', {
    defaults: SHELL_OPTIONS_DEFAULTS,
    validate: value => {
      const problems: string[] = []
      const { theme, mode } = (value.appearance ?? {}) as Partial<ThemeSelection>
      if (typeof theme !== 'string' || theme.length === 0) problems.push('The appearance needs a theme')
      if (!THEME_MODES.includes(mode as never)) problems.push('The appearance mode must be system, light or dark')
      return problems
    }
  })
}

/**
 * The theme manager's persistence, split as the design splits the data: the application-wide selection is the
 * option above; each window's override stays in `app.state`, which only exists once that plugin has activated —
 * overrides are loaded when windows open, which is after that.
 */
export function createThemeOptionsPersistence(
  handle: OptionsHandle<ShellOptionsValue>,
  options: OptionsService,
  appState: () => AppState | undefined
): ThemePersistence {
  return {
    loadGlobal: async () => handle.get().appearance,
    saveGlobal: async selection => {
      const problems = options.commit('shell', { ...handle.get(), appearance: selection })
      if (problems.length > 0) throw new Error(problems.join('; '))
    },
    loadOverride: async key => appState()?.get<unknown>(themeOverrideKey(key)),
    saveOverride: async (key, selection) => {
      const store = appState()
      if (selection === undefined) await store?.remove(themeOverrideKey(key))
      else await store?.set(themeOverrideKey(key), selection)
    }
  }
}

/**
 * Applies the option to the running application when the user saves the Appearance page. `applyGlobal` is the
 * tolerant path `loadGlobal` uses at startup: a selection naming a theme that is not registered is kept, shows
 * the default, and resolves itself when the theme's plugin arrives. It also never saves, so there is no loop —
 * the user's commit is the only write.
 */
export function bindAppearanceToTheme(handle: OptionsHandle<ShellOptionsValue>, theme: ThemeService): Disposable {
  return handle.onDidChange(value => theme.applyGlobal(value.appearance))
}

/**
 * Brings the selection saved by earlier builds (the `app.state` key `theme`) into the options file, once.
 * `app.state` only exists after the plugins activate, so on that first start the default theme shows until this
 * runs — a one-time flicker, cheaper than everyone re-picking their theme. The legacy key is then removed, which
 * is what makes it once.
 */
export async function importLegacyThemeSelection(
  appState: () => AppState | undefined,
  options: OptionsService,
  handle: OptionsHandle<ShellOptionsValue>,
  log: Logger
): Promise<void> {
  const store = appState()
  if (!store) return
  try {
    const legacy = await store.get<unknown>(THEME_STATE_KEY)
    if (legacy === undefined) return

    const { selection } = parseStoredSelection(legacy)
    const current = handle.get().appearance
    const untouched = current.theme === DEFAULT_SELECTION.theme && current.mode === DEFAULT_SELECTION.mode
    if (selection && untouched) {
      options.commit('shell', { ...handle.get(), appearance: selection })
      log.info(`[theme] Moved the saved theme to the options file: ${JSON.stringify(selection)}`)
    }
    await store.remove(THEME_STATE_KEY)
  } catch (err) {
    log.warn(`[theme] Could not move the saved theme to the options file: ${err instanceof Error ? err.message : err}`)
  }
}
