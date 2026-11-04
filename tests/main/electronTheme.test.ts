import { describe, expect, it, vi } from 'vitest'
import { NativeThemeLike, createElectronThemePort } from '../../shell/main/theme/electronTheme'

/**
 * A stand-in for Electron's nativeTheme that behaves like it: `shouldUseDarkColors`
 * is the OS value while the source is `system`, and the forced value otherwise.
 */
function fakeNativeTheme(osDark = false) {
  const listeners = new Set<() => void>()
  const native = {
    os: osDark,
    source: 'system' as NativeThemeLike['themeSource'],
    get themeSource() { return this.source },
    set themeSource(value: NativeThemeLike['themeSource']) { this.source = value; listeners.forEach(l => l()) },
    get shouldUseDarkColors() { return this.source === 'system' ? this.os : this.source === 'dark' },
    on: vi.fn((_event: 'updated', l: () => void) => { listeners.add(l) }),
    removeListener: vi.fn((_event: 'updated', l: () => void) => { listeners.delete(l) }),
    /** The user flips the OS setting. */
    flipOs(dark: boolean) { this.os = dark; listeners.forEach(l => l()) }
  }
  return native
}

describe('createElectronThemePort', () => {
  it('reads the OS setting', () => {
    expect(createElectronThemePort(fakeNativeTheme(true)).systemPrefersDark).toBe(true)
    expect(createElectronThemePort(fakeNativeTheme(false)).systemPrefersDark).toBe(false)
  })

  it('sets the native theme source', () => {
    const native = fakeNativeTheme()
    const port = createElectronThemePort(native)

    port.setSource('dark')
    expect(native.themeSource).toBe('dark')
    port.setSource('system')
    expect(native.themeSource).toBe('system')
  })

  it('still reports the OS setting, not the forced one, while a mode is forced', () => {
    const native = fakeNativeTheme(false)
    const port = createElectronThemePort(native)

    port.setSource('dark')

    expect(native.shouldUseDarkColors).toBe(true)
    expect(port.systemPrefersDark).toBe(false)
  })

  it('picks up an OS change that happened while forced once it follows the system again', () => {
    const native = fakeNativeTheme(false)
    const port = createElectronThemePort(native)
    port.setSource('light')
    native.os = true   // unobservable while forced

    port.setSource('system')

    expect(port.systemPrefersDark).toBe(true)
  })

  it('tells listeners about an OS change while following the system', () => {
    const native = fakeNativeTheme(false)
    const port = createElectronThemePort(native)
    const listener = vi.fn()
    port.onSystemChange(listener)

    native.flipOs(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(port.systemPrefersDark).toBe(true)
  })

  it('does not report its own changes of source as OS changes', () => {
    const native = fakeNativeTheme()
    const port = createElectronThemePort(native)
    const listener = vi.fn()
    port.onSystemChange(listener)

    port.setSource('dark')

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops listening when unsubscribed', () => {
    const native = fakeNativeTheme()
    const port = createElectronThemePort(native)
    const listener = vi.fn()

    port.onSystemChange(listener)()
    native.flipOs(true)

    expect(listener).not.toHaveBeenCalled()
    expect(native.removeListener).toHaveBeenCalledTimes(1)
  })
})
