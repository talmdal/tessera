// core/state/PluginState.ts
import type { AppState, PluginState } from '@tessera/types'
import { APP_STATE_SERVICE } from '@tessera/types'

export interface PluginStateOptions {
  /**
   * The services the plugin's manifest requires. When given, `app.state` must be among them: the plugin declares what
   * it needs, so the app-state plugin is activated before it, rather than working only when the order happens to
   * suit. Omitted for contexts that have no manifest (the shell's own, tests).
   */
  requires?: readonly string[]
}

/**
 * A plugin's `context.state`: its own keys in the `app.state` store, each stored as `<pluginId>.<key>`, so a plugin
 * can't read or overwrite another's. The store is looked up on every call, since the app-state plugin provides it only
 * once it has activated; a call without it rejects, saying what to declare.
 *
 * Keys keep the form plugins used with `app.state` directly (`ledger.recent`), so nothing saved before is lost.
 */
export function createPluginState(pluginId: string, appState: () => AppState | undefined, options: PluginStateOptions = {}): PluginState {
  const store = (): AppState => {
    if (options.requires !== undefined && !options.requires.includes(APP_STATE_SERVICE)) {
      throw new Error(`Plugin "${pluginId}" used context.state without requiring "${APP_STATE_SERVICE}": add it to services.requires in its manifest`)
    }
    const found = appState()
    if (!found) throw new Error(`Plugin "${pluginId}" used context.state, but "${APP_STATE_SERVICE}" is not available: is the app-state plugin installed and active?`)
    return found
  }

  const keyOf = (key: unknown) => {
    if (typeof key !== 'string' || key.trim() === '') throw new Error(`Plugin "${pluginId}" used an invalid state key "${String(key)}": use a non-empty string`)
    return `${pluginId}.${key}`
  }

  // Async, so every problem is a rejection, as a failed read or write of the store would be.
  return {
    get: async (key, defaultFn) => store().get(keyOf(key), defaultFn),
    set: async (key, value) => store().set(keyOf(key), value),
    update: async (key, patch) => store().update(keyOf(key), patch),
    remove: async key => store().remove(keyOf(key))
  }
}
