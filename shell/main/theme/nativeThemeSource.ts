// shell/main/theme/nativeThemeSource.ts
import { nativeTheme } from 'electron'
import type { ColorScheme, ThemeMode } from '@tessera/types'
import type { SystemModeSource } from '../../../core/theme/ThemeService'

/** Electron's nativeTheme as the theme service's system source. */
export function nativeThemeSource(): SystemModeSource {
  return {
    isDark: () => nativeTheme.shouldUseDarkColors,
    onDidChange: listener => {
      nativeTheme.on('updated', listener)
      return { dispose: () => { nativeTheme.off('updated', listener) } }
    }
  }
}

/**
 * Makes the native parts of the window (the menu bar, dialogs, the title bar)
 * follow the application's mode. With `system` Electron follows the OS itself;
 * otherwise it is told the mode, which also drives `prefers-color-scheme` in
 * the renderer, so the first frame is already the right mode.
 */
export function applyNativeMode(mode: ThemeMode, resolved: ColorScheme) {
  nativeTheme.themeSource = mode === 'system' ? 'system' : resolved
}
