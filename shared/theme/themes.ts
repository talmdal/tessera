// shared/theme/themes.ts
//
// The shell's built-in themes. Their `colors` are empty on purpose: they
// *are* the catalogue's light and dark defaults. A plugin theme usually
// extends one of them and changes a handful of entries.
import type { ThemeContribution } from '@tessera/types'
import { DARK_THEME_ID, LIGHT_THEME_ID } from './types'

export const SHELL_THEMES: readonly ThemeContribution[] = [
  { id: LIGHT_THEME_ID, label: 'Tessera Light', kind: 'light', colors: {}, order: -2 },
  { id: DARK_THEME_ID, label: 'Tessera Dark', kind: 'dark', colors: {}, order: -1 }
]
