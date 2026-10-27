// shell/main/theme/registerTheme.ts
//
// Wires the style manager into the shell: contributes the shell's own token
// catalogue and themes (through the shell's plugin context, like its menus),
// creates the ThemeService over the extension registry, and registers the
// theme IPC, the push events, the shell.theme.* commands and context keys,
// and the View › Theme menu. See docs/style-manager-design.md.
import {
  Disposable,
  IpcMessage,
  Logger,
  PluginContext,
  PluginRuntime,
  SystemAppearance,
  ThemeDescriptor,
  ThemePersistence,
  ThemeSetRequest,
  ThemeState
} from '@tessera/types'
import { ThemeService } from '../../../core/theme/ThemeService'
import { MENUS_EXTENSION_POINT, MenuContribution, VIEW_MENU } from '../../../shared/menus/types'
import { SHELL_THEMES } from '../../../shared/theme/themes'
import { SHELL_COLOR_TOKENS } from '../../../shared/theme/tokens'
import {
  COLORS_EXTENSION_POINT,
  SYSTEM_THEME,
  THEME_CHANGED,
  THEME_CHOOSE_REQUESTED,
  THEME_GET,
  THEME_SET,
  THEMES_EXTENSION_POINT,
  ThemeChooseRequestedEvent
} from '../../../shared/theme/types'
import { createThemeContent } from './themeContent'

export const THEME_COMMANDS = {
  /** Argument: a theme id, or 'system'. */
  select: 'shell.theme.select',
  useSystem: 'shell.theme.useSystem',
  toggleDark: 'shell.theme.toggleDark',
  /** Opens the theme chooser in the focused window. */
  choose: 'shell.theme.choose',
  /** One per present theme, since menu items cannot pass arguments. */
  use: (themeId: string) => `shell.theme.use.${themeId}`
} as const

export const THEME_CONTEXT_KEYS = {
  active: 'shell.theme.active',
  kind: 'shell.theme.kind',
  system: 'shell.theme.system'
} as const

const THEME_MENU = 'shell.view.theme'
const THEME_MENU_GROUP_ORDER = 20

export interface ThemeRegistrationOptions {
  appearance: SystemAppearance
  persistence?: ThemePersistence
  /** The focused window's id, if any; the chooser opens there (every window when unknown). */
  focusedWindowId?: () => number | undefined
  /** Called with every new state, after it has been published, so the platform can follow it. */
  applyNative?: (state: ThemeState) => void
  log: Logger
}

export interface ThemeRegistration {
  service: ThemeService
}

