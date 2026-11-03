// -----------------------------
// Themes (`shell.themes`)
// -----------------------------

/** What the user chooses: a theme, shown light, dark, or as the system says. */
export type ThemeMode = 'light' | 'dark' | 'system'

/** One of the two looks a theme can define; what `system` resolves to. */
export type ColorScheme = 'light' | 'dark'

/**
 * The structured-cloneable subset of Material UI's `ThemeOptions`: palette,
 * typography, shape, spacing (a number), shadows, component `defaultProps`
 * and `styleOverrides` as plain objects, and `tessera` tokens. No functions:
 * a theme is data, validated in the main process and built in the renderer.
 */
export type ThemeOptionsJson = Record<string, unknown>

/**
 * A theme, contributed from a plugin's privileged `activate` under
 * `shell.themes`. The shell layers it on its base theme, so a contribution
 * only says what differs, usually a palette.
 */
export interface ThemeContribution {
  /** Plugin-prefixed, like every contribution: 'halloween.main'. */
  id: string
  /** Shown in menus and the chooser. */
  label: string
  description?: string
  /** Options both schemes share: typography, shape, component defaults. */
  common?: ThemeOptionsJson
  /** At least one of these. A theme with only one is still offered in the other mode, using the one it has. */
  light?: ThemeOptionsJson
  dark?: ThemeOptionsJson
  /** Colours the chooser shows as the theme's swatch, per scheme. Derived from the palette when absent. */
  swatch?: { light?: string[], dark?: string[] }
  /** Lower sorts first. Ties keep registration order. Defaults to 0. */
  order?: number
}

/** A valid theme, as the renderer receives it: the contribution, who made it, and which schemes it has. */
export interface ThemeDescriptor extends ThemeContribution {
  pluginId: string
  schemes: ColorScheme[]
}

/** The current choice and what it amounts to, as `shell:theme.get` returns and `shell:theme.changed` carries. */
export interface ThemeSelection {
  /** The theme the user chose. Kept even while that theme is absent. */
  themeId: string
  mode: ThemeMode
  /** `mode`, with `system` resolved by the main process. */
  resolvedMode: ColorScheme
  /** The theme in use: `themeId` when it exists, otherwise the shell's built-in theme. */
  effectiveThemeId: string
}

/** Payload of `shell:theme.set` and arguments of `shell.theme.set`; each part is optional. */
export interface ThemeSet {
  themeId?: string
  mode?: ThemeMode
}

/** What is kept of the choice. Read back defensively, so every field is optional. */
export interface PersistedTheme {
  themeId?: string
  mode?: ThemeMode
}

/** Where the choice is kept. */
export interface ThemePersistence {
  load(): Promise<PersistedTheme | undefined>
  save(theme: PersistedTheme): Promise<void>
}
