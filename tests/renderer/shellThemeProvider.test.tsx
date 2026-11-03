import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useTheme } from '@mui/material'
import type { ThemeDescriptor, ThemeSelection } from '@tessera/types'
import { SHELL_THEME, THEME_CHANGED, THEME_GET, THEMES_CHANGED, THEMES_LIST } from '../../shared/themes/types'
import { ShellThemeProvider, useShellTheme } from '../../shell/renderer/theme/ShellThemeProvider'

const shell: ThemeDescriptor = { ...SHELL_THEME, pluginId: 'shell', schemes: ['light', 'dark'] }
const pumpkin: ThemeDescriptor = {
  id: 'p.pumpkin', label: 'Pumpkin', pluginId: 'p', schemes: ['dark'],
  dark: { palette: { primary: { main: '#ff7518' } } }
}
const broken: ThemeDescriptor = { id: 'p.broken', label: 'Broken', pluginId: 'p', schemes: ['light'], light: { palette: { primary: { main: 'nope' } } } }

const selection = (extra: Partial<ThemeSelection> = {}): ThemeSelection =>
  ({ themeId: 'shell.default', mode: 'system', resolvedMode: 'light', effectiveThemeId: 'shell.default', ...extra })

/** A bridge answering the theme requests, whose answers and events a test controls. */
function fakeBridge(themes: ThemeDescriptor[], current: ThemeSelection) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const bridge = {
    themes,
    current,
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      if (channel === THEMES_LIST) return bridge.themes
      if (channel === THEME_GET) return bridge.current
      return undefined
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }),
    emit: (name: string, data?: unknown) => act(async () => { listeners.get(name)?.forEach(l => l(data)) })
  }
  return bridge
}

function Probe() {
  const theme = useTheme()
  const shellTheme = useShellTheme()
  return (
    <>
      <p>mode {theme.palette.mode}</p>
      <p>primary {theme.palette.primary.main}</p>
      <p>applied {shellTheme.applied.themeId}</p>
      <p>themes {shellTheme.themes.map(t => t.id).join(',')}</p>
      <button onClick={() => shellTheme.preview({ themeId: 'p.pumpkin', mode: 'dark' })}>preview</button>
      <button onClick={() => shellTheme.preview(undefined)}>stop</button>
    </>
  )
}

describe('ShellThemeProvider with the main process', () => {
  it('applies the snapshot of the choice and lists the themes', async () => {
    const bridge = fakeBridge([shell, pumpkin], selection({ themeId: 'p.pumpkin', effectiveThemeId: 'p.pumpkin', resolvedMode: 'dark' }))
    render(<ShellThemeProvider bridge={bridge as any}><Probe /></ShellThemeProvider>)

    expect(await screen.findByText('applied p.pumpkin')).toBeInTheDocument()
    expect(screen.getByText('mode dark')).toBeInTheDocument()
    expect(screen.getByText('primary #ff7518')).toBeInTheDocument()
    expect(screen.getByText('themes shell.default,p.pumpkin')).toBeInTheDocument()
    expect(bridge.invoke).toHaveBeenCalledWith(THEMES_LIST)
    expect(bridge.invoke).toHaveBeenCalledWith(THEME_GET)
  })

  it('follows a change of the choice and a change of the list', async () => {
    const bridge = fakeBridge([shell], selection())
    render(<ShellThemeProvider bridge={bridge as any}><Probe /></ShellThemeProvider>)
    expect(await screen.findByText('applied shell.default')).toBeInTheDocument()
    expect(screen.getByText('mode light')).toBeInTheDocument()

    await bridge.emit(THEME_CHANGED, selection({ mode: 'dark', resolvedMode: 'dark' }))
    expect(screen.getByText('mode dark')).toBeInTheDocument()

    // The chosen theme arrives later (its plugin activated): the list changes, then the selection says it is in effect.
    bridge.themes = [shell, pumpkin]
    await bridge.emit(THEMES_CHANGED)
    await bridge.emit(THEME_CHANGED, selection({ themeId: 'p.pumpkin', effectiveThemeId: 'p.pumpkin', mode: 'dark', resolvedMode: 'dark' }))
    expect(await screen.findByText('primary #ff7518')).toBeInTheDocument()
  })

  it('previews a candidate in this window only, without asking the main process, until cleared', async () => {
    const user = userEvent.setup()
    const bridge = fakeBridge([shell, pumpkin], selection())
    render(<ShellThemeProvider bridge={bridge as any}><Probe /></ShellThemeProvider>)
    await screen.findByText('applied shell.default')
    const calls = bridge.invoke.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'preview' }))
    expect(screen.getByText('applied p.pumpkin')).toBeInTheDocument()
    expect(screen.getByText('mode dark')).toBeInTheDocument()
    expect(bridge.invoke.mock.calls.length).toBe(calls)          // nothing sent

    await user.click(screen.getByRole('button', { name: 'stop' }))
    expect(screen.getByText('applied shell.default')).toBeInTheDocument()
    expect(screen.getByText('mode light')).toBeInTheDocument()
  })

  it('falls back to the built-in theme when the effective one cannot be built, and says so once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = fakeBridge([shell, broken], selection({ themeId: 'p.broken', effectiveThemeId: 'p.broken' }))
    render(<ShellThemeProvider bridge={bridge as any}><Probe /></ShellThemeProvider>)

    expect(await screen.findByText('applied shell.default')).toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Theme "Broken" \(p\) could not be used/)
    expect(alert).toHaveTextContent(/Using the built-in theme instead/)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[themes] Theme "Broken"'))

    await userEvent.setup().click(screen.getByRole('button', { name: /close/i }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('uses the built-in theme in the system\'s scheme while the main process has not answered, and without a bridge', async () => {
    const bridge = fakeBridge([shell], selection())
    bridge.invoke.mockImplementation(() => new Promise(() => {}))    // never answers
    render(<ShellThemeProvider bridge={bridge as any}><Probe /></ShellThemeProvider>)
    expect(screen.getByText('applied shell.default')).toBeInTheDocument()
    expect(screen.getByText('mode light')).toBeInTheDocument()   // jsdom has no matchMedia: light

    render(<ShellThemeProvider mode="dark"><Probe /></ShellThemeProvider>)
    expect(screen.getByText('mode dark')).toBeInTheDocument()
  })
})
