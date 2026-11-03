// tessera-ui/tokens.ts — the values the shell's own surfaces and the finance
// domain need beyond MUI's theme, added to every theme as `theme.tessera`.
//
// A theme may set any of them; the rest are derived from its palette, so a
// theme that only chooses colours still gets coherent bars and amounts. A
// plugin never invents a colour: it reads a token, and if the token it needs
// is missing, the token is added here.
import type { Palette } from '@mui/material'
import type { CSSProperties } from 'react'

export interface TesseraTokens {
  /** The bars around the main area. */
  bar: {
    /** A bar's surface. */
    background: string
    /** The rail a collapsed bar leaves. */
    railBackground: string
    /** The mark on the rail's active icon. */
    railIndicator: string
    /** The line under a bar's tab strip. */
    tabStripBorder: string
  }
  /** The draggable edge of a bar. */
  splitter: {
    idle: string
    hover: string
    active: string
  }
  /** Amounts and transaction states. */
  finance: {
    /** Money in. */
    credit: string
    /** Money out. */
    debit: string
    transfer: string
    reconciled: string
    uncleared: string
  }
}

/** What a theme may give: any subset, at any depth. */
export type TesseraTokenOptions = { [Group in keyof TesseraTokens]?: Partial<TesseraTokens[Group]> }

declare module '@mui/material/styles' {
  interface Theme {
    tessera: TesseraTokens
  }
  interface ThemeOptions {
    tessera?: TesseraTokenOptions
  }
  interface TypographyVariants {
    /** Monetary amounts: tabular figures, so columns of numbers line up. */
    amount: CSSProperties
  }
  interface TypographyVariantsOptions {
    amount?: CSSProperties
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    amount: true
  }
}

/** Every token: the theme's where it gave one, otherwise derived from its palette. */
export function deriveTokens(palette: Palette, given: TesseraTokenOptions = {}): TesseraTokens {
  // MUI's default paper and default backgrounds are the same colour, so a bar is set off from the
  // main area with a slight tint from the grey ramp, as an editor's side bar is.
  const surface = palette.mode === 'light' ? palette.grey[50] : palette.grey[900]
  return {
    bar: {
      background: surface,
      railBackground: surface,
      railIndicator: palette.primary.main,
      tabStripBorder: palette.divider,
      ...given.bar
    },
    splitter: {
      idle: 'transparent',
      hover: palette.action.hover,
      active: palette.primary.main,
      ...given.splitter
    },
    finance: {
      credit: palette.success.main,
      debit: palette.error.main,
      transfer: palette.info.main,
      reconciled: palette.text.secondary,
      uncleared: palette.warning.main,
      ...given.finance
    }
  }
}
