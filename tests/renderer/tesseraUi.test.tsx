// A plugin view built against @tessera/ui renders with the shell's theme: the shell provides the one
// instance of the facade (and so of MUI, Emotion and the icon registry) to the plugin's remote as a
// federation singleton, so the plugin's components see the shell's providers.
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, inject, vi } from 'vitest'
import type { RegisteredIcon, ThemeDescriptor, ThemeSnapshot } from '@tessera/types'
import { THEME_CHANGED, THEME_GET, DEFAULT_THEME } from '../../shared/theme/types'
import { resetIconSources } from '../../tessera-ui/iconSource'
import { IconRegistryProvider } from '../../tessera-ui/internal'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFakeRemote } from '../helpers/fakeBridge'

const red: ThemeDescriptor = { id: 'p.red', label: 'Red', light: { primary: '#ff0000' }, dark: { primary: '#aa0000' } }
const green: ThemeDescriptor = { id: 'p.green', label: 'Green', light: { primary: '#00ff00' } }

const snapshot = (theme: ThemeDescriptor, mode: 'light' | 'dark'): ThemeSnapshot => ({
  state: { windowId: 1, global: { theme: theme.id, mode }, theme: theme.id, mode },
  themes: [DEFAULT_THEME, red, green]
})

describe('a plugin view using @tessera/ui', () => {
  // Built once by tests/setup/buildUiFixture.ts
  const remoteEntry = inject('themedRemoteEntry')

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:logo')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    resetIconSources()
    vi.unstubAllGlobals()
  })

  const load = () => createFederationViewLoader().load({
    id: 'themed.view', title: 'Themed', slot: 'shell.main', module: './ThemedView', pluginId: 'themed', remoteEntry
  })

  it("sees the shell's theme, in its palette and as data", async () => {
    const ThemedView = await load()
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot(red, 'dark') })

    render(<ShellThemeProvider bridge={bridge} initial={snapshot(red, 'dark')}><ThemedView /></ShellThemeProvider>)

    expect(screen.getByTestId('primary')).toHaveTextContent('#aa0000')
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(screen.getByRole('button', { name: 'Press' })).toBeInTheDocument()
    expect(screen.getByText('Themed view')).toBeInTheDocument()
  })

  it('follows a theme change without reloading the plugin', async () => {
    const ThemedView = await load()
    const { bridge, emit } = createFakeRemote({ [THEME_GET]: () => snapshot(red, 'light') })
    render(<ShellThemeProvider bridge={bridge} initial={snapshot(red, 'light')}><ThemedView /></ShellThemeProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled())
    expect(screen.getByTestId('primary')).toHaveTextContent('#ff0000')

    act(() => emit(THEME_CHANGED, snapshot(green, 'light')))

    expect(screen.getByTestId('primary')).toHaveTextContent('#00ff00')
    expect(screen.getByTestId('mode')).toHaveTextContent('light')
  })

  it('draws a standard icon, and an icon its own plugin registered, with the shell\'s registry', async () => {
    const ThemedView = await load()
    const fetchMock = vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot(red, 'light') })
    const logo: RegisteredIcon = { id: 'themed.logo', url: 'tessera-plugin://themed/logo.svg', pluginId: 'themed' }

    const { container } = render(
      <ShellThemeProvider bridge={bridge} initial={snapshot(red, 'light')}>
        <IconRegistryProvider icons={[logo]}><ThemedView /></IconRegistryProvider>
      </ShellThemeProvider>)

    // The Save icon is the shell's component; the plugin's own is fetched, from the registry the plugin cannot see
    expect(container.querySelector('svg[data-icon="Save"]')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('tessera-plugin://themed/logo.svg'))
  })

  it('does not bundle its own icons, or MUI', async () => {
    // The plugin build is covered by buildUiPlugins.test.ts; here, that the view works from the shell's copy alone
    const ThemedView = await load()
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot(red, 'light') })

    const { container } = render(<ShellThemeProvider bridge={bridge} initial={snapshot(red, 'light')}><ThemedView /></ShellThemeProvider>)

    expect(container.querySelector('.MuiButton-root')).toBeInTheDocument()
  })
})
