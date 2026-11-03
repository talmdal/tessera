// shell/renderer/theme/createShellTheme.ts — the shell's base theme, and how a theme is built on it.
//
// Every theme Tessera shows is layered on SHELL_BASE: it sets the desktop
// density, the type scale and the component defaults, so a theme only says
// what differs (usually its palette). This is the only module that calls
// createTheme.
import { createTheme } from '@mui/material'
import type { PaletteMode, Theme, ThemeOptions } from '@mui/material'
import { deriveTokens, mergeThemeOptions } from '@tessera/ui'

/** No web fonts: the application must look right offline, and the platform's UI face fits a desktop tool. */
export const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'

/** Bar tab strips and the items strip share this height, in px. */
export const STRIP_HEIGHT = 36

/** The options every theme starts from. `mode` picks MUI's light or dark defaults for what a theme leaves unset. */
export function shellBaseOptions(mode: PaletteMode): ThemeOptions {
  return {
    palette: { mode },
    // Desktop density: a 4 px unit, so `p: 2` is 8 px, and a 13 px base size.
    spacing: 4,
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: SYSTEM_FONT_STACK,
      fontSize: 13,
      button: { textTransform: 'none', fontWeight: 500 },
      amount: { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"' }
    },
    components: {
      MuiButton: { defaultProps: { size: 'small', disableElevation: true } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      MuiTextField: { defaultProps: { size: 'small', margin: 'dense' } },
      MuiFormControl: { defaultProps: { size: 'small', margin: 'dense' } },
      MuiTable: { defaultProps: { size: 'small' } },
      MuiChip: { defaultProps: { size: 'small' } },
      MuiTooltip: { defaultProps: { arrow: true, enterDelay: 400 } },
      MuiTabs: { styleOverrides: { root: { minHeight: STRIP_HEIGHT } } },
      MuiTab: { styleOverrides: { root: { minHeight: STRIP_HEIGHT, minWidth: 0, padding: '6px 12px' } } },
      MuiTypography: { defaultProps: { variantMapping: { amount: 'span' } } }
    }
  }
}

/**
 * Builds the theme for `mode`: the shell's base, then each of `layers` in
 * order (later wins), with `palette.mode` forced to `mode` whatever a layer
 * says, and the `tessera` tokens filled in from the resulting palette.
 */
export function createShellTheme(mode: PaletteMode, ...layers: (ThemeOptions | undefined)[]): Theme {
  const options = mergeThemeOptions<ThemeOptions>(shellBaseOptions(mode), ...layers, { palette: { mode } })
  const theme = createTheme(options)
  theme.tessera = deriveTokens(theme.palette, options.tessera)
  return theme
}
