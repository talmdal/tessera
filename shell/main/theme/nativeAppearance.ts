// shell/main/theme/nativeAppearance.ts
//
// The SystemAppearance port over Electron's nativeTheme, and the other
// direction: making the native side follow the active theme. Written against
// a small slice of the nativeTheme and BrowserWindow APIs so it can be
// tested with fakes. See docs/style-manager-design.md.
import type { SystemAppearance, ThemeKind, ThemeState } from '@tessera/types'
import { Emitter } from '../../../core/events'
import { SYSTEM_THEME } from '../../../shared/theme/types'

/** What this module uses of Electron's nativeTheme. */
export interface NativeThemeLike {
  shouldUseDarkColors: boolean
  themeSource: 'system' | 'light' | 'dark'
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/** What this module uses of a BrowserWindow. */
export interface WindowLike {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
}

export interface NativeAppearance extends SystemAppearance {
  /**
   * Makes the native side follow a theme state: `themeSource` is 'system'
   * while the preference follows the system (so the OS setting stays
   * readable) and the theme's kind otherwise (so native menus, dialogs and
   * `prefers-color-scheme` match); every window's background colour is the
   * theme's, so a resize or a reload never flashes the wrong colour.
   */
  apply(state: ThemeState, windows: () => WindowLike[]): void
  dispose(): void
}

/** A SystemAppearance pinned to one kind; for tests and for environments without nativeTheme. */
export function fixedAppearance(kind: ThemeKind = 'light'): SystemAppearance {
  return {
    kind: () => kind,
    onDidChange: () => ({ dispose: () => {} })
  }
}

export function createNativeAppearance(nativeTheme: NativeThemeLike): NativeAppearance {
  const changed = new Emitter<ThemeKind>()
  // `shouldUseDarkColors` reports the OS setting only while themeSource is
  // 'system'; while a theme of a fixed kind pins it, the last reading is kept.
  let osKind: ThemeKind = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'

  const read = (): ThemeKind | undefined => {
    if (nativeTheme.themeSource !== 'system') return undefined
    const next: ThemeKind = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    if (next === osKind) return undefined
    osKind = next
    return next
  }

  const onUpdated = () => {
    const next = read()
    if (next) changed.fire(next)
  }
  nativeTheme.on('updated', onUpdated)

  return {
    kind: () => osKind,
    onDidChange: changed.event,
    apply: (state, windows) => {
      const source = state.preference.theme === SYSTEM_THEME ? 'system' : state.kind
      if (nativeTheme.themeSource !== source) {
        nativeTheme.themeSource = source
        // Back on 'system' the OS setting is readable again; if it moved
        // meanwhile, say so, and the service recomputes.
        onUpdated()
      }
      const background = state.colors['shell.background']
      if (background) {
        for (const window of windows()) {
          if (!window.isDestroyed()) window.setBackgroundColor(background)
        }
      }
    },
    dispose: () => nativeTheme.removeListener('updated', onUpdated)
  }
}
