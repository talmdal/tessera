// shell/renderer/theme/createShellTheme.ts
import { createTheme } from '@mui/material'
import type { Theme } from '@mui/material'
import type { ThemeDescriptor, ThemeMode } from '@tessera/types'
import { tokensFor } from '../../../shared/theme/tokens'

/** The operating system's own UI font. */
export const FONT_STACK = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export interface ShellThemeOptions {
  /**
   * The user asked the system for less motion: no transitions, and no ripple on buttons. Transitions come from
   * the theme, so everything built on it (tabs, buttons, the splitter) follows.
   */
  reducedMotion?: boolean
}

/**
 * The MUI theme for a theme descriptor in a mode: the descriptor's tokens over
 * the shell's, with the shell's typography and compact density, which plugin
 * themes can't change. One place to edit for a change of design.
 */
export function createShellTheme(descriptor: ThemeDescriptor, mode: ThemeMode, { reducedMotion = false }: ShellThemeOptions = {}): Theme {
  const tokens = tokensFor(descriptor, mode)

  return createTheme({
    palette: {
      mode,
      primary: { main: tokens.primary },
      secondary: { main: tokens.secondary },
      error: { main: tokens.error },
      warning: { main: tokens.warning },
      info: { main: tokens.info },
      success: { main: tokens.success },
      background: tokens.background,
      text: tokens.text,
      divider: tokens.divider
    },
    // Buttons keep the case they were written in: "Reset sample", not "RESET SAMPLE".
    typography: { fontFamily: FONT_STACK, fontSize: 13, button: { textTransform: 'none' } },
    shape: { borderRadius: 4 },
    ...(reducedMotion && { transitions: { create: () => 'none' } }),
    // Compact: a desktop data-entry application, not a marketing site. See "Re-evaluate density" in docs/todo.md.
    components: {
      ...(reducedMotion && { MuiButtonBase: { defaultProps: { disableRipple: true } } }),
      MuiButton: { defaultProps: { size: 'small' } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      MuiTextField: { defaultProps: { size: 'small', margin: 'dense' } },
      MuiFormControl: { defaultProps: { size: 'small', margin: 'dense' } },
      MuiTab: { styleOverrides: { root: { minHeight: 36, textTransform: 'none' } } },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 36 },
          // In forced-colors (high contrast) mode the system replaces background colours, which would make the
          // selected tab's underline vanish; keep it, in the system's highlight colour.
          indicator: { '@media (forced-colors: active)': { forcedColorAdjust: 'none', backgroundColor: 'Highlight' } }
        }
      },
      MuiToolbar: { defaultProps: { variant: 'dense' } }
    }
  })
}
