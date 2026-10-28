// shell/main/layout/appStatePersistence.ts
import type { AppState, LayoutPersistence, PersistedLayout } from '@tessera/types'

/** The `app.state` key a window's layout is kept under. */
export const layoutStateKey = (windowKey: string) => `shell.layout.${windowKey}`

/**
 * Keeps window layouts in the `app-state` plugin's store, one entry per window
 * key. `appState` is looked up on every use rather than once: the service only
 * exists after that plugin has activated. While it is absent nothing is
 * remembered and nothing fails.
 */
export function createAppStatePersistence(appState: () => AppState | undefined): LayoutPersistence {
  return {
    load: async key => appState()?.get<PersistedLayout>(layoutStateKey(key)),
    save: async (key, layout) => { await appState()?.set(layoutStateKey(key), layout) }
  }
}