export function registerTheme(
  shell: PluginContext,
  runtime: PluginRuntime,
  { appearance, persistence, focusedWindowId, applyNative, log }: ThemeRegistrationOptions
): ThemeRegistration {
  const { events, contextKeys, commands, extensions } = runtime

  // The built-ins go in before the service exists, so its first state already has them.
  for (const token of SHELL_COLOR_TOKENS) {
    shell.subscriptions.push(shell.extensions.contribute(shell.pluginId, COLORS_EXTENSION_POINT, token.id, token))
  }
  for (const theme of SHELL_THEMES) {
    shell.subscriptions.push(shell.extensions.contribute(shell.pluginId, THEMES_EXTENSION_POINT, theme.id, theme))
  }

  const service = new ThemeService(createThemeContent(extensions, log), appearance, { persistence, log })

  // ---- Context keys ---------------------------------------------------------

  const refreshContextKeys = (state: ThemeState) => {
    contextKeys.set(THEME_CONTEXT_KEYS.active, state.activeTheme)
    contextKeys.set(THEME_CONTEXT_KEYS.kind, state.kind)
    contextKeys.set(THEME_CONTEXT_KEYS.system, state.preference.theme === SYSTEM_THEME || undefined)
  }

  // ---- One command and one menu item per present theme ----------------------

  const perTheme = new Map<string, Disposable[]>()
  const syncThemeCommands = (themes: readonly ThemeDescriptor[]) => {
    const present = new Set(themes.map(theme => theme.id))
    for (const [id, disposables] of perTheme) {
      if (present.has(id)) continue
      for (const disposable of disposables) disposable.dispose()
      perTheme.delete(id)
    }
    themes.forEach((theme, index) => {
      if (perTheme.has(theme.id)) return
      const command = THEME_COMMANDS.use(theme.id)
      perTheme.set(theme.id, [
        shell.commands.register(command, () => { service.setPreference({ theme: theme.id }) }),
        shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, `${THEME_MENU}.use.${theme.id}`, {
          kind: 'item', id: `${THEME_MENU}.use.${theme.id}`, label: theme.label,
          parent: THEME_MENU, group: 'shell.theme.themes', command, order: index
        } satisfies MenuContribution)
      ])
    })
  }
  shell.subscriptions.push({
    dispose: () => {
      for (const disposables of perTheme.values()) for (const disposable of disposables) disposable.dispose()
      perTheme.clear()
    }
  })

  // ---- Push events ----------------------------------------------------------

  shell.subscriptions.push(
    service,
    service.onDidChange(state => {
      events.publish(THEME_CHANGED, state)
      refreshContextKeys(state)
      syncThemeCommands(state.themes)
      applyNative?.(state)
    })
  )

  // ---- IPC ------------------------------------------------------------------

  shell.subscriptions.push(
    shell.ipc.register(THEME_GET, () => service.get()),
    shell.ipc.register<ThemeSetRequest, ThemeState>(THEME_SET, (msg: IpcMessage<ThemeSetRequest>) => {
      if (typeof msg.data !== 'object' || msg.data === null) throw new Error('A preference is required')
      log.info(`[theme] Window ${msg.sender?.windowId ?? '?'} set ${JSON.stringify(msg.data)}`)
      return service.setPreference(msg.data)
    })
  )

  // ---- Commands -------------------------------------------------------------

  shell.commands.register(THEME_COMMANDS.select, (theme: unknown) => {
    if (typeof theme !== 'string') throw new Error('shell.theme.select needs a theme id or "system"')
    service.setPreference({ theme })
  })
  shell.commands.register(THEME_COMMANDS.useSystem, () => { service.setPreference({ theme: SYSTEM_THEME }) },
    { enablement: `!${THEME_CONTEXT_KEYS.system}` })
  shell.commands.register(THEME_COMMANDS.toggleDark, () => {
    const { kind, preference } = service.get()
    service.setPreference({ theme: kind === 'dark' ? preference.light : preference.dark })
  })
  shell.commands.register(THEME_COMMANDS.choose, () => {
    events.publish(THEME_CHOOSE_REQUESTED, { windowId: focusedWindowId?.() } satisfies ThemeChooseRequestedEvent)
  })

  // ---- The View › Theme menu --------------------------------------------------

  const menu: MenuContribution[] = [
    { kind: 'group', id: 'shell.theme', parent: VIEW_MENU, order: THEME_MENU_GROUP_ORDER },
    { kind: 'menu', id: THEME_MENU, label: 'T&heme', parent: VIEW_MENU, group: 'shell.theme' },
    { kind: 'group', id: 'shell.theme.actions', parent: THEME_MENU },
    { kind: 'item', id: `${THEME_MENU}.choose`, label: '&Choose Theme…', parent: THEME_MENU, group: 'shell.theme.actions', command: THEME_COMMANDS.choose },
    { kind: 'item', id: `${THEME_MENU}.system`, label: 'Follow &System', parent: THEME_MENU, group: 'shell.theme.actions', command: THEME_COMMANDS.useSystem },
    { kind: 'item', id: `${THEME_MENU}.toggle`, label: 'Toggle &Light/Dark', parent: THEME_MENU, group: 'shell.theme.actions', command: THEME_COMMANDS.toggleDark },
    { kind: 'group', id: 'shell.theme.themes', parent: THEME_MENU, order: 10 }
  ]
  for (const contribution of menu) {
    shell.subscriptions.push(shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution))
  }

  const initial = service.get()
  refreshContextKeys(initial)
  syncThemeCommands(initial.themes)

  return { service }
}
