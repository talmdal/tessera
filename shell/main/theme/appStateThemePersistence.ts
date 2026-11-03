// shell/main/theme/appStateThemePersistence.ts
import type { AppState, PersistedTheme, ThemePersistence } from '@tessera/types'
import { DEFAULT_THEME_ID, LEGACY_THEME_STATE_KEY, THEME_STATE_KEY } from '../../../shared/themes/types'

/**
 * Keeps the theme choice in the `app-state` plugin's store. `appState` is
 * looked up on every use rather than once: the service only exists after that
 * plugin has activated. While it is absent nothing is remembered and nothing
 * fails.
 *
 * Before themes existed the store held a bare `'light'` or `'dark'` under
 * `theme`; the first load turns that into a choice of the shell's theme in
 * that mode and removes the old key.
 */
export function createAppStateThemePersistence(appState: () => AppState | undefined): ThemePersistence {
  return {
    load: async () => {
      const state = appState()
      if (!state) return undefined

      const saved = await state.get<PersistedTheme>(THEME_STATE_KEY)
      if (saved !== undefined) return saved

      const legacy = await state.get<unknown>(LEGACY_THEME_STATE_KEY)
      if (legacy !== 'light' && legacy !== 'dark') return undefined
      const migrated: PersistedTheme = { themeId: DEFAULT_THEME_ID, mode: legacy }
      await state.set(THEME_STATE_KEY, migrated)
      await state.remove(LEGACY_THEME_STATE_KEY)
      return migrated
    },
    save: async theme => { await appState()?.set(THEME_STATE_KEY, theme) }
  }
}
