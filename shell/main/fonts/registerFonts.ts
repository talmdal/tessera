// shell/main/fonts/registerFonts.ts — the Fonts page of the Options dialog: its contribution, the command that opens
// it, and the list of installed fonts it offers. The fonts themselves are the `shell.fonts` setting, which the theme
// manager sends to every window (shell/main/theme/registerTheme.ts).
import type { PluginContext, SettingsPageContribution } from '@tessera/types'
import { SETTINGS_OPEN_COMMAND, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import { FONT_SETTINGS_ID, FONT_SETTINGS_MODULE, FONT_SETTINGS_PAGE } from '../../../shared/fonts/settings'
import { FONTS_FAMILIES, FONT_COMMANDS } from '../../../shared/fonts/types'
import { THEME_SETTINGS_PAGE } from '../../../shared/theme/settings'
import type { FontCatalogue } from './fontCatalogue'

/** The Options dialog's Fonts page, under Appearance, drawn by the shell's renderer. */
export const FONTS_PAGE: SettingsPageContribution = {
  id: FONT_SETTINGS_PAGE,
  title: 'Fonts',
  parent: THEME_SETTINGS_PAGE,
  description: 'The fonts and text sizes Tessera uses for each kind of text.',
  keywords: [
    'font', 'fonts', 'typeface', 'text size', 'larger text', 'smaller text', 'bigger', 'readability',
    'monospace', 'fixed-width', 'numbers', 'amounts', 'figures', 'register', 'headings'
  ],
  settings: FONT_SETTINGS_ID,
  module: FONT_SETTINGS_MODULE
}

/**
 * Registers the Fonts page, `shell.fonts.choose`, and `shell:fonts.families`, which answers with the installed fonts
 * (listed once, on the first request: see fontCatalogue.ts). `shell` is the shell's own plugin context.
 */
export function registerFonts(shell: PluginContext, catalogue: FontCatalogue) {
  shell.ipc.register(FONTS_FAMILIES, () => catalogue.families())
  shell.commands.register(FONT_COMMANDS.choose, () => shell.commands.execute(SETTINGS_OPEN_COMMAND, FONT_SETTINGS_PAGE))
  shell.extensions.contribute(shell.pluginId, SETTINGS_PAGES_EXTENSION_POINT, FONTS_PAGE.id, FONTS_PAGE)
}
