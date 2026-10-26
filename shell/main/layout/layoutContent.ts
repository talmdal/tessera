// shell/main/layout/layoutContent.ts
//
// Feeds the LayoutService with what has been contributed, and resolves the
// bar-item catalogue for the renderer. Both read the extension registry per
// call, so they always reflect the current plugins.
import { BarItemDescriptor, ExtensionRegistry, Logger } from '@tessera/types'
import { LayoutContentSource } from '../../../core/layout/LayoutService'
import { resolveBarItems } from '../../../shared/layout/resolveBarItems'
import { BAR_ITEMS_EXTENSION_POINT } from '../../../shared/layout/types'
import { resolveViews } from '../../../shared/views/resolveViews'
import { VIEWS_EXTENSION_POINT } from '../../../shared/views/types'
export interface LayoutResources {
  remoteEntryFor(pluginId: string): string | undefined
  assetUrlFor(pluginId: string, relativePath: string): string | undefined
  isCommandEnabled(commandId: string): boolean
}

export interface LayoutContent {
  /** What the LayoutService watches. Diagnostics are left to the list handlers. */
  source: LayoutContentSource
  /** The validated bar-item catalogue, with enabled flags; logs diagnostics. */
  listItems(): BarItemDescriptor[]
}

export function createLayoutContent(
  extensions: ExtensionRegistry,
  resources: LayoutResources,
  log: Logger
): LayoutContent {
  const resolveAllViews = () =>
    resolveViews(extensions.getContributions(VIEWS_EXTENSION_POINT), resources)

  const resolveAllItems = () =>
    resolveBarItems(extensions.getContributions(BAR_ITEMS_EXTENSION_POINT), resources)

  return {
    source: {
      views: () => resolveAllViews().views.map(({ id, slot, when }) => ({ id, slot, when })),
      items: () => resolveAllItems().items.map(({ id, slot, when }) => ({ id, slot, when })),
      onDidChange: listener => extensions.onDidChange(({ point }) => {
        if (point === VIEWS_EXTENSION_POINT || point === BAR_ITEMS_EXTENSION_POINT) listener()
      })
    },
    listItems: () => {
      const { items, diagnostics } = resolveAllItems()
      for (const message of diagnostics) log.warn(`[layout] ${message}`)
      return items
    }
  }
}
