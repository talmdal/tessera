// The style manager's plugin-facing contracts: colour tokens, themes, the
// preference and the resolved state the main process owns and the renderer
// mirrors, the payloads of the `shell:theme.*` channels, and the ports the
// core depends on. Extension point names, channel names, id patterns and
// the shell's own catalogue are values and live in shared/theme/. See
// docs/style-manager-design.md.

// -----------------------------
// Tokens and themes
// -----------------------------

export type ThemeKind = 'light' | 'dark'

/**
 * A colour: "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa", or the id of another
 * token whose value is used instead. References are resolved by the main
 * process; the renderer only ever sees hex values.
 */
export type ColorValue = string

/**
 * A colour token, contributed under `shell.colors`. A token names a colour a
 * plugin's views use, with a default for each kind so it looks right in any
 * theme. Themes may override it.
 */
export interface ColorContribution {
  /** Plugin-prefixed, dotted: "accounts.positiveAmount". */
  id: string
  /** Shown by a future picker or editor; required. */
  description: string
  /** One value for both kinds, or one per kind. */
  defaults: ColorValue | { light: ColorValue, dark: ColorValue }
}

/** A token as the resolver sees it: validated, with both defaults spelled out. */
export interface ColorDefinition {
  id: string
  description: string
  defaults: { light: ColorValue, dark: ColorValue }
  pluginId: string
}

/** A theme, contributed under `shell.themes`: a colour palette over the token catalogue. */
export interface ThemeContribution {
  /** Plugin-prefixed, dotted: "money-classic.sepia". */
  id: string
  /** Shown in the View › Theme menu and pickers. */
  label: string
  kind: ThemeKind
  /** A theme of the same kind whose colours fill in what this one omits. Default: the shell's theme of `kind`. */
  extends?: string
  /** Token id → colour (hex or a token reference). Any token, from any plugin. */
  colors?: Record<string, ColorValue>
  /** Sort order in menus; lower first. Ties keep registration order. Defaults to 0. */
  order?: number
}

/** A theme as the resolver sees it: validated, with `extends` settled. */
export interface ThemeDefinition {
  id: string
  label: string
  kind: ThemeKind
  /** Absent only for a root theme (the shell's own). */
  extends?: string
  colors: Record<string, ColorValue>
  pluginId: string
}

/** A theme as the renderer and pickers see it. */
export interface ThemeDescriptor {
  id: string
  label: string
  kind: ThemeKind
  pluginId: string
}

// -----------------------------
// Preference and state
// -----------------------------

/** The user's per-token overrides, layered above the theme chain. */
export interface ThemeCustomizations {
  /** Token → colour, applied over every theme. */
  global?: Record<string, ColorValue>
  /** Theme id → token → colour, applied over `global` for that theme only. */
  byTheme?: Record<string, Record<string, ColorValue>>
}

export interface ThemePreference {
  /** A theme id, or 'system' to follow the operating system. */
  theme: string
  /** Used when `theme` is 'system' and the system is light. */
  light: string
  /** Used when `theme` is 'system' and the system is dark. */
  dark: string
  customizations?: ThemeCustomizations
}

/** What the renderer mirrors. Pushed whole as `shell:theme.changed`. */
export interface ThemeState {
  preference: ThemePreference
  /** The theme in use: the preference, or the fallback when it is absent. */
  activeTheme: string
  kind: ThemeKind
  /** Every catalogue token with a resolved hex value; tokens that failed to resolve are absent. */
  colors: Record<string, string>
  /** The present themes, for pickers. */
  themes: ThemeDescriptor[]
}

/** `shell:theme.set`: any subset of the preference. */
export type ThemeSetRequest = Partial<ThemePreference>

// -----------------------------
// Ports
// -----------------------------

import { Event } from '.'

/** Stores the preference. The adapter decides where (the `app.state` service). */
export interface ThemePersistence {
  load(): Promise<ThemePreference | undefined>
  save(preference: ThemePreference): Promise<void>
}

/** The operating system's light/dark setting, adapted over Electron's nativeTheme. */
export interface SystemAppearance {
  kind(): ThemeKind
  onDidChange: Event<ThemeKind>
}
