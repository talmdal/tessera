// shell/main/theme/electronTheme.ts
import type { ThemePort } from '../../../core/ports'

/** The part of Electron's `nativeTheme` this needs. */
export interface NativeThemeLike {
  themeSource: 'system' | 'light' | 'dark'
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/**
 * Adapts `nativeTheme`. Setting its source makes menus, dialogs and the page's
 * `prefers-color-scheme` follow the application's mode.
 *
 * Electron reports the OS setting through `shouldUseDarkColors` only while the
 * source is `system`; once a mode is forced it reports the forced one. So the
 * OS's value is remembered from the last time it could be read. If the OS
 * changes while a mode is forced, that is not seen until the source returns to
 * `system`, which only matters to a window that follows the system while the
 * application's own mode is forced.
 */
export function createElectronThemePort(nativeTheme: NativeThemeLike): ThemePort {
  let systemDark = nativeTheme.shouldUseDarkColors

  const read = () => {
    if (nativeTheme.themeSource === 'system') systemDark = nativeTheme.shouldUseDarkColors
    return systemDark
  }

  return {
    get systemPrefersDark() {
      return read()
    },

    setSource(mode) {
      read()   // before a forced mode hides the OS's value
      nativeTheme.themeSource = mode
      read()
    },

    onSystemChange(listener) {
      const onUpdated = () => {
        if (nativeTheme.themeSource !== 'system') return
        read()
        listener()
      }
      nativeTheme.on('updated', onUpdated)
      return () => { nativeTheme.removeListener('updated', onUpdated) }
    }
  }
}
