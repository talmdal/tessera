// shell/main/theme/appStatePersistence.ts
//
// The ThemePersistence port over the `app.state` service the built-in
// app-state plugin provides: the preference lives under its `theme` key.
// The service is provided during plugin activation, so the adapter looks it
// up on each call rather than at creation, and `load` must run after
// activateAll (and before the window is created; see app.ts). The key used
// to hold the string 'light' or 'dark' written by the old useThemeState
// hook; that is read as the matching shell theme once and overwritten with
// the full preference on the next save. See docs/style-manager-design.md.
import type { AppState, Logger, ServiceRegistry, ThemePersistence, ThemePreference } from '@tessera/types'
import { defaultThemeFor } from '../../../shared/theme/types'

export const APP_STATE_SERVICE = 'app.state'
export const THEME_STATE_KEY = 'theme'

export function createAppStatePersistence(services: ServiceRegistry, log: Logger): ThemePersistence {
  let warned = false
  const store = (): AppState | undefined => {
    if (services.has(APP_STATE_SERVICE)) return services.get<AppState>(APP_STATE_SERVICE)
    if (!warned) {
      warned = true
      log.warn(`[theme] No plugin provides "${APP_STATE_SERVICE}"; the theme preference will not be saved`)
    }
    return undefined
  }

  return {
    async load() {
      const stored = await store()?.get<unknown>(THEME_STATE_KEY)
      if (stored === 'light' || stored === 'dark') {
        return { theme: defaultThemeFor(stored) } as ThemePreference   // the legacy value; the service fills the rest
      }
      return typeof stored === 'object' && stored !== null ? stored as ThemePreference : undefined
    },
    async save(preference) {
      await store()?.set(THEME_STATE_KEY, preference)
    }
  }
}
