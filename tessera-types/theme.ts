/** What a window looks like: light or dark. */
export type ThemeMode = 'light' | 'dark'

/** `system` follows the operating system between a theme's light and dark variants. */
export type ThemeModePreference = ThemeMode | 'system'

/** CSS colours: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()` or `hsl()`/`hsla()`. */
export type ThemeColor = string

/** The tokens one variant of a theme sets. Anything omitted falls back to the shell's own theme. */
export interface ThemeTokens {
  primary?: ThemeColor
  secondary?: ThemeColor
  error?: ThemeColor
  warning?: ThemeColor
  info?: ThemeColor
  success?: ThemeColor
  background?: { default?: ThemeColor, paper?: ThemeColor }
  text?: { primary?: ThemeColor, secondary?: ThemeColor }
  divider?: ThemeColor
}

/**
 * A theme (colour scheme): declarative data, so the main process can validate
 * and persist it and a plugin can contribute one without running code in the
 * renderer. A theme with both variants can follow the system; one with a single
 * variant cannot.
 */
export interface ThemeDescriptor {
  /** Unique, prefixed by the contributing plugin's id (`tessera.default` for the shell's own). */
  id: string
  label: string
  /** A short line about the theme, shown with it where themes are chosen, and found by searching there. */
  description?: string
  light?: ThemeTokens
  dark?: ThemeTokens
}

/** A choice of theme and mode: the application-wide setting, or one window's override. */
export interface ThemeSelection {
  theme: string
  mode: ThemeModePreference
}

/** One window's theme. */
export interface ThemeState {
  /** The window this state belongs to; -1 when there is none. */
  windowId: number
  /** The application-wide setting. */
  global: ThemeSelection
  /** This window's override, if it has one. */
  override?: ThemeSelection
  /** What is applied now: the override if present, else the global setting, after fallbacks. */
  theme: string
  mode: ThemeMode
}

/** What the renderer receives: the window's state and every registered theme. */
export interface ThemeSnapshot {
  state: ThemeState
  themes: ThemeDescriptor[]
  /**
   * Whether the operating system wants dark colours, so a preview of "follow the system" can show what it would
   * show. Not the window's mode, which an application-wide or window choice may override.
   */
  systemPrefersDark?: boolean
}

/** Where theme choices are kept: the global one, and each window's override by stable window key. */
export interface ThemePersistence {
  loadGlobal(): Promise<unknown>
  saveGlobal(selection: ThemeSelection): Promise<void>
  loadOverride(key: string): Promise<unknown>
  /** `undefined` removes the override. */
  saveOverride(key: string, selection: ThemeSelection | undefined): Promise<void>
}
