import { act, render, screen, waitFor } from '@testing-library/react'
import { useTheme } from '@mui/material'
import { useThemeState as usePublicThemeState } from '@tessera/ui'
import { describe, expect, it, vi } from 'vitest'
import type { ThemeDescriptor, ThemeSnapshot } from '@tessera/types'
import { DEFAULT_THEME, THEME_CHANGED, THEME_GET } from '../../shared/theme/types'
import { FONT_STACK, createShellTheme } from '../../shell/renderer/theme/createShellTheme'
import { ShellThemeProvider, useWindowTheme } from '../../shell/renderer/theme/ShellThemeProvider'
import { midnight, sunrise } from '../helpers/theme'
import { createFakeRemote } from '../helpers/fakeBridge'

const snapshot = (over: Partial<ThemeSnapshot['state']> = {}, themes: ThemeDescriptor[] = [DEFAULT_THEME]): ThemeSnapshot => ({
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'system' }, theme: DEFAULT_THEME.id, mode: 'light', ...over },
  themes
})

/** Shows what a component below the provider sees. */
function Probe() {
  const theme = useTheme()
  const state = useWindowTheme()
  return (
    <>
      <span data-testid="mode">{theme.palette.mode}</span>
      <span data-testid="primary">{theme.palette.primary.main}</span>
      <span data-testid="paper">{theme.palette.background.paper}</span>
      <span data-testid="state">{state.theme}/{state.mode}/{state.windowId}</span>
    </>
  )
}

describe('createShellTheme', () => {
  it("builds the palette from the theme's tokens in the mode", () => {
    const light = createShellTheme(DEFAULT_THEME, 'light')
    const dark = createShellTheme(DEFAULT_THEME, 'dark')

    expect(light.palette.mode).toBe('light')
    expect(light.palette.primary.main).toBe('#1976d2')
    expect(light.palette.background.default).toBe('#fafafa')
    expect(dark.palette.mode).toBe('dark')
    expect(dark.palette.primary.main).toBe('#90caf9')
    expect(dark.palette.background.paper).toBe('#1e1e1e')
    expect(dark.palette.divider).toBe('rgba(255, 255, 255, 0.12)')
  })

  it("lets a plugin theme set some tokens and keeps the shell's for the rest", () => {
    const theme = createShellTheme(sunrise(), 'dark')

    expect(theme.palette.primary.main).toBe('#ffaa55')
    expect(theme.palette.background.default).toBe('#121212')
    expect(theme.palette.text.primary).toBe('rgba(255, 255, 255, 0.87)')
  })

  it('derives the lighter, darker and contrast colours MUI components need', () => {
    const { primary } = createShellTheme(midnight(), 'dark').palette

    expect(primary.main).toBe('#8899ff')
    expect(primary.light).toBeTruthy()
    expect(primary.dark).toBeTruthy()
    expect(primary.contrastText).toBeTruthy()
  })

  it('uses the OS font stack, and the shell\'s own sizing whatever the plugin theme says', () => {
    const theme = createShellTheme(sunrise(), 'light')

    expect(theme.typography.fontFamily).toBe(FONT_STACK)
    expect(theme.typography.fontSize).toBe(13)
    // Buttons keep the case they were written in
    expect(theme.typography.button.textTransform).toBe('none')
  })

  it('is compact: small controls by default', () => {
    const { components } = createShellTheme(DEFAULT_THEME, 'light')

    expect(components?.MuiButton?.defaultProps).toMatchObject({ size: 'small' })
    expect(components?.MuiIconButton?.defaultProps).toMatchObject({ size: 'small' })
    expect(components?.MuiTextField?.defaultProps).toMatchObject({ size: 'small' })
    expect(components?.MuiToolbar?.defaultProps).toMatchObject({ variant: 'dense' })
  })
})

