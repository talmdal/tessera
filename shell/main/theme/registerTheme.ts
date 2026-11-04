// shell/main/theme/registerTheme.ts
import type { Disposable, IpcMessage, Logger, PluginContext, PluginRuntime, ThemeDescriptor, ThemeModePreference, ThemeSelection, ThemeSnapshot, ThemeState } from '@tessera/types'
import { ThemeService } from '../../../core/theme/ThemeService'
import { PRIMARY_WINDOW_KEY } from '../../../shared/layout/types'
import { MENUS_EXTENSION_POINT } from '../../../shared/menus/types'
import { selectionFor } from '../../../shared/theme/selection'
import { DEFAULT_THEME_ID, THEME_CHANGED, THEME_CHOOSER_OPEN, THEME_COMMANDS, THEME_GET, ThemeChooserOpen, themeKey, themeUseCommand, themeWindowUseCommand } from '../../../shared/theme/types'
import { themeMenus, themePickerItems } from './themeMenus'

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
 * registers the `shell.theme.*` commands, the View ▸ Theme menu and the theme's
 * context keys, and finishes saving on shutdown. `shell` is the shell's own
 * plugin context, which owns the handlers.
 *
 * There is deliberately no request that changes the theme: the renderer has
 * nothing to change it with yet, and until IPC senders are validated any view
 * could send it. Changes go through the commands, which any privileged code
 * can already run like every other command.
 */
export function registerTheme(shell: PluginContext, runtime: PluginRuntime, theme: ThemeService, log: Logger): ThemeHost {
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

  const snapshot = (state: ThemeState): ThemeSnapshot => ({ state, themes: theme.list(), systemPrefersDark: theme.systemPrefersDark })

  shell.ipc.register(THEME_GET, (msg: IpcMessage) => snapshot(theme.getState(windowOf(msg))))

  const { selectTheme, useThemeInWindow } = registerThemeCommands(shell, theme, target, log)

  // The chooser is a dialog in the window's own page, so opening it is an event to that window.
  shell.commands.register(THEME_COMMANDS.choose, () => {
    runtime.events.publish(THEME_CHOOSER_OPEN, { windowId: target() } satisfies ThemeChooserOpen)
  })
  for (const contribution of themeMenus) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }

  // One command and two menu items per registered theme, kept in step as themes come and go. The menu bar is
  // built once after the plugins have activated, so a theme contributed later is not listed until a restart.
  const picker = new Map<string, Disposable[]>()
  const syncPicker = () => {
    const wanted = new Map(theme.list().map(t => [`${t.id}\n${t.label}`, t]))
    for (const [key, disposables] of picker) {
      if (wanted.has(key)) continue
      for (const disposable of disposables) disposable.dispose()
      picker.delete(key)
    }
    for (const [key, descriptor] of wanted) {
      if (picker.has(key)) continue
      picker.set(key, [
        shell.commands.register(themeUseCommand(descriptor.id), () => { selectTheme(descriptor.id) }),
        shell.commands.register(themeWindowUseCommand(descriptor.id), () => { useThemeInWindow(descriptor.id) }),
        ...themePickerItems(descriptor).map(item => shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, item.id, item))
      ])
    }
  }
  syncPicker()

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
    theme.onDidChangeThemes(syncPicker),
    { dispose: () => { for (const disposables of picker.values()) for (const d of disposables) d.dispose(); picker.clear() } },
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

function registerThemeCommands(shell: PluginContext, theme: ThemeService, target: () => number, log: Logger) {
  const descriptorOf = (themeId: unknown): ThemeDescriptor => {
    const descriptor = theme.list().find(t => t.id === themeId)
    if (!descriptor) throw new Error(`Unknown theme "${String(themeId)}"`)
    return descriptor
  }

  /** Chooses the application's theme, keeping its mode when the theme has it and using the theme's own when it does not. */
  const selectTheme = (themeId: unknown) => { theme.setGlobal(selectionFor(descriptorOf(themeId), theme.getGlobal().mode)) }

  /** Gives the focused window the theme, in the mode it shows now, or the theme's own when it has no such mode. */
  const useThemeInWindow = (themeId: unknown) => {
    const windowId = target()
    const mode = theme.getState(windowId).override?.mode ?? theme.getGlobal().mode
    theme.setOverride(windowId, selectionFor(descriptorOf(themeId), mode))
  }

  /** Changes the application-wide mode, keeping its theme; warns, and changes nothing, when the theme lacks that mode. */
  const useMode = (mode: ThemeModePreference) => {
    const current = theme.getGlobal()
    const descriptor = theme.list().find(t => t.id === current.theme) ?? theme.list().find(t => t.id === DEFAULT_THEME_ID)!
    const wanted = selectionFor(descriptor, mode)
    if (wanted.mode !== mode) {
      log.warn(`[theme] Theme "${descriptor.id}" cannot show "${mode}"`)
      return
    }
    theme.setGlobal(wanted)
  }

  shell.commands.register(THEME_COMMANDS.useSystem, () => { useMode('system') })
  shell.commands.register(THEME_COMMANDS.useLight, () => { useMode('light') })
  shell.commands.register(THEME_COMMANDS.useDark, () => { useMode('dark') })
  shell.commands.register(THEME_COMMANDS.toggle, () => { useMode(theme.resolveGlobal().mode === 'dark' ? 'light' : 'dark') })

  shell.commands.register(THEME_COMMANDS.select, themeId => { selectTheme(themeId) })
  shell.commands.register(THEME_COMMANDS.set, selection => { theme.setGlobal(selection as ThemeSelection) })

  shell.commands.register(THEME_COMMANDS.setForWindow, selection => { theme.setOverride(target(), selection as ThemeSelection) })
  shell.commands.register(THEME_COMMANDS.clearWindowOverride, () => { theme.setOverride(target(), undefined) },
    { enablement: themeKey.overridden })

  return { selectTheme, useThemeInWindow }
}
