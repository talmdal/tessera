import { vi } from 'vitest'
import type { LayoutPersistence, LayoutState, PersistedLayout } from '@tessera/types'
import { ContextKeyServiceImpl } from '../../core/context/ContextKeyService'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import { LayoutOptions, LayoutService } from '../../core/layout/LayoutService'
import { BAR_ITEMS_EXTENSION_POINT } from '../../shared/layout/types'
import { VIEWS_EXTENSION_POINT } from '../../shared/views/types'

/** A layout controller over real registries, with helpers to contribute views and items. */
export function setupLayout(
  entries: Record<string, string | undefined> = { p: 'tessera-plugin://p/remoteEntry.js' },
  options: LayoutOptions = {}
) {
  const extensions = new ExtensionRegistryImpl()
  const contextKeys = new ContextKeyServiceImpl()
  const iconUrlFor = (pluginId: string, relative: string) => entries[pluginId] ? `tessera-plugin://${pluginId}/${relative}` : undefined
  const layout = new LayoutService(extensions, contextKeys, { remoteEntryFor: id => entries[id], iconUrlFor }, options)
  const changes: LayoutState[] = []
  layout.onDidChange(state => changes.push(state))

  /** Bar views need an icon; the main slot does not. */
  const contribute = (id: string, slot: string, extra: Record<string, unknown> = {}, contributor = 'p') =>
    extensions.contribute(contributor, VIEWS_EXTENSION_POINT, id, {
      id, title: id, slot, module: './V', ...(slot !== 'shell.main' && { icon: 'Home' }), ...extra
    })

  const contributeItem = (id: string, slot: string, extra: Record<string, unknown> = {}, contributor = 'p') =>
    extensions.contribute(contributor, BAR_ITEMS_EXTENSION_POINT, id, { kind: 'button', id, slot, label: id, command: 'p.cmd', ...extra })

  return { extensions, contextKeys, layout, changes, contribute, contributeItem, entries }
}

/** A persistence port backed by a map, recording what was saved. */
export function memoryPersistence(initial: Record<string, PersistedLayout> = {}) {
  const store = new Map<string, PersistedLayout>(Object.entries(initial))
  const persistence: LayoutPersistence & { saves: [string, PersistedLayout][] } = {
    saves: [],
    load: vi.fn(async (key: string) => store.get(key)),
    save: vi.fn(async (key: string, layout: PersistedLayout) => { persistence.saves.push([key, layout]); store.set(key, layout) })
  }
  return { store, persistence }
}
