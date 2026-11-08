// shell/renderer/theme/fontTheme.ts — font roles into a MUI theme: which typography variants and which components
// each role styles. See docs/font-roles-design.md#renderer-roles-in-the-mui-theme.
import type { Components, Theme, TypographyVariantsOptions } from '@mui/material/styles'
import type { CSSProperties } from 'react'
import type { ResolvedFonts } from '@tessera/types'
import { isChosen } from '../../../shared/fonts/resolveFonts'
import { BASE_FONT_SIZE } from '../../../shared/fonts/roles'

/** The part of MUI's theme options the font roles decide. */
export interface FontThemeOptions {
  typography: TypographyVariantsOptions
  components: Components<Omit<Theme, 'components'>>
}

/** Variants that belong to Headings: MUI's heading levels and subtitles (dialog titles are h6). */
const HEADING_VARIANTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'subtitle1', 'subtitle2'] as const
/** Variants that belong to Small text. Helper text under fields is drawn from `caption`, so it follows. */
const SMALL_VARIANTS = ['caption', 'overline'] as const
/** Variants whose weight is Interface text's. */
const UI_WEIGHT_VARIANTS = ['body1', 'body2', 'button'] as const

/** A size in CSS pixels as rem of the browser's 16 px root, as MUI writes its own sizes: exact, and it follows the root. */
export const rem = (px: number) => `${px / 16}rem`

/** The sizes MUI gives a button's start and end icons, by button size: fixed pixels, which don't follow the text. */
const BUTTON_ICON_PX = { small: 18, medium: 20, large: 22 } as const

/**
 * The typography and component options for `fonts`.
 *
 * Interface text's family and size are always set: they are MUI's `fontFamily` and `fontSize`, from which MUI derives
 * every variant (and its own icons), so the rest of the type scale follows them. Everything else is emitted only for
 * a value the user or a theme chose; left alone, MUI's own derivation applies, which is what the shell drew before font
 * roles, and which already carries Interface text's family into every variant. The `numeric` and `monospace` variants
 * are always defined, so views can use them whatever is chosen.
 */
export function fontThemeOptions(fonts: ResolvedFonts): FontThemeOptions {
  const { ui, heading, small, table, numeric, monospace } = fonts
  const typography: Record<string, unknown> = {
    fontFamily: ui.fontFamily,
    fontSize: ui.size
  }
  const components: Components<Omit<Theme, 'components'>> = {}

  /** Merges `style` into a variant's options. */
  const variant = (name: string, style: CSSProperties) => {
    typography[name] = { ...(typography[name] as CSSProperties | undefined), ...style }
  }

  if (isChosen(ui.sources.weight)) for (const name of UI_WEIGHT_VARIANTS) variant(name, { fontWeight: ui.weight })

  if (isChosen(heading.sources.family)) for (const name of HEADING_VARIANTS) variant(name, { fontFamily: heading.fontFamily })
  if (isChosen(heading.sources.weight)) for (const name of HEADING_VARIANTS) variant(name, { fontWeight: heading.weight })

  // Small text: the caption variants, and tooltips, which MUI sizes on their own (pxToRem(11)) from the base family
  const smallStyle: CSSProperties = {
    ...(isChosen(small.sources.family) && { fontFamily: small.fontFamily }),
    ...(isChosen(small.sources.size) && { fontSize: rem(small.size!) })
  }
  if (Object.keys(smallStyle).length > 0) {
    for (const name of SMALL_VARIANTS) variant(name, smallStyle)
    components.MuiTooltip = { styleOverrides: { tooltip: smallStyle } }
  }

  // Buttons' icons are fixed in pixels by MUI; scale them with the interface size, as every other icon scales. Left to
  // MUI at the shell's own size, which is what the shell drew before font roles.
  if (ui.size !== BASE_FONT_SIZE) {
    const iconSize = ({ ownerState }: { ownerState: { size?: keyof typeof BUTTON_ICON_PX } }) =>
      ({ '& > *:nth-of-type(1)': { fontSize: rem(BUTTON_ICON_PX[ownerState.size ?? 'medium'] * ui.size! / BASE_FONT_SIZE) } })
    components.MuiButton = { styleOverrides: { startIcon: iconSize, endIcon: iconSize } }
  }

  // Tables and registers. The table itself always has the role's size, the same as its cells (MUI draws cells in
  // body2): a table holds no text of its own, but column widths given in em are measured against it, so they follow
  // the text in the cells, whatever size the role has. The cells are styled only when the role is chosen.
  const tableStyle: CSSProperties = {
    ...(isChosen(table.sources.family) && { fontFamily: table.fontFamily }),
    ...(isChosen(table.sources.size) && { fontSize: rem(table.size!) })
  }
  components.MuiTable = { styleOverrides: { root: { ...tableStyle, fontSize: rem(table.size!) } } }
  if (Object.keys(tableStyle).length > 0) components.MuiTableCell = { styleOverrides: { root: tableStyle } }

  // Amounts and figures: digits of equal width always; the family only when one is chosen, else the text around them's
  variant('numeric', { fontVariantNumeric: 'tabular-nums', ...(numeric.fontFamily !== undefined && { fontFamily: numeric.fontFamily }) })

  variant('monospace', { fontFamily: monospace.fontFamily, fontSize: rem(monospace.size!) })

  return { typography: typography as TypographyVariantsOptions, components }
}
