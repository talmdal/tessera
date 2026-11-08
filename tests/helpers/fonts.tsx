// Rendering inside the shell's own MUI theme with the user's fonts, to check that a view draws through the font roles.
import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import type { ReactNode } from 'react'
import type { FontSettings } from '@tessera/types'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../shared/theme/types'
import { createShellTheme } from '../../shell/renderer/theme/createShellTheme'

/** The user's fonts: the defaults with some roles changed. */
export function fontSettings(roles: { [K in keyof FontSettings['roles']]?: Partial<FontSettings['roles'][K]> } = {}): FontSettings {
  return {
    useThemeFonts: true,
    roles: Object.fromEntries(Object.entries(DEFAULT_FONT_SETTINGS.roles).map(([id, values]) =>
      [id, { ...values, ...(roles as Record<string, object>)[id] }])) as FontSettings['roles']
  }
}

/** Amounts in a face of their own and a larger register: what a view's figures and tables must follow. */
export const DISTINCT_FONTS = fontSettings({ numeric: { family: ['Cascadia Mono'] }, table: { size: 15 } })

/** Renders `node` in the shell's theme with `fonts` (default: `DISTINCT_FONTS`). */
export const renderInShell = (node: ReactNode, fonts: FontSettings = DISTINCT_FONTS) =>
  render(<ThemeProvider theme={createShellTheme(DEFAULT_THEME, 'light', { fonts: resolveFonts(fonts) })}>{node}</ThemeProvider>)

/** True when an element is drawn in the Amounts and figures role as `DISTINCT_FONTS` sets it: its face, equal-width digits. */
export function isFigure(el: Element) {
  const style = getComputedStyle(el)
  return style.fontFamily.startsWith('"Cascadia Mono"') && style.fontVariantNumeric === 'tabular-nums'
}
