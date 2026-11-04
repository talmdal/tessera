// Reduced motion follows the system setting, live; forced colours (high contrast) keep controls visible.
import { act, render, screen } from '@testing-library/react'
import { useTheme } from '@mui/material'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THEME, THEME_GET } from '../../shared/theme/types'
import { createShellTheme } from '../../shell/renderer/theme/createShellTheme'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { Splitter } from '../../shell/renderer/layout/Splitter'
import { createFakeRemote } from '../helpers/fakeBridge'

const snapshot = () => ({
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'system' as const }, theme: DEFAULT_THEME.id, mode: 'light' as const },
  themes: [DEFAULT_THEME]
})

/** A matchMedia whose answer the test can change, as the OS setting would. */
function fakeMatchMedia(initial: Record<string, boolean>) {
  const state = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  window.matchMedia = ((query: string) => ({
    get matches() { return state[query] ?? false },
    media: query,
    addEventListener: (_: string, l: () => void) => { (listeners.get(query) ?? listeners.set(query, new Set()).get(query)!).add(l) },
    removeEventListener: (_: string, l: () => void) => { listeners.get(query)?.delete(l) },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null
  })) as never
  return { set: (query: string, value: boolean) => act(() => { state[query] = value; listeners.get(query)?.forEach(l => l()) }) }
}

const REDUCE = '(prefers-reduced-motion: reduce)'

describe('createShellTheme: reduced motion', () => {
  it('animates by default', () => {
    const theme = createShellTheme(DEFAULT_THEME, 'light')

    expect(theme.transitions.create('opacity')).toMatch(/\d+ms/)
    expect(theme.components?.MuiButtonBase).toBeUndefined()
  })

  it('has no transitions and no ripple when less motion was asked for', () => {
    const theme = createShellTheme(DEFAULT_THEME, 'light', { reducedMotion: true })

    expect(theme.transitions.create('opacity')).toBe('none')
    expect(theme.transitions.create(['opacity', 'color'], { duration: 500 })).toBe('none')
    expect(theme.components?.MuiButtonBase?.defaultProps).toMatchObject({ disableRipple: true })
  })

  it('changes only the motion: the colours and sizes are the same', () => {
    const calm = createShellTheme(DEFAULT_THEME, 'dark', { reducedMotion: true })
    const normal = createShellTheme(DEFAULT_THEME, 'dark')

    expect(calm.palette.primary.main).toBe(normal.palette.primary.main)
    expect(calm.typography.fontSize).toBe(normal.typography.fontSize)
    expect(calm.components?.MuiButton?.defaultProps).toEqual(normal.components?.MuiButton?.defaultProps)
  })
})

describe('createShellTheme: forced colours', () => {
  it('keeps the selected tab\'s underline in the system highlight colour, where the system replaces backgrounds', () => {
    const indicator = createShellTheme(DEFAULT_THEME, 'light').components?.MuiTabs?.styleOverrides?.indicator as Record<string, any>

    expect(indicator['@media (forced-colors: active)']).toEqual({ forcedColorAdjust: 'none', backgroundColor: 'Highlight' })
  })
})

describe('ShellThemeProvider: reduced motion', () => {
  afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia })

  function Probe() {
    const theme = useTheme()
    return <span data-testid="t">{theme.transitions.create('opacity')}</span>
  }
  const renderProvider = () => {
    const { bridge } = createFakeRemote({ [THEME_GET]: () => snapshot() })
    return render(<ShellThemeProvider bridge={bridge} initial={snapshot()}><Probe /></ShellThemeProvider>)
  }

  it('is not reduced where the system says nothing, such as a browser without matchMedia', () => {
    renderProvider()

    expect(screen.getByTestId('t').textContent).toMatch(/\d+ms/)
  })

  it('has no transitions when the system asked for less motion', () => {
    fakeMatchMedia({ [REDUCE]: true })

    renderProvider()

    expect(screen.getByTestId('t')).toHaveTextContent('none')
  })

  it('follows the setting while the app runs, in both directions', () => {
    const media = fakeMatchMedia({ [REDUCE]: false })
    renderProvider()
    expect(screen.getByTestId('t').textContent).toMatch(/\d+ms/)

    media.set(REDUCE, true)
    expect(screen.getByTestId('t')).toHaveTextContent('none')

    media.set(REDUCE, false)
    expect(screen.getByTestId('t').textContent).toMatch(/\d+ms/)
  })
})

describe('Splitter: forced colours and motion', () => {
  const cssText = () => [...document.querySelectorAll('style')].map(s => s.textContent).join('\n')

  it('uses the system highlight for its handle in forced-colors mode, so it can still be found', () => {
    render(<Splitter side="left" size={260} onDrag={() => {}} onCommit={() => {}} />)

    expect(cssText()).toMatch(/@media \(forced-colors: active\)/)
    expect(cssText()).toMatch(/background-color:\s*Highlight/i)
  })

  it('draws its hover colour from the theme, and eases it with the theme\'s transitions', () => {
    render(<Splitter side="left" size={260} onDrag={() => {}} onCommit={() => {}} />)

    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(cssText()).toMatch(/transition:\s*background-color/)
  })
})
