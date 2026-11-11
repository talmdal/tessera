import { act, render, screen, waitFor } from '@testing-library/react'
import { useTheme, type Theme } from '@mui/material'
import { useFontRoles, useThemeState as usePublicThemeState } from '@tessera/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FontSettings, ThemeDescriptor, ThemeSnapshot } from '@tessera/types'
import { DEFAULT_THEME, THEME_CHANGED, THEME_GET } from '../../shared/theme/types'
import { createShellTheme } from '../../shell/renderer/theme/createShellTheme'
import { FONT_STACK } from '../../shared/fonts/roles'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../shared/fonts/resolveFonts'
import { ShellThemeProvider, useThemeCatalogue, useWindowTheme } from '../../shell/renderer/theme/ShellThemeProvider'
import { midnight, sunrise } from '../helpers/theme'
import { createFakeRemote } from '../helpers/fakeBridge'
import { settle } from '../helpers/settle'

const snapshot = (over: Partial<ThemeSnapshot['state']> = {}, themes: ThemeDescriptor[] = [DEFAULT_THEME]): ThemeSnapshot => ({
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'system' }, theme: DEFAULT_THEME.id, mode: 'light', ...over },
  themes,
  fonts: DEFAULT_FONT_SETTINGS
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
    // Dialog titles are labels: half MUI's vertical padding
    expect(components?.MuiDialogTitle?.styleOverrides?.root).toEqual({ paddingTop: 8, paddingBottom: 8 })
  })
})

describe('useFontRoles', () => {
  function Fonts() {
    const fonts = useFontRoles()
    return <span data-testid="fonts">{JSON.stringify(fonts)}</span>
  }

  it("gives a plugin the window's fonts as data, from the shell's provider", async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Fonts /></ShellThemeProvider>)

    expect(JSON.parse(screen.getByTestId('fonts').textContent!)).toEqual(JSON.parse(JSON.stringify(resolveFonts())))
    await settle()
  })

  it('says it needs the shell when used outside it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Fonts />)).toThrow('useFontRoles must be used inside the shell')
    vi.mocked(console.error).mockRestore()
  })
})

