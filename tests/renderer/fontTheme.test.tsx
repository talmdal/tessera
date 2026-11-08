// Font roles in the MUI theme: the shell's defaults draw exactly what the shell drew before font roles (the golden
// tests), and each role, when the user or a theme sets it, styles the variants and components it covers.
import { render, screen } from '@testing-library/react'
import { createTheme, ThemeProvider } from '@mui/material'
import { Table, TableBody, TableCell, TableRow, Typography } from '@tessera/ui'
import { describe, expect, it } from 'vitest'
import type { FontSettings, ThemeFonts } from '@tessera/types'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../shared/fonts/resolveFonts'
import { FONT_STACK, MONO_STACK } from '../../shared/fonts/roles'
import { DEFAULT_THEME } from '../../shared/theme/types'
import { createShellTheme, mergeComponents } from '../../shell/renderer/theme/createShellTheme'
import { fontThemeOptions, rem } from '../../shell/renderer/theme/fontTheme'

const STANDARD_VARIANTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'subtitle1', 'subtitle2', 'body1', 'body2', 'button', 'caption', 'overline'] as const

/** The user's settings: the defaults with some roles changed. */
function settings(roles: { [K in keyof FontSettings['roles']]?: Partial<FontSettings['roles'][K]> } = {}): FontSettings {
  return {
    useThemeFonts: true,
    roles: Object.fromEntries(Object.entries(DEFAULT_FONT_SETTINGS.roles).map(([id, v]) => [id, { ...v, ...(roles as any)[id] }])) as FontSettings['roles']
  }
}
const themed = (user: FontSettings, theme?: ThemeFonts) => createShellTheme(DEFAULT_THEME, 'light', { fonts: resolveFonts(user, theme) })
const px = (remValue: unknown) => +(parseFloat(String(remValue)) * 16).toFixed(2)

describe('the font roles at their defaults (golden)', () => {
  // What createShellTheme passed MUI before font roles: the OS font stack at 13 px, buttons in their own case
  const before = createTheme({ typography: { fontFamily: FONT_STACK, fontSize: 13, button: { textTransform: 'none' } } })
  const now = createShellTheme(DEFAULT_THEME, 'light')

  it('give every standard typography variant exactly as before', () => {
    for (const name of STANDARD_VARIANTS) expect({ [name]: now.typography[name] }).toEqual({ [name]: before.typography[name] })
    for (const key of ['fontFamily', 'fontSize', 'htmlFontSize', 'fontWeightLight', 'fontWeightRegular', 'fontWeightMedium', 'fontWeightBold'] as const) {
      expect(now.typography[key]).toBe(before.typography[key])
    }
    expect(now.typography.pxToRem(11)).toBe(before.typography.pxToRem(11))
  })

  it("keep MUI 9's scale at 13 px, as measured in Chromium in phase 0", () => {
    // If an MUI upgrade changes its scale, this fails: update the figures in docs/font-roles-design.md#phase-0-results too
    const t = now.typography
    expect({
      h4: px(t.h4.fontSize), h5: px(t.h5.fontSize), h6: px(t.h6.fontSize), subtitle1: px(t.subtitle1.fontSize), subtitle2: px(t.subtitle2.fontSize),
      body1: px(t.body1.fontSize), body2: px(t.body2.fontSize), button: px(t.button.fontSize), caption: px(t.caption.fontSize), overline: px(t.overline.fontSize),
      tooltip: px(t.pxToRem(11)), smallButton: px(t.pxToRem(13)), smallIcon: px(t.pxToRem(20))
    }).toEqual({
      h4: 31.57, h5: 22.29, h6: 18.57, subtitle1: 14.86, subtitle2: 13,
      body1: 14.86, body2: 13, button: 13, caption: 11.14, overline: 11.14,
      tooltip: 10.21, smallButton: 12.07, smallIcon: 18.57
    })
  })

  it("style no component beyond the shell's own, but tables, which take their cells' size", () => {
    expect(Object.keys(now.components ?? {}).sort())
      .toEqual(['MuiButton', 'MuiDialogTitle', 'MuiFormControl', 'MuiIconButton', 'MuiTab', 'MuiTable', 'MuiTabs', 'MuiTextField', 'MuiToolbar'])
    // The table holds no text of its own, so nothing looks different; its size is what widths in em are measured by
    expect(now.components?.MuiTable?.styleOverrides?.root).toEqual({ fontSize: now.typography.body2.fontSize })
    expect(now.components?.MuiTableCell).toBeUndefined()
    // Buttons' icons are left to MUI at the shell's own size
    expect(now.components?.MuiButton).toEqual({ defaultProps: { size: 'small' } })
  })

  it('add the numeric and monospace variants, which nothing drew before', () => {
    expect(now.typography.numeric).toEqual({ fontVariantNumeric: 'tabular-nums' })
    expect(now.typography.monospace).toEqual({ fontFamily: MONO_STACK, fontSize: '0.8125rem' })
  })

  it('are what createShellTheme uses when it is given no fonts', () => {
    expect(JSON.stringify(createShellTheme(DEFAULT_THEME, 'dark', { fonts: resolveFonts() }).typography))
      .toBe(JSON.stringify(createShellTheme(DEFAULT_THEME, 'dark').typography))
  })
})

