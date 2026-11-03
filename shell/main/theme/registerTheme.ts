// shell/main/theme/registerTheme.ts
import type { Disposable, IpcMessage, PluginContext, PluginRuntime, ThemeMode, ThemeSelection, ThemeSet } from '@tessera/types'
import { ThemeService } from '../../../core/theme/ThemeService'
import { MENUS_EXTENSION_POINT } from '../../../shared/menus/types'
import {
  SHELL_THEME,
  THEME_CHANGED,
  THEME_COMMANDS,
  THEME_GET,
  THEME_MODES,
  THEME_PICKER_OPEN,
  THEME_SET,
  THEMES_CHANGED,
  THEMES_EXTENSION_POINT,
  THEMES_LIST,
  ThemePickerOpen,
  isThemeMode,
  themeKey
} from '../../../shared/themes/types'
import { themeMenuItem, themeMenus } from './themeMenus'

export interface ThemeHostOptions {
  /** The window the chooser opens in: the focused one. Undefined when there is none. */
  focusedWindow(): number | undefined
  /** Called with every new selection, to make the native parts of the window follow it. */
  applyNative?(selection: ThemeSelection): void
}

/**
 * Connects the theme service to the rest of the shell: contributes the shell's
 * own theme, answers the renderer's requests, publishes changes, registers the
 * `shell.theme.*` commands and the View › Theme menu, and keeps the theme
 * context keys current. `shell` is the shell's own plugin context, which owns
 * the handlers. Must run before plugins activate, so the menu sees their themes.
 */
export function registerTheme(shell: PluginContext, runtime: PluginRuntime, themes: ThemeService, host: ThemeHostOptions) {
  const { events, contextKeys, logger } = runtime

  shell.extensions.contribute(shell.pluginId, THEMES_EXTENSION_POINT, SHELL_THEME.id, SHELL_THEME)
  for (const contribution of themeMenus) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }

  shell.ipc.register(THEMES_LIST, () => themes.themes())
  shell.ipc.register(THEME_GET, () => themes.selection())
  shell.ipc.register(THEME_SET, (msg: IpcMessage<ThemeSet>) => themes.set(msg.data ?? {}))

  // Commands. `set` takes a request object, or (themeId, mode) as positional arguments.
  shell.commands.register(THEME_COMMANDS.set, (request, mode) => {
    if (typeof request === 'object' && request !== null) return themes.set(request as ThemeSet)
    return themes.set({
      ...(typeof request === 'string' && { themeId: request }),
      ...(isThemeMode(mode) && { mode })
    })
  })
  shell.commands.register(THEME_COMMANDS.toggleMode, () => themes.toggleMode())
  for (const mode of THEME_MODES) {
    shell.commands.register(THEME_COMMANDS.mode(mode as ThemeMode), () => themes.set({ mode: mode as ThemeMode }))
  }
  shell.commands.register(THEME_COMMANDS.choose, () => {
    const windowId = host.focusedWindow()
    if (windowId === undefined) {
      logger.warn('[themes] No window to open the theme chooser in')
      return
    }
    events.publish(THEME_PICKER_OPEN, { windowId } satisfies ThemePickerOpen)
  })

  // One `use` command and one menu item per theme, following the catalogue. Menu structure is built once
  // after activation, so items for the themes plugins contribute during it are in the menu.
  const perTheme = new Map<string, Disposable[]>()
  const syncThemes = () => {
    const current = new Set(themes.themes().map(theme => theme.id))
    for (const [id, disposables] of perTheme) {
      if (current.has(id)) continue
      for (const disposable of disposables) disposable.dispose()
      perTheme.delete(id)
    }
    themes.themes().forEach((theme, order) => {
      if (perTheme.has(theme.id)) return
      perTheme.set(theme.id, [
        shell.commands.register(THEME_COMMANDS.use(theme.id), () => themes.set({ themeId: theme.id })),
        shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, `shell.view.theme.use.${theme.id}`, themeMenuItem(theme, order))
      ])
    })
  }

  const syncSelection = (selection: ThemeSelection) => {
    contextKeys.set(themeKey.id, selection.effectiveThemeId)
    contextKeys.set(themeKey.mode, selection.mode)
    contextKeys.set(themeKey.resolvedMode, selection.resolvedMode)
    host.applyNative?.(selection)
    events.publish(THEME_CHANGED, selection)
  }

  syncThemes()
  syncSelection(themes.selection())

  shell.subscriptions.push(
    themes.onDidChangeThemes(() => {
      syncThemes()
      events.publish(THEMES_CHANGED)
    }),
    themes.onDidChangeSelection(syncSelection),
    { dispose: () => { for (const disposables of perTheme.values()) disposables.forEach(d => d.dispose()) } }
  )
}
