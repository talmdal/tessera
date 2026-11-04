// shared/theme/tokens.ts — the tokens a theme shows in a mode, and the colour a window is painted before its page is.
import type { ThemeDescriptor, ThemeMode, ThemeState, ThemeTokens } from '@tessera/types'
import { DEFAULT_THEME, DEFAULT_THEME_ID } from './types'

/** Every token, with a value. */
export interface ResolvedThemeTokens {
  primary: string
  secondary: string
  error: string
  warning: string
  info: string
  success: string
  background: { default: string, paper: string }
  text: { primary: string, secondary: string }
  divider: string
}

/**
 * The tokens `theme` shows in `mode`: its own, with anything it leaves out
 * taken from the shell's theme in that mode, so a plugin theme can set just a
 * primary colour. A mode the theme has no variant for shows the shell's.
 */
export function tokensFor(theme: ThemeDescriptor, mode: ThemeMode): ResolvedThemeTokens {
  const base = DEFAULT_THEME[mode] as ResolvedThemeTokens
  const own: ThemeTokens = theme[mode] ?? {}
  return {
    primary: own.primary ?? base.primary,
    secondary: own.secondary ?? base.secondary,
    error: own.error ?? base.error,
    warning: own.warning ?? base.warning,
    info: own.info ?? base.info,
    success: own.success ?? base.success,
    background: { default: own.background?.default ?? base.background.default, paper: own.background?.paper ?? base.background.paper },
    text: { primary: own.text?.primary ?? base.text.primary, secondary: own.text?.secondary ?? base.text.secondary },
    divider: own.divider ?? base.divider
  }
}

/** The registered theme a state shows, or the shell's own if it is not (yet) in `themes`. */
export function themeOf(state: Pick<ThemeState, 'theme'>, themes: readonly ThemeDescriptor[]): ThemeDescriptor {
  return themes.find(t => t.id === state.theme) ?? themes.find(t => t.id === DEFAULT_THEME_ID) ?? DEFAULT_THEME
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * The colour to paint a window with while its page loads: the theme's default
 * background, if it is plain hex (all a window accepts), else the shell's theme's.
 */
export function windowBackground(state: Pick<ThemeState, 'theme' | 'mode'>, themes: readonly ThemeDescriptor[]): string {
  const wanted = tokensFor(themeOf(state, themes), state.mode).background.default
  return HEX.test(wanted) ? wanted : (DEFAULT_THEME[state.mode]!.background!.default as string)
}
