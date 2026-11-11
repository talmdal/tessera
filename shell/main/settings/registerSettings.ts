// shell/main/settings/registerSettings.ts
import type { IpcMessage, Logger, PluginContext, PluginRuntime } from '@tessera/types'
import { MENUS_EXTENSION_POINT, MenuContribution, TOOLS_MENU } from '../../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../../shared/plugins/manifest'
import {
  SETTINGS_CHANGED, SETTINGS_CHOOSE_FOLDER, SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, SETTINGS_OPEN_COMMAND,
  SettingsCatalogue, SettingsChanged, SettingsChooseFolder, SettingsCommitRequest, SettingsOpen, SettingsPageInfo
} from '../../../shared/settings/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

/** Tools ▸ Options…, below the plugins' Tools items and above the developer tools. */
export const settingsMenus: MenuContribution[] = [
  { kind: 'group', id: 'shell.settings', parent: TOOLS_MENU, order: SHELL_GROUP_ORDER - 1 },
  { kind: 'item', id: 'shell.tools.options', label: '&Options…', parent: TOOLS_MENU, group: 'shell.settings', command: SETTINGS_OPEN_COMMAND, accelerator: 'CmdOrCtrl+,' }
]

export interface SettingsHostOptions {
  /** A plugin's renderer remote entry URL, or undefined when it has no renderer. */
  remoteEntryFor(pluginId: string): string | undefined
  /** The window the dialog opens in: the focused one, else the first. Undefined when there is none. */
  targetWindow(): number | undefined
  log: Pick<Logger, 'info' | 'warn'>
  /** The platform's folder dialog, for a `folder` field's Browse…; without it, Browse… answers undefined. */
  chooseFolder?(windowId: number | undefined, options: SettingsChooseFolder): Promise<string | undefined>
}

/**
 * Connects the settings to the renderer and the menus: the Options dialog reads every page and namespace
 * (`shell:settings.get`) and applies its changes (`shell:settings.commit`); `shell.settings.open` (Tools ▸ Options…)
 * opens it in the focused window; every change is pushed to the windows (`shell:settings.changed`), so an open
 * dialog stays current; and pending writes finish after the last plugin has deactivated. `shell` is the shell's own
 * plugin context, which owns all of it.
 *
 * Like `shell:commands.execute`, the commit request is open to any code in a window: each namespace's `validate`
 * still decides what is saved, and every commit is logged with the window it came from.
 */
export function registerSettings(
  shell: PluginContext,
  runtime: Pick<PluginRuntime, 'settings' | 'events' | 'lifecycle'>,
  options: SettingsHostOptions
) {
  const { settings, events, lifecycle } = runtime
  const reported = new Set<string>()

  const catalogue = (): SettingsCatalogue => ({
    pages: settings.pages().map((page): SettingsPageInfo => {
      if (page.module === undefined || page.pluginId === SHELL_CONTRIBUTOR_ID) return page
      const remoteEntry = options.remoteEntryFor(page.pluginId)
      // Kept, so the pages under it stay where they belong; the dialog says it could not be displayed.
      if (remoteEntry === undefined && !reported.has(page.id)) {
        reported.add(page.id)
        options.log.warn(`[settings] Settings page "${page.id}" has a module, but "${page.pluginId}" has no renderer entry`)
      }
      return remoteEntry === undefined ? page : { ...page, remoteEntry }
    }),
    namespaces: settings.snapshots()
  })

  shell.ipc.register(SETTINGS_GET, () => catalogue())

  shell.ipc.register(SETTINGS_CHOOSE_FOLDER, async (msg: IpcMessage<SettingsChooseFolder>) => {
    const { defaultPath, title } = msg.data ?? {}
    return options.chooseFolder?.(msg.sender?.windowId, {
      ...(typeof defaultPath === 'string' && defaultPath !== '' && { defaultPath }),
      ...(typeof title === 'string' && title !== '' && { title })
    })
  })

  shell.ipc.register(SETTINGS_COMMIT, (msg: IpcMessage<SettingsCommitRequest>) => {
    const changes = msg.data?.changes
    if (!Array.isArray(changes)) throw new Error('A settings commit needs a list of changes')
    options.log.info(`[settings] Window ${msg.sender?.windowId ?? 'unknown'} applied ${changes.map(c => String(c?.id)).join(', ') || 'nothing'}`)
    return settings.commit(changes)
  })

  shell.commands.register(SETTINGS_OPEN_COMMAND, (page?: unknown) => {
    if (page !== undefined && (typeof page !== 'string' || page === '')) throw new Error('The page to open must be a settings page id')
    const windowId = options.targetWindow()
    if (windowId === undefined) throw new Error('There is no window to show the settings in')
    events.publish(SETTINGS_OPEN, { windowId, ...(page !== undefined && { page }) } satisfies SettingsOpen)
  })

  for (const contribution of settingsMenus) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }

  shell.subscriptions.push(
    settings.onDidChange(({ id, changed }) => {
      const snapshot = settings.snapshot(id)
      if (snapshot) events.publish(SETTINGS_CHANGED, { ...snapshot, changed } satisfies SettingsChanged)
    }),
    // After the last plugin has deactivated, so what a plugin changed on its way out is written too.
    lifecycle.onShutDown(() => settings.flush())
  )
}
