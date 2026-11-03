// shared/themes/types.ts — extension point, channel names, commands, context keys and defaults for themes.
import { channelFor } from '@tessera/types'
import type { ColorScheme, ThemeContribution, ThemeMode } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Extension point that theme contributions are registered under. */
export const THEMES_EXTENSION_POINT = 'shell.themes'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
export const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark']

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

/**
 * The shell's own theme: an empty contribution over the shell's base, so it
 * is listed and chosen like any other, and is what the shell falls back to.
 */
export const SHELL_THEME_ID = 'shell.default'
export const SHELL_THEME: ThemeContribution = {
  id: SHELL_THEME_ID,
  label: 'Tessera',
  description: 'The built-in theme, in light and dark.',
  light: {},
  dark: {},
  order: -1
}

/** What is chosen before the user has chosen anything. */
export const DEFAULT_THEME_ID = SHELL_THEME_ID
export const DEFAULT_THEME_MODE: ThemeMode = 'system'

/** MUI's default page background per scheme: what a window is painted with before the renderer has drawn. */
export const DEFAULT_BACKGROUND: Record<ColorScheme, string> = { light: '#fff', dark: '#121212' }

/** A contribution is rejected above this many bytes of JSON; a theme is a palette, not a stylesheet. */
export const MAX_THEME_BYTES = 256 * 1024

/** Key of the choice in persisted state, and the key the old light/dark string was kept under. */
export const THEME_STATE_KEY = 'shell.theme'
export const LEGACY_THEME_STATE_KEY = 'theme'

// Requests (renderer → main)
export const THEMES_LIST = shell('themes.list')        // → ThemeDescriptor[]
export const THEME_GET = shell('theme.get')            // → ThemeSelection
export const THEME_SET = shell('theme.set')            // ThemeSet → ThemeSelection

// Push events (main → renderer)
export const THEMES_CHANGED = shell('themes.changed')  // no payload; re-request the list
export const THEME_CHANGED = shell('theme.changed')    // ThemeSelection
export const THEME_PICKER_OPEN = shell('theme.picker.open')   // ThemePickerOpen

/** Payload of `shell:theme.picker.open`: the window that should open the chooser. */
export interface ThemePickerOpen {
  windowId: number
}

/** Commands the shell registers for themes. */
export const THEME_COMMANDS = {
  /** Opens the chooser in the focused window. */
  choose: 'shell.theme.choose',
  /** Arguments: a ThemeSet, or (themeId, mode). */
  set: 'shell.theme.set',
  /** Light ↔ dark; from `system`, the opposite of what the system currently is. */
  toggleMode: 'shell.theme.toggleMode',
  /** One per mode, for menu items. */
  mode: (mode: ThemeMode) => `shell.theme.mode.${mode}`,
  /** One per theme, registered as themes come and go, for menu items. */
  use: (themeId: string) => `shell.theme.use.${themeId}`
} as const

/** Context keys the shell sets for the theme, so `when` expressions and plugins can depend on it. */
export const themeKey = {
  id: 'shell.theme.id',
  mode: 'shell.theme.mode',
  resolvedMode: 'shell.theme.resolvedMode'
} as const
