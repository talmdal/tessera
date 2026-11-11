import { vi } from 'vitest'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import type { SettingsPersistence, StoredSettings } from '../../core/ports'
import { SettingsService } from '../../core/settings/SettingsService'
import { createLogger } from './runtime'

/**
 * Settings persistence in memory: `documents` is what is "on disk", by namespace. `hold()` makes writes wait until
 * `release()`, and `failWith` makes them fail, to see what happens while a write is slow or broken.
 */
export function memorySettingsPersistence(initial: Record<string, unknown> = {}) {
  const documents = new Map<string, unknown>(Object.entries(initial))
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  const state: { failWith?: Error } = {}

  const persistence = {
    loadAll: vi.fn(async () => Object.fromEntries(documents)),
    save: vi.fn(async (id: string, document: StoredSettings | undefined) => {
      if (gate) await gate
      if (state.failWith) throw state.failWith
      if (document === undefined) documents.delete(id)
      else documents.set(id, structuredClone(document))
    })
  } satisfies SettingsPersistence

  return {
    persistence,
    documents,
    state,
    hold() { gate = new Promise(resolve => { open = resolve }) },
    release() { gate = undefined; open?.() }
  }
}

/** A settings service over a real extension registry and memory persistence, already loaded. */
export async function setupSettings(initial: Record<string, unknown> = {}) {
  const log = createLogger()
  const store = memorySettingsPersistence(initial)
  const extensions = new ExtensionRegistryImpl()
  const settings = new SettingsService({ extensions, persistence: store.persistence, log })
  await settings.load()
  return { settings, extensions, log, ...store }
}
