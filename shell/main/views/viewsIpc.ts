// shell/main/views/viewsIpc.ts
import { PluginContext } from '../../../core/plugins/PluginContext'
import { Logger } from '../../../core/ports'
import { resolveViews } from '../../../shared/views/resolveViews'
import { VIEWS_EXTENSION_POINT, VIEWS_LIST_EVENT } from '../../../shared/views/types'

/**
 * Answers VIEWS_LIST_CHANNEL (`shell:views.list`) with the current `shell.views` contributions.
 * Resolved per request, so it reflects plugins activated after startup.
 */
export function registerViewsIpc(
  shell: PluginContext,
  remoteEntryFor: (pluginId: string) => string | undefined,
  log: Logger
) {
  shell.ipc.handle(VIEWS_LIST_EVENT, () => {
    const { views, diagnostics } = resolveViews(shell.extensions.getContributions(VIEWS_EXTENSION_POINT), remoteEntryFor)
    for (const message of diagnostics) log.warn(`[views] ${message}`)
    return views
  })
}