describe("ShellThemeProvider: the user's fonts", () => {
  /** The user's fonts: the defaults with Interface text at `size`. */
  const sized = (size: number): FontSettings =>
    ({ ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: null, size, weight: null } } })
  const withFonts = (fonts: FontSettings, over: Partial<ThemeSnapshot['state']> = {}): ThemeSnapshot => ({ ...snapshot(over), fonts })
  const fontsWith = (roles: Partial<FontSettings['roles']>): FontSettings => ({ ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ...roles } })

  let themes: Theme[] = []
  function FontProbe() {
    const theme = useTheme()
    const roles = useFontRoles()
    const { fonts } = useThemeCatalogue()
    themes.push(theme)
    return (
      <>
        <span data-testid="fontSize">{theme.typography.fontSize}</span>
        <span data-testid="role">{roles.ui.size}</span>
        <span data-testid="catalogue">{fonts.roles.ui.size ?? 'automatic'}</span>
      </>
    )
  }
  beforeEach(() => { themes = [] })

  it("draws the very first frame in the user's fonts, from the initial snapshot", async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => withFonts(sized(16)) })

    render(<ShellThemeProvider bridge={bridge} initial={withFonts(sized(16))}><FontProbe /></ShellThemeProvider>)

    // Synchronously: no frame in the shell's own fonts first
    expect(screen.getByTestId('fontSize')).toHaveTextContent('16')
    expect(screen.getByTestId('role')).toHaveTextContent('16')
    expect(screen.getByTestId('catalogue')).toHaveTextContent('16')
    expect(themes.every(t => t.typography.fontSize === 16)).toBe(true)
    await settle()
  })

  it('builds exactly the theme it built before the setting existed, at the defaults', async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><FontProbe /></ShellThemeProvider>)
    await settle()

    const before = createShellTheme(DEFAULT_THEME, 'light')
    expect(JSON.stringify(themes.at(-1)!.typography)).toBe(JSON.stringify(before.typography))
    expect(JSON.stringify(themes.at(-1)!.components)).toBe(JSON.stringify(before.components))
    expect(screen.getByTestId('catalogue')).toHaveTextContent('automatic')
  })

  it('re-fonts the window when the user changes the fonts', async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><FontProbe /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())
    await settle()

    act(() => emit(THEME_CHANGED, withFonts(sized(20))))

    expect(screen.getByTestId('fontSize')).toHaveTextContent('20')
    expect(screen.getByTestId('role')).toHaveTextContent('20')
  })

  it("ignores another window's fonts", async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><FontProbe /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())
    await settle()

    act(() => emit(THEME_CHANGED, withFonts(sized(20), { windowId: 2 })))

    expect(screen.getByTestId('fontSize')).toHaveTextContent('13')
  })

  describe("a theme's fonts", () => {
    const serif = sunrise({ fonts: { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } } })
    const onSerif = (fonts: FontSettings, over: Partial<ThemeSnapshot['state']> = {}) =>
      withFonts(fonts, { theme: serif.id, global: { theme: serif.id, mode: 'light' }, ...over })
    function HeadingProbe() {
      const theme = useTheme()
      const roles = useFontRoles()
      return <span data-testid="heading">{`${theme.typography.h6.fontFamily}|${theme.typography.fontSize}|${roles.heading.sources.family}`}</span>
    }
    const render_ = (initial: ThemeSnapshot) => {
      const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => initial })
      render(<ShellThemeProvider bridge={bridge} initial={{ ...initial, themes: [DEFAULT_THEME, serif] }}><HeadingProbe /></ShellThemeProvider>)
      return { emit }
    }
    const heading = () => screen.getByTestId('heading').textContent!.split('|')

    it('draws the window in the fonts of the theme it shows, for what the user left on Automatic', async () => {
      render_(onSerif(DEFAULT_FONT_SETTINGS))

      expect(heading()).toEqual([`"Georgia", serif, ${FONT_STACK}`, '14', 'theme'])
      await settle()
    })

    it("puts the user's own choice first", async () => {
      render_(onSerif(fontsWith({ heading: { family: ['Inter'], weight: null }, ui: { family: null, size: 16, weight: null } })))

      expect(heading()).toEqual([`"Inter", ${FONT_STACK}`, '16', 'user'])
      await settle()
    })

    it('ignores them when the user turned theme fonts off', async () => {
      render_(onSerif({ ...DEFAULT_FONT_SETTINGS, useThemeFonts: false }))

      expect(heading()).toEqual([FONT_STACK, '13', 'inherited'])
      await settle()
    })

    it("uses a window's own theme's fonts, and the new theme's when the theme changes", async () => {
      const { emit } = render_(withFonts(DEFAULT_FONT_SETTINGS))
      expect(heading()[2]).toBe('inherited')
      // The provider's own first request has been answered, so it can't land after the events below
      await settle()

      act(() => emit(THEME_CHANGED, { ...onSerif(DEFAULT_FONT_SETTINGS, { override: { theme: serif.id, mode: 'light' } }), themes: [DEFAULT_THEME, serif] }))
      expect(heading()).toEqual([`"Georgia", serif, ${FONT_STACK}`, '14', 'theme'])

      act(() => emit(THEME_CHANGED, { ...withFonts(DEFAULT_FONT_SETTINGS), themes: [DEFAULT_THEME, serif] }))
      expect(heading()).toEqual([FONT_STACK, '13', 'inherited'])
    })
  })

  it('keeps the same theme object when a snapshot brings the same fonts again', async () => {
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => withFonts(sized(16)) })
    render(<ShellThemeProvider bridge={bridge} initial={withFonts(sized(16))}><FontProbe /></ShellThemeProvider>)
    await settle()
    const first = themes.at(-1)

    // Equal fonts in a new object, as every snapshot from the main process is
    act(() => emit(THEME_CHANGED, withFonts(sized(16))))

    expect(themes.at(-1)).toBe(first)
  })
})

describe('ShellThemeProvider', () => {
  it('themes its children on the very first render when it is given the initial theme', async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ mode: 'dark' })}><Probe /></ShellThemeProvider>)

    // Synchronously: no waiting for a reply, so there is no frame in the wrong colours
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(screen.getByTestId('paper')).toHaveTextContent('#1e1e1e')
    // The provider still fetches the current theme; let that finish here (these tests check the first render)
    await settle()
  })

  it('draws nothing until the first answer when it has no initial theme, then themes its children', async () => {
    const { bridge, resolve } = createFakeRemote({ [THEME_GET]: 'deferred' })

    render(<ShellThemeProvider bridge={bridge}><Probe /></ShellThemeProvider>)
    expect(screen.queryByTestId('mode')).toBeNull()

    await act(async () => { resolve(THEME_GET, snapshot({ mode: 'dark' })) })

    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
  })

  it('exposes the window state to its children', async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ windowId: 6, theme: 'p.sunrise', mode: 'dark' }, [DEFAULT_THEME, sunrise()])}><Probe /></ShellThemeProvider>)

    expect(screen.getByTestId('state')).toHaveTextContent('p.sunrise/dark/6')
    expect(screen.getByTestId('primary')).toHaveTextContent('#ffaa55')
    await settle()
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

  it('sets the page colours from the theme, as the baseline does', async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ mode: 'dark' })}><Probe /></ShellThemeProvider>)

    expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(18, 18, 18)')
    await settle()
  })

  it('gives plugins the theme and mode as data through @tessera/ui, and nothing that could change them', async () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    let seen: unknown
    const Plugin = () => { seen = usePublicThemeState(); return null }

    render(<ShellThemeProvider bridge={bridge} initial={snapshot({ windowId: 6, theme: 'p.sunrise', mode: 'dark' }, [DEFAULT_THEME, sunrise()])}><Plugin /></ShellThemeProvider>)

    expect(seen).toEqual({ theme: 'p.sunrise', mode: 'dark' })
    await settle()
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
