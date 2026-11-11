// shared/theme/settings.ts — the application's theme as a setting: the `shell.theme` namespace, and its page in the
// Options dialog. The settings keep the choice; the theme manager follows them.
import type { SettingsDefinition, ThemeSelection } from '@tessera/types'
import { DEFAULT_SELECTION, THEME_MODES } from './selection'

/** The settings namespace the application-wide theme is kept in: `{ theme, mode }`. */
export const THEME_SETTINGS_ID = 'shell.theme'

/** The Options dialog's Appearance page. `shell.settings.open` with it opens the dialog there. */
export const THEME_SETTINGS_PAGE = 'shell.appearance'

/** The module the renderer's Appearance page is built in under (the shell's own pages have no remote). */
export const THEME_SETTINGS_MODULE = './Appearance'

/**
 * Only the form is checked: a theme id, and one of the modes. Whether the theme exists is not, because a plugin's
 * theme is only there once that plugin has activated, which is after the settings are read; a theme that is missing
 * shows the shell's own until it returns, and the choice is kept.
 */
export function themeSettingsProblems(value: ThemeSelection): string[] {
  const problems: string[] = []
  if (typeof value.theme !== 'string' || value.theme.trim() === '') problems.push('Choose a theme.')
  if (!THEME_MODES.includes(value.mode)) problems.push('Choose System, Light or Dark.')
  return problems
}

export const THEME_SETTINGS: SettingsDefinition<ThemeSelection> = {
  id: THEME_SETTINGS_ID,
  defaults: { ...DEFAULT_SELECTION },
  validate: themeSettingsProblems
}
