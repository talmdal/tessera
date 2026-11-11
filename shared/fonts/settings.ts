// shared/fonts/settings.ts — the user's fonts as a setting: the `shell.fonts` namespace. The settings keep the choice;
// the shell sends it to every window with the window's theme (ThemeSnapshot.fonts), and each window resolves it.
// See docs/font-roles-design.md#the-shellfonts-setting.
import type { FontSettings, SettingsDefinition } from '@tessera/types'
import { DEFAULT_FONT_SETTINGS } from './resolveFonts'
import { FONT_ROLE_IDS, fontSpecProblems } from './roles'

/** The settings namespace the user's fonts are kept in, as `<userData>/settings/shell.fonts.json`. */
export const FONT_SETTINGS_ID = 'shell.fonts'

/** The Options dialog's Fonts page, under Appearance. `shell.settings.open` with it opens the dialog there. */
export const FONT_SETTINGS_PAGE = 'shell.appearance.fonts'

/** The module the renderer's Fonts page is built in under (the shell's own pages have no remote). */
export const FONT_SETTINGS_MODULE = './Fonts'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What is wrong with the user's fonts, as messages for people. Every default is `null` (Automatic), and a `null`
 * default switches off the settings' own shape check for its key, so this checks everything: each role's facets
 * against the user's size range, families against the name rule, weights against those offered.
 *
 * It does not check that a font is installed: the settings are read before any list of fonts exists, a settings folder
 * may come from another computer, and a missing font falls back cleanly. Roles this version doesn't know are left
 * alone (a newer version may have written them), as the settings framework keeps keys a newer version saved.
 */
export function fontSettingsProblems(value: FontSettings): string[] {
  const problems: string[] = []
  if (typeof value.useThemeFonts !== 'boolean') problems.push('Say whether to use the fonts themes choose: true or false.')
  if (!isObject(value.roles)) return [...problems, 'The fonts must be given role by role.']
  for (const id of FONT_ROLE_IDS) {
    if (value.roles[id] !== undefined) problems.push(...fontSpecProblems(id, value.roles[id], 'user'))
  }
  return problems
}

export const FONT_SETTINGS: SettingsDefinition<FontSettings> = {
  id: FONT_SETTINGS_ID,
  // A copy: the settings service freezes what it is given, and DEFAULT_FONT_SETTINGS is shared
  defaults: structuredClone(DEFAULT_FONT_SETTINGS),
  validate: fontSettingsProblems
}
