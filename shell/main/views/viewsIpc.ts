// shell/main/views/viewsIpc.ts
import { PluginContext, Logger } from '@tessera/types'
import { resolveViews } from '../../../shared/views/resolveViews'
import { VIEWS_EXTENSION_POINT, VIEWS_LIST_CHANNEL } from '../../../shared/views/types'

/**
 * Answers VIEWS_LIST_CHANNEL (`shell:views.list`) with the current `shell.views` contributions.
 * Resolved per request, so it reflects plugins activated after startup.
 */
export function registerViewsIpc(
  shell: PluginContext,
  remoteEntryFor: (pluginId: string) => string | undefined,
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined,
  log: Logger
) {
  shell.ipc.register(VIEWS_LIST_CHANNEL, () => {
    const { views, diagnostics } = resolveViews(shell.extensions.getContributions(VIEWS_EXTENSION_POINT), remoteEntryFor, iconUrlFor)
    for (const message of diagnostics) log.warn(`[views] ${message}`)
    return views
  })
}
