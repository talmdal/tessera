// shell/renderer/theme/createShellTheme.ts
import { createTheme } from '@mui/material'
import type { Theme } from '@mui/material'
import type { Components } from '@mui/material/styles'
import type { ResolvedFonts, ThemeDescriptor, ThemeMode } from '@tessera/types'
import { resolveFonts } from '../../../shared/fonts/resolveFonts'
import { tokensFor } from '../../../shared/theme/tokens'
import { fontThemeOptions } from './fontTheme'

export interface ShellThemeOptions {
  /**
   * The user asked the system for less motion: no transitions, and no ripple on buttons. Transitions come from
   * the theme, so everything built on it (tabs, buttons, the splitter) follows.
   */
  reducedMotion?: boolean
  /**
   * The font roles, resolved (shared/fonts/resolveFonts.ts). Default: the shell's own, which draw exactly what the
   * shell drew before font roles.
   */
  fonts?: ResolvedFonts
}

export type ComponentOptions = Components<Omit<Theme, 'components'>>

/** Two objects of options merged one key deeper: a key both set to plain objects is merged, `b` winning inside it. */
function mergeOneLevel(a: Record<string, any> | undefined, b: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!a || !b) return a ?? b
  const merged = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const current = merged[key]
    merged[key] = current && typeof current === 'object' && value && typeof value === 'object' ? { ...current, ...value } : value
  }
  return merged
}

/**
 * `extra` merged into `base` per component: default props combined, and style overrides combined slot by slot (a
 * `root` both style keeps the properties of both, `extra` winning where they overlap), so the font roles can style a
 * component the shell also configures without undoing what the shell set.
 */
export function mergeComponents(base: ComponentOptions, extra: ComponentOptions): ComponentOptions {
  const merged: Record<string, any> = { ...base }
  for (const [name, options] of Object.entries(extra) as [string, any][]) {
    const current = merged[name]
    if (current === undefined) { merged[name] = options; continue }
    const defaultProps = mergeOneLevel(current.defaultProps, options.defaultProps)
    const styleOverrides = mergeOneLevel(current.styleOverrides, options.styleOverrides)
    merged[name] = { ...current, ...options, ...(defaultProps && { defaultProps }), ...(styleOverrides && { styleOverrides }) }
  }
  return merged as ComponentOptions
}

/**
 * The MUI theme for a theme descriptor in a mode: the descriptor's tokens over
 * the shell's, the font roles' typography, and the shell's compact density,
 * which plugin themes can't change. One place to edit for a change of design.
 */
export function createShellTheme(descriptor: ThemeDescriptor, mode: ThemeMode, { reducedMotion = false, fonts = resolveFonts() }: ShellThemeOptions = {}): Theme {
  const tokens = tokensFor(descriptor, mode)
  const fontOptions = fontThemeOptions(fonts)

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
    typography: {
      ...fontOptions.typography,
      // Buttons keep the case they were written in: "Reset sample", not "RESET SAMPLE".
      button: { ...fontOptions.typography.button, textTransform: 'none' }
    },
    shape: { borderRadius: 4 },
    ...(reducedMotion && { transitions: { create: () => 'none' } }),
    // Compact: a desktop data-entry application, not a marketing site. See "Re-evaluate density" in docs/todo.md.
    components: mergeComponents({
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
      MuiToolbar: { defaultProps: { variant: 'dense' } },
      // A dialog's title is a label for it: half MUI's vertical padding (8 px, not 16), so the room goes to the content.
      // Every dialog: the Options dialog, the frame the shell draws for plugins' dialogs, and plugins' own.
      MuiDialogTitle: { styleOverrides: { root: { paddingTop: 8, paddingBottom: 8 } } }
    }, fontOptions.components)
  })
}