describe('each role in the MUI theme', () => {
  it('Interface text: the base family and size, from which every variant follows', () => {
    const t = themed(settings({ ui: { family: ['Inter'], size: 16 } })).typography

    expect(t.fontFamily).toBe(`"Inter", ${FONT_STACK}`)
    expect(t.fontSize).toBe(16)
    expect(px(t.body2.fontSize)).toBe(16)
    expect(t.h6.fontFamily).toBe(`"Inter", ${FONT_STACK}`)
    expect(t.monospace).toMatchObject({ fontFamily: MONO_STACK, fontSize: rem(16) })
  })

  it("Interface text's weight: body text and buttons, not headings", () => {
    const t = themed(settings({ ui: { weight: 500 } })).typography

    expect([t.body1.fontWeight, t.body2.fontWeight, t.button.fontWeight]).toEqual([500, 500, 500])
    expect(t.h4.fontWeight).toBe(400)
    // Buttons still keep their case
    expect(t.button.textTransform).toBe('none')
  })

  it('Headings: every heading level and subtitle, each keeping its own size', () => {
    const t = themed(settings({ heading: { family: ['Georgia', 'serif'], weight: 700 } })).typography
    const georgia = `"Georgia", serif, ${FONT_STACK}`

    for (const name of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'subtitle1', 'subtitle2'] as const) {
      expect(t[name]).toMatchObject({ fontFamily: georgia, fontWeight: 700 })
    }
    expect(px(t.h6.fontSize)).toBe(18.57)
    expect(t.body1.fontFamily).toBe(FONT_STACK)
  })

  it('Small text: captions, overlines and tooltips (helper text is drawn from the caption)', () => {
    const theme = themed(settings({ small: { family: ['Inter'], size: 12 } }))
    const small = { fontFamily: `"Inter", ${FONT_STACK}`, fontSize: '0.75rem' }

    expect(theme.typography.caption).toMatchObject(small)
    expect(theme.typography.overline).toMatchObject(small)
    expect(theme.components?.MuiTooltip?.styleOverrides?.tooltip).toEqual(small)
  })

  it('Tables and registers: the table and its cells, so widths in em follow the role', () => {
    const theme = themed(settings({ table: { size: 15 } }))

    expect(theme.components?.MuiTableCell?.styleOverrides?.root).toEqual({ fontSize: rem(15) })
    expect(theme.components?.MuiTable?.styleOverrides?.root).toEqual({ fontSize: rem(15) })
    // The table follows its own role only: body text is unchanged
    expect(px(theme.typography.body2.fontSize)).toBe(13)
  })

  it('Amounts and figures: always tabular, in a family only when one is chosen', () => {
    expect(themed(settings({ numeric: { family: ['Cascadia Mono'] } })).typography.numeric)
      .toEqual({ fontVariantNumeric: 'tabular-nums', fontFamily: `"Cascadia Mono", ${FONT_STACK}` })
  })

  it('Fixed-width text: its own family and size', () => {
    expect(themed(settings({ monospace: { family: ['Iosevka'], size: 12 } })).typography.monospace)
      .toEqual({ fontFamily: `"Iosevka", ${MONO_STACK}`, fontSize: '0.75rem' })
  })

  it("takes a theme's fonts the same way as the user's", () => {
    const t = themed(settings(), { heading: { family: ['Georgia'] }, ui: { size: 14 } }).typography

    expect(t.fontSize).toBe(14)
    expect(t.h6.fontFamily).toBe(`"Georgia", ${FONT_STACK}`)
  })

  it('emits nothing for a role that is only inherited: MUI derives it', () => {
    // Only Interface text's family is set; the other roles follow it without overrides of their own
    const { typography, components } = fontThemeOptions(resolveFonts(settings({ ui: { family: ['Inter'] } })))

    expect(Object.keys(typography).sort()).toEqual(['fontFamily', 'fontSize', 'monospace', 'numeric'])
    expect(Object.keys(components)).toEqual(['MuiTable'])
  })

  it("sizes a table like its cells whatever sets the size, so widths in em follow the cells' text", () => {
    // Following Interface text: the table's size moves with it, and the cells need no override (they are body2)
    const inherited = themed(settings({ ui: { size: 16 } }))
    expect(inherited.components?.MuiTable?.styleOverrides?.root).toEqual({ fontSize: rem(16) })
    expect(inherited.components?.MuiTableCell).toBeUndefined()

    // Chosen for the role: table and cells alike
    const chosen = themed(settings({ table: { family: ['Inter'], size: 15 } }))
    const style = { fontFamily: `"Inter", ${FONT_STACK}`, fontSize: rem(15) }
    expect(chosen.components?.MuiTable?.styleOverrides?.root).toEqual(style)
    expect(chosen.components?.MuiTableCell?.styleOverrides?.root).toEqual(style)
  })

  it("scales buttons' icons, which MUI fixes in pixels, with the interface size", () => {
    const startIcon = themed(settings({ ui: { size: 20 } })).components?.MuiButton?.styleOverrides?.startIcon as (props: any) => any
    const endIcon = themed(settings({ ui: { size: 20 } })).components?.MuiButton?.styleOverrides?.endIcon as (props: any) => any
    const size = (button: 'small' | 'medium' | 'large') => startIcon({ ownerState: { size: button } })['& > *:nth-of-type(1)'].fontSize

    // MUI's 18, 20 and 22 px, times 20/13
    expect([size('small'), size('medium'), size('large')]).toEqual([rem(18 * 20 / 13), rem(20 * 20 / 13), rem(22 * 20 / 13)])
    expect(endIcon({ ownerState: {} })['& > *:nth-of-type(1)'].fontSize).toBe(rem(20 * 20 / 13))
    // The shell's own button defaults are kept
    expect(themed(settings({ ui: { size: 20 } })).components?.MuiButton?.defaultProps).toEqual({ size: 'small' })
  })
})

