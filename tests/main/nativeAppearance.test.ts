import type { ThemeState } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { builtinThemeState } from '../../shared/theme/builtin'
import { NativeThemeLike, createNativeAppearance } from '../../shell/main/theme/nativeAppearance'

/** A nativeTheme whose OS setting the test flips. `shouldUseDarkColors` follows themeSource, as Electron's does. */
function fakeNativeTheme(osDark = false) {
  const listeners = new Set<() => void>()
  const theme = {
    osDark,
    themeSource: 'system' as NativeThemeLike['themeSource'],
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
    },
    on: vi.fn((_: 'updated', listener: () => void) => { listeners.add(listener) }),
    removeListener: vi.fn((_: 'updated', listener: () => void) => { listeners.delete(listener) }),
    /** The OS switches; Electron only reports it while themeSource is 'system'. */
    setOs(dark: boolean) {
      this.osDark = dark
      if (this.themeSource === 'system') listeners.forEach(l => l())
    }
  }
  return theme
}

const fixed = (kind: 'light' | 'dark', theme = `shell.${kind}`): ThemeState =>
  ({ ...builtinThemeState(kind), preference: { theme, light: 'shell.light', dark: 'shell.dark' } })

describe('createNativeAppearance', () => {
  it('reports the OS kind and follows its changes', () => {
    const native = fakeNativeTheme(true)
    const appearance = createNativeAppearance(native)
    const changed = vi.fn()
    appearance.onDidChange(changed)

    expect(appearance.kind()).toBe('dark')
    native.setOs(false)
    expect(appearance.kind()).toBe('light')
    expect(changed).toHaveBeenCalledWith('light')

    native.setOs(false)                                    // no change: silent
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('pins themeSource to a fixed theme kind and paints the windows', () => {
    const native = fakeNativeTheme()
    const appearance = createNativeAppearance(native)
    const live = { isDestroyed: () => false, setBackgroundColor: vi.fn() }
    const gone = { isDestroyed: () => true, setBackgroundColor: vi.fn() }

    appearance.apply(fixed('dark'), () => [live, gone])

    expect(native.themeSource).toBe('dark')
    expect(live.setBackgroundColor).toHaveBeenCalledWith('#1e1e1e')
    expect(gone.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('keeps themeSource on system while following it, and notices an OS change made while pinned', () => {
    const native = fakeNativeTheme(false)
    const appearance = createNativeAppearance(native)
    const changed = vi.fn()
    appearance.onDidChange(changed)

    appearance.apply(builtinThemeState('light'), () => [])   // preference: system
    expect(native.themeSource).toBe('system')

    appearance.apply(fixed('dark'), () => [])               // the user pins dark
    native.setOs(true)                                      // the OS goes dark meanwhile; Electron says nothing
    expect(appearance.kind()).toBe('light')                 // the last reading, by design
    expect(changed).not.toHaveBeenCalled()

    appearance.apply(builtinThemeState('light'), () => [])  // back to following the system
    expect(native.themeSource).toBe('system')
    expect(appearance.kind()).toBe('dark')                  // re-read at once, and announced
    expect(changed).toHaveBeenCalledWith('dark')
  })

  it('stops listening when disposed', () => {
    const native = fakeNativeTheme()
    const appearance = createNativeAppearance(native)
    const changed = vi.fn()
    appearance.onDidChange(changed)

    appearance.dispose()
    native.setOs(true)

    expect(native.removeListener).toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })
})
