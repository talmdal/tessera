// shell/main/theme/registerTheme.ts
import type {
  FontSettings, IpcMessage, Logger, PluginContext, PluginRuntime, SettingsHandle, SettingsPageContribution, ThemeDescriptor,
  ThemeModePreference, ThemeSelection, ThemeSnapshot, ThemeState
} from '@tessera/types'
import { SETTINGS_OPEN_COMMAND, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import { ThemeService } from '../../../core/theme/ThemeService'
import { PRIMARY_WINDOW_KEY } from '../../../shared/layout/types'
import { selectionFor, selectionProblem } from '../../../shared/theme/selection'
import { THEME_SETTINGS_ID, THEME_SETTINGS_MODULE, THEME_SETTINGS_PAGE } from '../../../shared/theme/settings'
import { DEFAULT_THEME_ID, THEME_CHANGED, THEME_COMMANDS, THEME_GET, themeKey } from '../../../shared/theme/types'

/** The Options dialog's Appearance page: the application's theme and mode, drawn by the shell's renderer. */
export const APPEARANCE_PAGE: SettingsPageContribution = {
  id: THEME_SETTINGS_PAGE,
  title: 'Appearance',
  description: 'The colours Tessera uses, and whether it follows your system\'s light or dark setting.',
  keywords: ['theme', 'colour', 'color', 'dark', 'light', 'mode', 'contrast'],
  settings: THEME_SETTINGS_ID,
  module: THEME_SETTINGS_MODULE,
  order: -1000
}

/** What the Electron side tells the theme manager about its windows and the saved choice. */
export interface ThemeHost {
  /** Reads the saved application-wide theme. Call after the plugins have activated, before the first window. */
  load(): Promise<void>
  /**
   * Starts tracking a window under its stable key (`main` for the primary
   * window), loading its saved override first. Resolves with its first state,
   * once it is safe to create the window.
   */
  attachWindow(windowId: number, key: string): Promise<ThemeState>
  /** Stops tracking a window. */
  detachWindow(windowId: number): Promise<void>
  /** Records that a window has focus: the theme commands and context keys follow it. */
  focus(windowId: number): void
  /** A window's theme and every registered theme, as the renderer receives them; undefined for an unknown window. */
  snapshotFor(windowId: number): ThemeSnapshot | undefined
}

/**
 * Connects the theme manager to the rest of the shell: answers a window's
 * request for its theme, publishes each window's state when it changes,
 * registers the `shell.theme.*` commands and the theme's context keys,
 * contributes the Options dialog's Appearance page, and finishes saving on
 * shutdown. `shell` is the shell's own plugin context, which owns the handlers.
 *
 * The application-wide theme is the `shell.theme` setting (`settings`), and
 * changes flow one way: the user changes it on the Appearance page (OK or
 * Apply), or a command changes it, both through the setting; the theme manager
 * follows the setting and re-themes every window, and a window's own theme
 * gives way, so the choice shows everywhere. The theme manager never writes the
 * setting back, so there are no echoes to tell apart from real changes.
 *
 * There is deliberately no request that changes the theme directly: changes go
 * through the settings (the Options dialog) or the commands.
 *
 * The user's fonts (`fonts`, the `shell.fonts` setting) travel with the theme: every snapshot carries them, so a
 * window's first frame is already drawn in them, and a change to them is published to every window, as a change of
 * theme is. Nothing here writes them.
 */
export function registerTheme(
  shell: PluginContext,
  runtime: PluginRuntime,
  theme: ThemeService,
  log: Logger,
  settings: SettingsHandle<ThemeSelection>,
  fonts: SettingsHandle<FontSettings>
): ThemeHost {
  let focused: number | undefined

  /** The window theme commands act on: the focused one, else the primary window, else the oldest. */
  const targetOrUndefined = () => {
    if (focused !== undefined && theme.isAttached(focused)) return focused
    return theme.windowIdOf(PRIMARY_WINDOW_KEY) ?? theme.windowIds()[0]
  }
  const target = () => {
    const windowId = targetOrUndefined()
    if (windowId === undefined) throw new Error('There is no window')
    return windowId
  }

  const windowOf = (msg: IpcMessage) => {
    const windowId = msg.sender?.windowId
    if (windowId === undefined || !theme.isAttached(windowId)) throw new Error(`Unknown window: ${windowId}`)
    return windowId
  }

  const snapshot = (state: ThemeState): ThemeSnapshot =>
    ({ state, themes: theme.list(), systemPrefersDark: theme.systemPrefersDark, fonts: fonts.get() })

  shell.ipc.register(THEME_GET, (msg: IpcMessage) => snapshot(theme.getState(windowOf(msg))))

  registerThemeCommands(shell, theme, target, log, settings)

  // Choosing a theme is done on the Options dialog's Appearance page; the command opens the dialog there.
  shell.commands.register(THEME_COMMANDS.choose, () => shell.commands.execute(SETTINGS_OPEN_COMMAND, THEME_SETTINGS_PAGE))
  shell.extensions.contribute(shell.pluginId, SETTINGS_PAGES_EXTENSION_POINT, APPEARANCE_PAGE.id, APPEARANCE_PAGE)

  /** Publishes the focused window's theme (the application-wide one while there is no window) as context keys. */
  const syncKeys = () => {
    const windowId = targetOrUndefined()
    const shown = windowId === undefined ? theme.resolveGlobal() : theme.getState(windowId)
    runtime.contextKeys.set(themeKey.mode, shown.mode)
    runtime.contextKeys.set(themeKey.id, shown.theme)
    runtime.contextKeys.set(themeKey.overridden, windowId !== undefined && theme.getState(windowId).override !== undefined)
  }
  syncKeys()

  shell.subscriptions.push(
    // Delivered to every window; each ignores a state that carries another window's id.
    theme.onDidChange(state => {
      runtime.events.publish(THEME_CHANGED, snapshot(state))
      syncKeys()
    }),
    // The setting is the one place the application's theme is changed (by OK or Apply in the Options dialog, or by a
    // command); the theme manager only follows it, so every window is re-themed. Once the app is running, a window's
    // own theme gives way too: the user chose a theme for Tessera. What is read at start-up leaves them alone.
    settings.onDidChange(({ value }) => {
      theme.adoptGlobal(value)
      if (runtime.lifecycle.phase === 'started') theme.clearOverrides()
    }),
    // The user's fonts changed (OK or Apply in the Options dialog, or the settings file read at start-up): every window
    // gets its snapshot again, each with its own state, as for a change of theme. The theme's state hasn't changed, so
    // the theme manager has nothing to announce; this publishes directly.
    fonts.onDidChange(() => {
      for (const windowId of theme.windowIds()) runtime.events.publish(THEME_CHANGED, snapshot(theme.getState(windowId)))
    }),
    runtime.lifecycle.onShuttingDown(() => theme.flush())
  )

  return {
    load: () => theme.loadGlobal().then(syncKeys),
    async attachWindow(windowId, key) {
      const state = await theme.attach(windowId, key)
      syncKeys()
      return state
    },
    async detachWindow(windowId) {
      if (focused === windowId) focused = undefined
      const written = theme.detach(windowId)
      syncKeys()
      await written
    },
    focus(windowId) {
      if (!theme.isAttached(windowId)) return
      focused = windowId
      syncKeys()
    },
    snapshotFor: windowId => theme.isAttached(windowId) ? snapshot(theme.getState(windowId)) : undefined
  }
}

function registerThemeCommands(shell: PluginContext, theme: ThemeService, target: () => number, log: Logger, settings: SettingsHandle<ThemeSelection>) {
  /**
   * Changes the application's theme the way the Options dialog does: through the setting, which the theme manager
   * follows. Checked against the registered themes first, with a message the user can read.
   */
  const setGlobal = (selection: unknown) => {
    const problem = selectionProblem(selection, theme.list())
    if (problem) throw new Error(problem)
    const { theme: id, mode } = selection as ThemeSelection
    return settings.update({ theme: id, mode })
  }

  const descriptorOf = (themeId: unknown): ThemeDescriptor => {
    const descriptor = theme.list().find(t => t.id === themeId)
    if (!descriptor) throw new Error(`Unknown theme "${String(themeId)}"`)
    return descriptor
  }

  /** Chooses the application's theme, keeping its mode when the theme has it and using the theme's own when it does not. */
  const selectTheme = (themeId: unknown) => setGlobal(selectionFor(descriptorOf(themeId), theme.getGlobal().mode))

  /** Changes the application-wide mode, keeping its theme; warns, and changes nothing, when the theme lacks that mode. */
  const useMode = (mode: ThemeModePreference) => {
    const current = theme.getGlobal()
    const descriptor = theme.list().find(t => t.id === current.theme) ?? theme.list().find(t => t.id === DEFAULT_THEME_ID)!
    const wanted = selectionFor(descriptor, mode)
    if (wanted.mode !== mode) {
      log.warn(`[theme] Theme "${descriptor.id}" cannot show "${mode}"`)
      return
    }
    return setGlobal(wanted)
  }

  shell.commands.register(THEME_COMMANDS.useSystem, () => useMode('system'))
  shell.commands.register(THEME_COMMANDS.useLight, () => useMode('light'))
  shell.commands.register(THEME_COMMANDS.useDark, () => useMode('dark'))
  shell.commands.register(THEME_COMMANDS.toggle, () => useMode(theme.resolveGlobal().mode === 'dark' ? 'light' : 'dark'))

  shell.commands.register(THEME_COMMANDS.select, themeId => selectTheme(themeId))
  shell.commands.register(THEME_COMMANDS.set, selection => setGlobal(selection))

  shell.commands.register(THEME_COMMANDS.setForWindow, selection => { theme.setOverride(target(), selection as ThemeSelection) })
  shell.commands.register(THEME_COMMANDS.clearWindowOverride, () => { theme.setOverride(target(), undefined) },
    { enablement: themeKey.overridden })
}
