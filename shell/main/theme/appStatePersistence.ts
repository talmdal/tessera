// shell/main/theme/appStatePersistence.ts
import type { AppState, ThemePersistence } from '@tessera/types'
import { THEME_STATE_KEY, themeOverrideKey } from '../../../shared/theme/types'

/**
 * Keeps theme choices in the `app-state` plugin's store: the application-wide
 * selection under the key the old theme hook used, and each window's override
 * under its window key. `appState` is looked up on every use, since the service
 * only exists after that plugin has activated; while it is absent nothing is
 * remembered and nothing fails.
 */
export function createThemePersistence(appState: () => AppState | undefined): ThemePersistence {
  return {
    loadGlobal: async () => appState()?.get<unknown>(THEME_STATE_KEY),
    saveGlobal: async selection => { await appState()?.set(THEME_STATE_KEY, selection) },
    loadOverride: async key => appState()?.get<unknown>(themeOverrideKey(key)),
    saveOverride: async (key, selection) => {
      const store = appState()
      if (selection === undefined) await store?.remove(themeOverrideKey(key))
      else await store?.set(themeOverrideKey(key), selection)
    }
  }
}
