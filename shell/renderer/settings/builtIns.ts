// shell/renderer/settings/builtIns.ts — components of the shell's own settings pages, by module. The shell has no
// remote, so its pages (contributed by shell/main with `pluginId: 'shell'`) are looked up here.
import { THEME_SETTINGS_MODULE } from '../../../shared/theme/settings'
import { AppearancePage } from './pages/AppearancePage'
import type { SettingsPageComponent } from './SettingsDialog'

export const BUILT_IN_SETTINGS_PAGES: Readonly<Record<string, SettingsPageComponent>> = {
  [THEME_SETTINGS_MODULE]: AppearancePage
}
