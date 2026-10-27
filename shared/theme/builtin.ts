// shared/theme/builtin.ts
//
// The shell's catalogue and themes in resolved form, and the colours of a
// built-in theme on its own. The main process starts from these before any
// plugin runs, and the renderer paints its first frame from them before the
// snapshot arrives, so both begin in the same place.
import type { ColorDefinition, ThemeDefinition, ThemeKind, ThemeState } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import { resolveColorMap } from './resolveColorMap'
import { resolveColors } from './resolveColors'
import { resolveThemes } from './resolveThemes'
import { SHELL_THEMES } from './themes'
import { SHELL_COLOR_TOKENS } from './tokens'
import { defaultPreference, defaultThemeFor } from './types'

const contributed = <T>(items: readonly T[]) => items.map(impl => ({ contributor: SHELL_CONTRIBUTOR_ID, impl }))

let catalogue: ColorDefinition[] | undefined
let themes: ThemeDefinition[] | undefined

/** The shell's own tokens, validated. The catalogue is checked by a test, so diagnostics are not expected. */
export function shellColorCatalogue(): readonly ColorDefinition[] {
  return catalogue ??= resolveColors(contributed(SHELL_COLOR_TOKENS)).colors
}

export function shellThemeDefinitions(): readonly ThemeDefinition[] {
  return themes ??= resolveThemes(contributed(SHELL_THEMES)).themes
}

/** The shell's theme of a kind, resolved over the shell's catalogue alone. */
export function builtinThemeState(kind: ThemeKind): ThemeState {
  const all = shellThemeDefinitions()
  const theme = all.find(t => t.id === defaultThemeFor(kind))!
  return {
    preference: defaultPreference(),
    activeTheme: theme.id,
    kind,
    colors: resolveColorMap(shellColorCatalogue(), all, theme).colors,
    themes: all.map(({ id, label, kind, pluginId }) => ({ id, label, kind, pluginId }))
  }
}
