import { describe, expect, it } from 'vitest'
import { themeOf, tokensFor, windowBackground } from '../../shared/theme/tokens'
import { DEFAULT_THEME, DEFAULT_THEME_ID } from '../../shared/theme/types'
import { midnight, sunrise } from '../helpers/theme'

describe('tokensFor', () => {
  it("gives the shell theme's tokens for the shell theme", () => {
    expect(tokensFor(DEFAULT_THEME, 'dark')).toEqual(DEFAULT_THEME.dark)
    expect(tokensFor(DEFAULT_THEME, 'light')).toEqual(DEFAULT_THEME.light)
  })

  it("takes what a theme sets and the shell theme's for the rest", () => {
    const tokens = tokensFor(sunrise(), 'light')

    expect(tokens.primary).toBe('#ff8800')
    expect(tokens.background).toEqual(DEFAULT_THEME.light!.background)
    expect(tokens.text).toEqual(DEFAULT_THEME.light!.text)
    expect(tokens.divider).toBe(DEFAULT_THEME.light!.divider)
  })

  it('merges nested tokens one by one', () => {
    const theme = sunrise({ light: { background: { paper: '#eeeeee' }, text: { secondary: '#333333' } } })

    const tokens = tokensFor(theme, 'light')

    expect(tokens.background).toEqual({ default: DEFAULT_THEME.light!.background!.default, paper: '#eeeeee' })
    expect(tokens.text).toEqual({ primary: DEFAULT_THEME.light!.text!.primary, secondary: '#333333' })
  })

  it('uses a different variant for each mode', () => {
    expect(tokensFor(sunrise(), 'light').primary).toBe('#ff8800')
    expect(tokensFor(sunrise(), 'dark').primary).toBe('#ffaa55')
  })

  it("shows the shell theme's tokens for a mode the theme has no variant for", () => {
    expect(tokensFor(midnight(), 'light')).toEqual(DEFAULT_THEME.light)
  })

  it('returns every token, so a caller never meets a gap', () => {
    const tokens = tokensFor({ id: 'p.x', label: 'x', dark: {} }, 'dark')

    expect(Object.values(tokens).flatMap(v => typeof v === 'object' ? Object.values(v) : [v]).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
  })
})

describe('themeOf', () => {
  const themes = [DEFAULT_THEME, sunrise()]

  it('finds the registered theme a state shows', () => {
    expect(themeOf({ theme: 'p.sunrise' }, themes)).toBe(themes[1])
  })

  it("falls back to the shell's theme for one that is not registered", () => {
    expect(themeOf({ theme: 'p.gone' }, themes).id).toBe(DEFAULT_THEME_ID)
  })

  it("falls back to the shell's theme even when handed an empty list", () => {
    expect(themeOf({ theme: 'p.gone' }, [])).toBe(DEFAULT_THEME)
  })
})

describe('windowBackground', () => {
  const themes = [DEFAULT_THEME, sunrise({ light: { background: { default: '#fff8e0' } } }), midnight(), sunrise({ id: 'p.rgb', light: { background: { default: 'rgb(255, 0, 0)' } } })]

  it("paints with the theme's default background in the shown mode", () => {
    expect(windowBackground({ theme: DEFAULT_THEME_ID, mode: 'dark' }, themes)).toBe('#121212')
    expect(windowBackground({ theme: DEFAULT_THEME_ID, mode: 'light' }, themes)).toBe('#fafafa')
    expect(windowBackground({ theme: 'p.sunrise', mode: 'light' }, themes)).toBe('#fff8e0')
    expect(windowBackground({ theme: 'p.midnight', mode: 'dark' }, themes)).toBe('#000011')
  })

  it("uses the shell theme's colour when the theme's is not plain hex, which a window cannot take", () => {
    expect(windowBackground({ theme: 'p.rgb', mode: 'light' }, themes)).toBe('#fafafa')
  })

  it("uses the shell theme's colour for a theme that is not registered", () => {
    expect(windowBackground({ theme: 'p.gone', mode: 'dark' }, themes)).toBe('#121212')
  })
})
