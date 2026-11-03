import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useTheme } from '@mui/material'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { SYSTEM_FONT_STACK, createShellTheme, shellBaseOptions } from '../../shell/renderer/theme/createShellTheme'

describe('createShellTheme', () => {
  it('builds a light and a dark theme on the shell\'s base', () => {
    const light = createShellTheme('light')
    const dark = createShellTheme('dark')
    expect(light.palette.mode).toBe('light')
    expect(dark.palette.mode).toBe('dark')
    expect(light.palette.background.default).not.toBe(dark.palette.background.default)
    expect(light.typography.fontFamily).toBe(SYSTEM_FONT_STACK)
    expect(light.typography.fontSize).toBe(13)
    expect(light.spacing(2)).toBe('8px')
    expect(light.components?.MuiButton?.defaultProps?.size).toBe('small')
  })

  it('fills every tessera token from the palette when a theme gives none', () => {
    const theme = createShellTheme('light')
    expect(theme.tessera.bar.background).toBe(theme.palette.grey[50])
    expect(createShellTheme('dark').tessera.bar.background).toBe(createShellTheme('dark').palette.grey[900])
    expect(theme.tessera.splitter.active).toBe(theme.palette.primary.main)
    expect(theme.tessera.finance.credit).toBe(theme.palette.success.main)
    expect(theme.tessera.finance.debit).toBe(theme.palette.error.main)
    for (const group of Object.values(theme.tessera)) {
      for (const [token, value] of Object.entries(group)) expect(value, token).toBeTypeOf('string')
    }
  })

  it('layers options over the base, later layers winning, and keeps the tokens a theme set', () => {
    const theme = createShellTheme('dark',
      { palette: { primary: { main: '#268bd2' } }, shape: { borderRadius: 0 }, tessera: { finance: { credit: '#859900' } } },
      { shape: { borderRadius: 12 } })
    expect(theme.palette.primary.main).toBe('#268bd2')
    expect(theme.palette.primary.light).not.toBe('#268bd2')      // MUI still derives the rest of the colour
    expect(theme.shape.borderRadius).toBe(12)
    expect(theme.tessera.finance.credit).toBe('#859900')
    expect(theme.tessera.finance.debit).toBe(theme.palette.error.main)
    expect(theme.spacing(1)).toBe('4px')                          // base still there
  })

  it('forces the mode whatever a layer says', () => {
    expect(createShellTheme('dark', { palette: { mode: 'light' } }).palette.mode).toBe('dark')
  })

  it('has an amount typography variant with tabular figures', () => {
    const theme = createShellTheme('light')
    expect(theme.typography.amount.fontVariantNumeric).toBe('tabular-nums')
    expect(shellBaseOptions('light').components?.MuiTypography?.defaultProps?.variantMapping?.amount).toBe('span')
  })
})

function Probe() {
  const theme = useTheme()
  return <p>{theme.palette.mode} {theme.tessera.finance.credit} {theme.typography.fontSize}</p>
}

describe('ShellThemeProvider', () => {
  it('provides the shell\'s theme to components below it', () => {
    render(<ShellThemeProvider mode="dark"><Probe /></ShellThemeProvider>)
    const dark = createShellTheme('dark')
    expect(screen.getByText(`dark ${dark.tessera.finance.credit} 13`)).toBeInTheDocument()
  })

  it('follows the system preference when no mode is given (light where matchMedia is absent, as in jsdom)', () => {
    render(<ShellThemeProvider><Probe /></ShellThemeProvider>)
    expect(screen.getByText(/^light /)).toBeInTheDocument()
  })

  it('applies the baseline and the page styles the layout frame relies on', () => {
    render(<ShellThemeProvider mode="light"><Probe /></ShellThemeProvider>)
    const css = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n')
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/overflow:\s*hidden/)
    expect(css).toMatch(/color-scheme:\s*light/)    // CssBaseline enableColorScheme
  })
})
