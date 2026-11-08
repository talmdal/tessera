// shell/renderer/theme/ShellThemeProvider.tsx
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material'
import { ReactNode, createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { TesseraBridge, ThemeDescriptor, ThemeSnapshot, ThemeState } from '@tessera/types'
import { themeOf } from '../../../shared/theme/tokens'
import { THEME_CHANGED, THEME_GET } from '../../../shared/theme/types'
import { ThemeStateContext } from '../../../tessera-ui/internal'
import { createRemoteState } from '../state/remoteState'
import { createShellTheme } from './createShellTheme'

/**
 * This window's full theme state: which theme, light or dark, and whether it is overridden here. (Plugins get
 * the narrower `useThemeState` from `@tessera/ui`, which reads the same context.)
 */
export function useWindowTheme(): ThemeState {
  const state = useContext(ThemeStateContext)
  if (!state) throw new Error('This hook must be used inside <ShellThemeProvider>')
  return state
}

/** Every registered theme, and whether the system wants dark colours: what is needed to choose a theme. */
export interface ThemeCatalogue {
  themes: ThemeDescriptor[]
  /** Undefined when the main process could not say; the renderer's own media query is then the best guess. */
  systemPrefersDark?: boolean
}

const ThemeCatalogueContext = createContext<ThemeCatalogue | null>(null)

/** The registered themes, kept current as plugins contribute them (the Appearance page lists them). */
export function useThemeCatalogue(): ThemeCatalogue {
  const catalogue = useContext(ThemeCatalogueContext)
  if (!catalogue) throw new Error('This hook must be used inside <ShellThemeProvider>')
  return catalogue
}

/**
 * Applies this window's theme to everything below it: a MUI theme for its
 * theme and mode, and a baseline (page colours, and the `color-scheme` that
 * styles native controls and scrollbars).
 *
 * The main process decides the theme. `initial` is what it already knew when
 * the page was created, so the first render is already themed; the current
 * value is fetched anyway, and changes follow as events. Events for other
 * windows are ignored. With no `initial` nothing is drawn until the first
 * answer arrives, rather than drawing in the wrong colours and correcting.
 */
export function ShellThemeProvider({ bridge, initial, children }: {
  bridge: Pick<TesseraBridge, 'invoke' | 'on'>
  initial?: ThemeSnapshot
  children: ReactNode
}) {
  const [remote] = useState(() => createRemoteState<ThemeSnapshot | undefined, ThemeSnapshot>(bridge, {
    initial,
    load: THEME_GET,
    event: THEME_CHANGED,
    apply: (current, next) => current === undefined || next.state.windowId === current.state.windowId ? next : current
  }))
  const snapshot = useSyncExternalStore(remote.subscribe, remote.getSnapshot)

  // Follows the system's "show animations" setting, live
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const descriptor = snapshot && themeOf(snapshot.state, snapshot.themes)
  // Rebuilt only when what it is built from changes, so unrelated re-renders keep the same theme object.
  const key = snapshot && JSON.stringify([descriptor, snapshot.state.mode, reducedMotion])
  const muiTheme = useMemo(() => snapshot && descriptor && createShellTheme(descriptor, snapshot.state.mode, { reducedMotion }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key])

  const themes = snapshot?.themes
  const systemPrefersDark = snapshot?.systemPrefersDark
  const catalogue = useMemo(() => themes && { themes, systemPrefersDark }, [themes, systemPrefersDark])

  if (!snapshot || !muiTheme || !catalogue) return null

  return (
    <ThemeStateContext.Provider value={snapshot.state}>
      <ThemeCatalogueContext.Provider value={catalogue}>
        <ThemeProvider theme={muiTheme}>
          <CssBaseline enableColorScheme />
          {children}
        </ThemeProvider>
      </ThemeCatalogueContext.Provider>
    </ThemeStateContext.Provider>
  )
}
