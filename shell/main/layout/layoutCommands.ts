// shell/main/layout/layoutCommands.ts
import type { Logger, PluginContext } from '@tessera/types'
import { LayoutService } from '../../../core/layout/LayoutService'
import { BAR_SIDES, LAYOUT_COMMANDS, layoutKey } from '../../../shared/layout/types'

/**
 * Registers the `shell.layout.*` commands. Each acts on the window `target`
 * names (the focused one, or the primary window when none is focused), and
 * throws if there is none. Toggles are enabled only while their bar has content.
 */
export function registerLayoutCommands(
  shell: PluginContext,
  layout: LayoutService,
  target: () => number,
  log: Logger
) {
  for (const side of BAR_SIDES) {
    shell.commands.register(LAYOUT_COMMANDS.toggle[side], () => { layout.toggle(target(), side) },
      { enablement: layoutKey.hasContent(side) })
  }

  shell.commands.register(LAYOUT_COMMANDS.collapseAll, () => { layout.setAllCollapsed(target(), true) })
  shell.commands.register(LAYOUT_COMMANDS.expandAll, () => { layout.setAllCollapsed(target(), false) })
  shell.commands.register(LAYOUT_COMMANDS.reset, () => { layout.reset(target()) })

  // A view that is not there is a no-op with a warning, so a plugin's navigation command can't fail on it.
  shell.commands.register(LAYOUT_COMMANDS.reveal, viewId => {
    try {
      layout.reveal(target(), viewId as string)
    } catch (err) {
      log.warn(`[layout] Could not reveal ${String(viewId)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