describe('mergeComponents', () => {
  it("combines a component's style overrides slot by slot, so a role never undoes what the shell set", () => {
    const merged = mergeComponents(
      { MuiTab: { defaultProps: { disableRipple: true }, styleOverrides: { root: { minHeight: 36, textTransform: 'none' } } } },
      { MuiTab: { styleOverrides: { root: { fontFamily: 'x' }, icon: { gap: 2 } } }, MuiTable: { styleOverrides: { root: { fontSize: '1rem' } } } }
    )

    expect(merged.MuiTab).toEqual({
      defaultProps: { disableRipple: true },
      styleOverrides: { root: { minHeight: 36, textTransform: 'none', fontFamily: 'x' }, icon: { gap: 2 } }
    })
    expect(merged.MuiTable).toEqual({ styleOverrides: { root: { fontSize: '1rem' } } })
  })
})

describe('roles as components draw them', () => {
  const rules = () => [...document.querySelectorAll('style')].map(s => s.textContent).join('\n')
  /** The CSS declarations that apply to an element through its Emotion classes. */
  const cssOf = (el: Element) => [...el.classList].flatMap(c => rules().split('}').filter(r => r.includes(`.${c}`))).join('}')

  it('draws a numeric Typography as a span with digits of equal width', () => {
    render(<ThemeProvider theme={createShellTheme(DEFAULT_THEME, 'light')}><Typography variant="numeric">1,234.56</Typography></ThemeProvider>)

    const figure = screen.getByText('1,234.56')
    expect(figure.tagName).toBe('SPAN')
    expect(cssOf(figure)).toContain('font-variant-numeric:tabular-nums')
  })

  it('draws table cells in the Tables and registers size', () => {
    render(
      <ThemeProvider theme={themed(settings({ table: { size: 15 } }))}>
        <Table><TableBody><TableRow><TableCell>Metro</TableCell></TableRow></TableBody></Table>
      </ThemeProvider>)

    expect(cssOf(screen.getByText('Metro'))).toContain(`font-size:${rem(15)}`)
  })
})
