// shared/theme/types.ts — ids, channel names and the shell's own theme.
import { channelFor } from '@tessera/types'
import type { ThemeDescriptor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Extension point plugins contribute themes to. */
export const THEMES_EXTENSION_POINT = 'shell.themes'

/** The shell's own theme, which every fallback lands on. */
export const DEFAULT_THEME_ID = 'tessera.default'

/**
 * The `app.state` key the application-wide selection was kept under (it once held `'light'` or `'dark'`). It is a
 * setting now (`shell.theme`, see ./settings.ts); a value found here is moved there once, and removed.
 */
export const THEME_STATE_KEY = 'theme'
/** The `app.state` key of a window's override, by stable window key (`main` for the primary window). */
export const themeOverrideKey = (windowKey: string) => `shell.theme.${windowKey}`

// Request (renderer → main); answers for the sending window
export const THEME_GET = shell('theme.get')               // → ThemeSnapshot
// Push event (main → renderer); carries the window id, so other windows ignore it
export const THEME_CHANGED = shell('theme.changed')       // ThemeSnapshot

/** Commands the shell registers for the theme. Each acts on the focused window. */
export const THEME_COMMANDS = {
  useSystem: 'shell.theme.useSystem',
  useLight: 'shell.theme.useLight',
  useDark: 'shell.theme.useDark',
  /** Opens the Options dialog at its Appearance page, where the theme is chosen. */
  choose: 'shell.theme.choose',
  /** Argument: a `ThemeSelection`; sets the application-wide theme and mode exactly. */
  set: 'shell.theme.set',
  /** Flips to the opposite explicit mode. */
  toggle: 'shell.theme.toggle',
  /** Argument: a theme id. Keeps the mode when the theme has it, else uses the theme's own. */
  select: 'shell.theme.select',
  /** Argument: a `ThemeSelection`. */
  setForWindow: 'shell.theme.setForWindow',
  clearWindowOverride: 'shell.theme.clearWindowOverride'
} as const

/** Context keys describing the focused window's theme. */
export const themeKey = {
  mode: 'shell.theme.mode',
  id: 'shell.theme.id',
  /** True while the focused window has its own theme override. */
  overridden: 'shell.theme.overridden'
} as const

/** The shell's theme. The hex backgrounds matter: they also colour a window before its page has painted. */
export const DEFAULT_THEME: ThemeDescriptor = {
  id: DEFAULT_THEME_ID,
  label: 'Tessera',
  light: {
    primary: '#1976d2',
    secondary: '#9c27b0',
    error: '#d32f2f',
    warning: '#ed6c02',
    info: '#0288d1',
    success: '#2e7d32',
    background: { default: '#fafafa', paper: '#ffffff' },
    text: { primary: 'rgba(0, 0, 0, 0.87)', secondary: 'rgba(0, 0, 0, 0.6)' },
    divider: 'rgba(0, 0, 0, 0.12)'
  },
  dark: {
    primary: '#90caf9',
    secondary: '#ce93d8',
    error: '#f44336',
    warning: '#ffa726',
    info: '#29b6f6',
    success: '#66bb6a',
    background: { default: '#121212', paper: '#1e1e1e' },
    text: { primary: 'rgba(255, 255, 255, 0.87)', secondary: 'rgba(255, 255, 255, 0.6)' },
    divider: 'rgba(255, 255, 255, 0.12)'
  }
}

/**
 * Synchronous request (preload → main) for the sending window's `ThemeSnapshot`,
 * so the page's first render already knows its theme. Answers `null` when the
 * window is not known. Not routed through the IPC router, which is asynchronous.
 */
export const THEME_INITIAL = shell('theme.initial')
