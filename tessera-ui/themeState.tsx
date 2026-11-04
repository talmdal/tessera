import { createContext, useContext, useMemo } from 'react'
import type { ThemeMode, ThemeState } from '@tessera/types'

/** The window's full theme state. Provided by the shell. */
export const ThemeStateContext = createContext<ThemeState | null>(null)

/**
 * Which theme the window shows, and whether it is light or dark, as data: for
 * what the MUI theme can't style, such as a canvas or a third-party chart.
 * Components should use the theme (`useTheme`, `sx`) instead. Read only; the
 * theme is changed by the user, not by plugins.
 */
export function useThemeState(): { theme: string, mode: ThemeMode } {
  const state = useContext(ThemeStateContext)
  if (!state) throw new Error('useThemeState must be used inside the shell')
  return useMemo(() => ({ theme: state.theme, mode: state.mode }), [state.theme, state.mode])
}