describe('ShellThemeProvider', () => {
  it('themes its children on the very first render when it is given the initial theme', () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ mode: 'dark' })}><Probe /></ShellThemeProvider>)

    // Synchronously: no waiting for a reply, so there is no frame in the wrong colours
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(screen.getByTestId('paper')).toHaveTextContent('#1e1e1e')
  })

  it('draws nothing until the first answer when it has no initial theme, then themes its children', async () => {
    const { bridge, resolve } = createFakeRemote({ [THEME_GET]: 'deferred' })

    render(<ShellThemeProvider bridge={bridge}><Probe /></ShellThemeProvider>)
    expect(screen.queryByTestId('mode')).toBeNull()

    await act(async () => { resolve(THEME_GET, snapshot({ mode: 'dark' })) })

    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
  })

  it('exposes the window state to its children', () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ windowId: 6, theme: 'p.sunrise', mode: 'dark' }, [DEFAULT_THEME, sunrise()])}><Probe /></ShellThemeProvider>)

    expect(screen.getByTestId('state')).toHaveTextContent('p.sunrise/dark/6')
    expect(screen.getByTestId('primary')).toHaveTextContent('#ffaa55')
  })

  it('follows a change pushed by the main process, such as the OS switching to dark', async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Probe /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())
    expect(screen.getByTestId('mode')).toHaveTextContent('light')

    act(() => emit(THEME_CHANGED, snapshot({ mode: 'dark' })))

    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(screen.getByTestId('paper')).toHaveTextContent('#1e1e1e')
  })

  it('switches to a theme a plugin has just contributed', async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Probe /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())

    act(() => emit(THEME_CHANGED, snapshot({ theme: 'p.midnight', mode: 'dark' }, [DEFAULT_THEME, midnight()])))

    expect(screen.getByTestId('primary')).toHaveTextContent('#8899ff')
  })

  it("ignores another window's change", async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Probe /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())

    act(() => emit(THEME_CHANGED, snapshot({ windowId: 2, mode: 'dark' })))

    expect(screen.getByTestId('mode')).toHaveTextContent('light')
    expect(screen.getByTestId('state')).toHaveTextContent('/light/1')
  })

  it('applies a change that arrived while the first answer was in flight, on top of it', async () => {
    const { bridge, emit, resolve } = createFakeRemote({ [THEME_GET]: 'deferred' })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Probe /></ShellThemeProvider>)

    act(() => emit(THEME_CHANGED, snapshot({ mode: 'dark' })))
    await act(async () => { resolve(THEME_GET, snapshot({ mode: 'light' })) })

    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
  })

  it('keeps the same MUI theme object across re-renders that change nothing it is built from', async () => {
    const seen: unknown[] = []
    const Capture = () => { seen.push(useTheme()); return null }
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Capture /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())

    // Only the global setting changed; the window still shows the same theme and mode
    act(() => emit(THEME_CHANGED, snapshot({ global: { theme: DEFAULT_THEME.id, mode: 'light' } })))

    expect(new Set(seen).size).toBe(1)
  })

  it('sets the page colours from the theme, as the baseline does', () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ mode: 'dark' })}><Probe /></ShellThemeProvider>)

    expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(18, 18, 18)')
  })

  it('gives plugins the theme and mode as data through @tessera/ui, and nothing that could change them', () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    let seen: unknown
    const Plugin = () => { seen = usePublicThemeState(); return null }

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ windowId: 6, theme: 'p.sunrise', mode: 'dark' }, [DEFAULT_THEME, sunrise()])}><Plugin /></ShellThemeProvider>)

    expect(seen).toEqual({ theme: 'p.sunrise', mode: 'dark' })
  })

  it('keeps the same object for the plugin while the window shows the same theme and mode', async () => {
    const seen: unknown[] = []
    const Plugin = () => { seen.push(usePublicThemeState()); return null }
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Plugin /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())

    act(() => emit(THEME_CHANGED, snapshot({ global: { theme: DEFAULT_THEME.id, mode: 'light' } })))

    expect(new Set(seen).size).toBe(1)
  })

  it('refuses a plugin that asks for the theme outside the shell', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Plugin = () => { usePublicThemeState(); return null }

    expect(() => render(<Plugin />)).toThrow('useThemeState must be used inside the shell')
  })

  it('throws a clear error when a component asks for the theme outside it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Outside = () => { useWindowTheme(); return null }

    expect(() => render(<Outside />)).toThrow('This hook must be used inside <ShellThemeProvider>')
  })
})
