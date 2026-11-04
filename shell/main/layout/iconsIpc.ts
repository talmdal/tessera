// shell/main/layout/iconsIpc.ts
import type { Logger, PluginContext } from '@tessera/types'
import { resolveIcons } from '../../../shared/layout/resolveIcons'
import { ICONS_CHANGED, ICONS_EXTENSION_POINT, ICONS_LIST_CHANNEL } from '../../../shared/layout/types'

/**
 * Answers `shell:icons.list` with the icons plugins registered through
 * `shell.icons`: each id and the URL its SVG is fetched from, when it is first
 * drawn. Only ids and URLs cross, never the files. Resolved per request, so it
 * reflects plugins activated after startup, and `shell:icons.changed` is
 * published when the set of contributions changes.
 */
export function registerIconsIpc(
  shell: PluginContext,
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined,
  publish: (event: string) => void,
  log: Logger
) {
  shell.ipc.register(ICONS_LIST_CHANNEL, () => {
    const { icons, diagnostics } = resolveIcons(shell.extensions.getContributions(ICONS_EXTENSION_POINT), iconUrlFor)
    for (const message of diagnostics) log.warn(`[icons] ${message}`)
    return icons
  })

  shell.subscriptions.push(shell.extensions.onDidChange(({ point }) => {
    if (point === ICONS_EXTENSION_POINT) publish(ICONS_CHANGED)
  }))
}
