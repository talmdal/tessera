// shell/main/theme/appStatePersistence.ts
import type { AppState, Logger, SettingsHandle, ThemePersistence, ThemeSelection } from '@tessera/types'
import { parseStoredSelection } from '../../../shared/theme/selection'
import { THEME_STATE_KEY, themeOverrideKey } from '../../../shared/theme/types'

const same = (a: ThemeSelection, b: ThemeSelection) => a.theme === b.theme && a.mode === b.mode

/**
 * Where theme choices are kept. The application-wide choice is a setting (`shell.theme`, edited on the Options
 * dialog's Appearance page), so the settings are its one home: this reads it, and leaves writing it to whoever
 * changes it. A window's own theme is window state, kept in the `app-state` plugin's store under its window key.
 *
 * The application-wide choice used to be kept in `app.state` too (under `theme`, where the old theme hook put it).
 * The first load moves such a choice into the settings, unless the settings already hold one, and removes it.
 *
 * `appState` is looked up on every use, since the service only exists after that plugin has activated; while it is
 * absent, window overrides are not remembered and nothing fails.
 */
export function createThemePersistence(
  appState: () => AppState | undefined,
  settings: SettingsHandle<ThemeSelection>,
  log?: Pick<Logger, 'info' | 'warn'>
): ThemePersistence {
  return {
    async loadGlobal() {
      const store = appState()
      const legacy = await store?.get<unknown>(THEME_STATE_KEY)
      if (store && legacy !== undefined && legacy !== null) {
        const { selection } = parseStoredSelection(legacy)
        if (selection && same(settings.get(), settings.defaults)) {
          try {
            await settings.update(selection)
            log?.info(`[theme] Moved the saved theme (${selection.theme}, ${selection.mode}) into the settings`)
          } catch (err) {
            log?.warn(`[theme] Could not move the saved theme into the settings: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        await store.remove(THEME_STATE_KEY)
      }
      return settings.get()
    },
    // Nothing to save: the setting is changed by whoever changes the theme (the Options dialog, the theme commands),
    // and the theme manager follows it. Writing back from here would race those changes.
    saveGlobal: async () => {},
    loadOverride: async key => appState()?.get<unknown>(themeOverrideKey(key)),
    saveOverride: async (key, selection) => {
      const store = appState()
      if (selection === undefined) await store?.remove(themeOverrideKey(key))
      else await store?.set(themeOverrideKey(key), selection)
    }
  }
}
