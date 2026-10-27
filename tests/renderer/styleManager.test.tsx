import type { ThemeState } from '@tessera/types'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { builtinThemeState } from '../../shared/theme/builtin'
import { THEME_CHANGED, THEME_GET } from '../../shared/theme/types'
import { SHELL_TYPOGRAPHY } from '../../shared/theme/typography'
import { ShellStateProvider, useTheme, useThemeColor } from '../../shell/renderer/state/ShellState'
import { StyleManager, applyTheme } from '../../shell/renderer/theme/StyleManager'

/** A bridge whose theme request resolves on demand and whose events are fired by the test. */
function fakeBridge(theme: ThemeState) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  let reply!: (state: ThemeState) => void
  return {
    invoke: vi.fn((channel: string) => {
      if (channel === THEME_GET) return new Promise<ThemeState>(resolve => { reply = resolve })
      if (channel === 'shell:lifecycle.get') return Promise.resolve('started')
      if (channel === 'shell:contextKeys.snapshot') return Promise.resolve({})
      if (channel === 'shell:layout.get') return new Promise(() => {})
      throw new Error(`Unexpected request ${channel}`)
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }),
    emit: (name: string, data?: unknown) => listeners.get(name)?.forEach(l => l(data)),
    replyTheme: () => reply(theme)
  }
}

const root = () => document.documentElement
const variable = (name: string) => root().style.getPropertyValue(name)

const sepia: ThemeState = {
  ...builtinThemeState('light'),
  preference: { theme: 'm.sepia', light: 'shell.light', dark: 'shell.dark' },
  activeTheme: 'm.sepia',
  colors: { ...builtinThemeState('light').colors, 'shell.accent': '#7a5c1e', 'acc.positive': '#3f6b1c' },
  themes: [...builtinThemeState('light').themes, { id: 'm.sepia', label: 'Sepia', kind: 'light', pluginId: 'm' }]
}

function Probe() {
  const { activeTheme, kind } = useTheme()
  return <p>{activeTheme} / {kind} / {String(useThemeColor('shell.accent'))} / {String(useThemeColor('acc.positive'))}</p>
}

afterEach(() => {
  root().removeAttribute('style')
  delete root().dataset.themeId
  delete root().dataset.themeKind
})

describe('StyleManager', () => {
  it('paints the shell light defaults before the snapshot arrives, then the snapshot, then each change', async () => {
    const bridge = fakeBridge(sepia)
    render(
      <ShellStateProvider bridge={bridge as any}>
        <StyleManager><Probe /></StyleManager>
      </ShellStateProvider>
    )

    // First frame: the built-in light theme, from the shared catalogue
    expect(screen.getByText('shell.light / light / #0063b1 / undefined')).toBeInTheDocument()
    expect(variable('--shell-accent')).toBe('#0063b1')
    expect(variable('--shell-bar-hoverBackground')).toBe('#e0e0e0')
    expect(root().dataset).toMatchObject({ themeId: 'shell.light', themeKind: 'light' })
    expect(root().style.colorScheme).toBe('light')

    // The snapshot: the user's theme, with a plugin token
    await act(async () => { bridge.replyTheme() })
    expect(screen.getByText('m.sepia / light / #7a5c1e / #3f6b1c')).toBeInTheDocument()
    expect(variable('--shell-accent')).toBe('#7a5c1e')
    expect(variable('--acc-positive')).toBe('#3f6b1c')
    expect(root().dataset.themeId).toBe('m.sepia')

    // A push event: dark, and the plugin token is gone
    act(() => { bridge.emit(THEME_CHANGED, builtinThemeState('dark')) })
    expect(screen.getByText('shell.dark / dark / #3794ff / undefined')).toBeInTheDocument()
    expect(variable('--shell-accent')).toBe('#3794ff')
    expect(variable('--shell-background')).toBe('#1e1e1e')
    expect(variable('--acc-positive')).toBe('')
    expect(root().dataset).toMatchObject({ themeId: 'shell.dark', themeKind: 'dark' })
    expect(root().style.colorScheme).toBe('dark')
  })

  it('publishes the typography variables beside the colours', () => {
    const bridge = fakeBridge(sepia)
    render(<ShellStateProvider bridge={bridge as any}><StyleManager /></ShellStateProvider>)

    expect(variable('--shell-font-family')).toBe(SHELL_TYPOGRAPHY['shell.font.family'])
    expect(variable('--shell-font-size')).toBe('13px')
    expect(variable('--shell-font-sizeSmall')).toBe('12px')
    expect(variable('--shell-font-monoFamily')).toBe(SHELL_TYPOGRAPHY['shell.font.monoFamily'])
  })

  it('starts from the dark defaults when the system prefers dark', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('dark') } as MediaQueryList))
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia })
    try {
      const bridge = fakeBridge(sepia)
      render(<ShellStateProvider bridge={bridge as any}><StyleManager><Probe /></StyleManager></ShellStateProvider>)

      expect(screen.getByText('shell.dark / dark / #3794ff / undefined')).toBeInTheDocument()
      expect(root().style.colorScheme).toBe('dark')
    } finally {
      Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('renders its children', () => {
    const bridge = fakeBridge(sepia)
    render(<ShellStateProvider bridge={bridge as any}><StyleManager><p>child</p></StyleManager></ShellStateProvider>)
    expect(screen.getByText('child')).toBeInTheDocument()
  })
})

describe('applyTheme', () => {
  it('writes one variable per token and removes the variables of tokens that have gone', () => {
    const element = document.createElement('div')

    applyTheme(element, { activeTheme: 'a', kind: 'light', colors: { 'x.one': '#111', 'x.two': '#222' } })
    expect(element.style.getPropertyValue('--x-one')).toBe('#111')
    expect(element.style.getPropertyValue('--x-two')).toBe('#222')

    applyTheme(element, { activeTheme: 'b', kind: 'dark', colors: { 'x.two': '#333' } })
    expect(element.style.getPropertyValue('--x-one')).toBe('')
    expect(element.style.getPropertyValue('--x-two')).toBe('#333')
    expect(element.style.getPropertyValue('--shell-font-size')).toBe('13px')
    expect(element.dataset).toMatchObject({ themeId: 'b', themeKind: 'dark' })
  })
})
