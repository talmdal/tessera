// shared/theme/types.ts
//
// Values of the style manager: extension point names, IPC channel names, id
// and colour patterns, the CSS variable mapping, and the default preference.
// The interfaces (ColorContribution, ThemeContribution, ThemeState, ports)
// are in @tessera/types (tessera-types/theme.ts). See
// docs/style-manager-design.md.
import type { ThemeKind, ThemePreference } from '@tessera/types'
import { channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

// -----------------------------
// Extension points
// -----------------------------

/** Colour tokens a plugin's views use, with a default per kind. */
export const COLORS_EXTENSION_POINT = 'shell.colors'
/** Colour palettes over the token catalogue. */
export const THEMES_EXTENSION_POINT = 'shell.themes'

// -----------------------------
// Kinds, ids and colours
// -----------------------------

export const THEME_KINDS: readonly ThemeKind[] = ['light', 'dark']

export function isThemeKind(value: unknown): value is ThemeKind {
  return typeof value === 'string' && (THEME_KINDS as readonly string[]).includes(value)
}

/**
 * Token and theme ids: a plugin id, then one or more dotted camelCase
 * segments. "shell.bar.hoverBackground", "money-classic.sepia".
 */
export const TOKEN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/

export function isTokenId(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_ID_PATTERN.test(value)
}

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa". */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

/** A valid ColorValue: a hex colour, or a reference to another token. */
export function isColorValue(value: unknown): value is string {
  return isHexColor(value) || isTokenId(value)
}

/** True when the contributor may own `id`: the id is the plugin id, or starts with "<pluginId>.". */
export function isOwnedThemeId(contributor: string, id: string) {
  return id === contributor || id.startsWith(`${contributor}.`)
}

/**
 * The CSS custom property a token is published as: dots become dashes,
 * camelCase is kept. "shell.bar.hoverBackground" → "--shell-bar-hoverBackground".
 */
export function cssVariableFor(token: string) {
  return `--${token.replace(/\./g, '-')}`
}

// -----------------------------
// Defaults
// -----------------------------

/** The value of `ThemePreference.theme` that follows the operating system. */
export const SYSTEM_THEME = 'system'

export const LIGHT_THEME_ID = 'shell.light'
export const DARK_THEME_ID = 'shell.dark'

/** The shell's own theme of a kind, the last resort when a chosen theme is absent. */
export function defaultThemeFor(kind: ThemeKind) {
  return kind === 'dark' ? DARK_THEME_ID : LIGHT_THEME_ID
}

export function defaultPreference(): ThemePreference {
  return { theme: SYSTEM_THEME, light: LIGHT_THEME_ID, dark: DARK_THEME_ID }
}

// -----------------------------
// IPC channels (payload types: ThemeState, ThemeSetRequest in @tessera/types)
// -----------------------------

export const THEME_GET = shell('theme.get')                         // → ThemeState
export const THEME_SET = shell('theme.set')                         // ThemeSetRequest → ThemeState
export const THEME_CHANGED = shell('theme.changed')                 // push → ThemeState
export const THEME_CHOOSE_REQUESTED = shell('theme.chooseRequested') // push → ThemeChooseRequestedEvent

/** `shell:theme.chooseRequested`: the shell.theme.choose command asks a window to open the theme chooser. */
export interface ThemeChooseRequestedEvent {
  /** The window to open in; every window when undefined (no window was focused). */
  windowId?: number
}
