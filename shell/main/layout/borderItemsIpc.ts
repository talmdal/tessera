// shell/main/layout/barItemsIpc.ts
import type { BorderItemDescriptor, Logger, PluginContext } from '@tessera/types'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { BAR_ITEMS_CHANGED, BAR_ITEMS_EXTENSION_POINT, BAR_ITEMS_LIST_CHANNEL } from '../../../shared/layout/types'

/**
 * Answers `shell:bar.items.list` with the current `shell.bar.items`
 * contributions, each with whether its command is enabled (the renderer does
 * not know command enablement), and publishes `shell:bar.items.changed` when
 * the set of items changes or a button's enabled flag flips. Resolved per
 * request, so it reflects plugins activated after startup.
 */
export function registerBorderItemsIpc(
  shell: PluginContext,
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined,
  publish: (event: string) => void,
  log: Logger
) {
  const describe = () => {
    const { items, diagnostics } = resolveBarItems(shell.extensions.getContributions(BAR_ITEMS_EXTENSION_POINT), iconUrlFor)
    const described: BorderItemDescriptor[] = items.map(item => ({
      ...item,
      enabled: item.command === undefined || shell.commands.isEnabled(item.command)
    }))
    return { described, diagnostics }
  }

  shell.ipc.register(BAR_ITEMS_LIST_CHANNEL, () => {
    const { described, diagnostics } = describe()
    for (const message of diagnostics) log.warn(`[layout] ${message}`)
    return described
  })

  // The last flags sent, so a command change that flips nothing costs nothing on the wire.
  const flags = () => JSON.stringify(describe().described.map(item => [item.id, item.enabled]))
  let last = flags()

  const announce = () => {
    last = flags()
    publish(BAR_ITEMS_CHANGED)
  }

  shell.subscriptions.push(
    shell.extensions.onDidChange(({ point }) => { if (point === BAR_ITEMS_EXTENSION_POINT) announce() }),
    shell.commands.onDidChange(() => { if (flags() !== last) announce() })
  )
}
