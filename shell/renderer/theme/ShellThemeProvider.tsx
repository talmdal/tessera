// shell/renderer/theme/ShellThemeProvider.tsx — provides the one theme every component in the window renders with.
import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Alert, CssBaseline, GlobalStyles, Snackbar, ThemeProvider, useMediaQuery } from '@mui/material'
import type { PaletteMode } from '@mui/material'
import type { ColorScheme, TesseraBridge, ThemeDescriptor, ThemeMode, ThemeSelection } from '@tessera/types'
import {
  SHELL_THEME_ID, THEME_CHANGED, THEME_GET, THEME_PICKER_OPEN, THEME_SET, THEMES_CHANGED, THEMES_LIST, ThemePickerOpen
} from '../../../shared/themes/types'
import { createRemoteState } from '../state/remoteState'
import { BUILT_IN, ResolvedTheme, createThemeResolver } from './resolveTheme'

/** A theme and mode the chooser is trying out, shown in this window only and never saved. */
export interface ThemeCandidate {
  themeId: string
  mode: ThemeMode
}

export interface ShellThemeContextValue {
  /** Every theme the main process accepted, in chooser order. Only the built-in one until the list has arrived. */
  themes: ThemeDescriptor[]
  /** The choice, as the main process holds it. */
  selection: ThemeSelection
  /** The theme in effect: built from the selection, or from the preview while there is one. */
  applied: ResolvedTheme
  /** Builds a theme for the chooser's sample pane, memoised like the applied one. */
  resolve(descriptor: ThemeDescriptor | undefined, scheme: ColorScheme): ResolvedTheme
  /** Renders this window under `candidate` until cleared with `undefined`. Nothing leaves the renderer. */
  preview(candidate?: ThemeCandidate): void
  previewing?: ThemeCandidate
  /** Asks the main process to make `candidate` the choice; it answers with the new selection and pushes it to every window. */
  apply(candidate: ThemeCandidate): Promise<ThemeSelection>
  /** Calls `listener` with the window id when a command asks for the chooser to open; returns a function that stops. */
  onChooserRequested(listener: (windowId: number) => void): () => void
}

const ShellThemeContext = createContext<ShellThemeContextValue | null>(null)

/** The layout frame fills the window exactly and scrolls its own regions, so the page itself never scrolls. */
const pageStyles = { 'html, body, #root': { height: '100%', overflow: 'hidden' } }

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>

/**
 * Wraps the window in MUI's ThemeProvider with the shell's theme, and applies
 * CssBaseline in place of the old inline CSS. Plugin views get the same theme
 * through the shared `@mui/material`, so they never provide their own.
 *
 * With a `bridge` the theme follows the main process: the list of contributed
 * themes and the user's choice, as a snapshot and then push events. Without one
 * (tests, and the fixture plugin) it is the built-in theme in `mode`, or in the
 * mode the system prefers, which Electron derives from `nativeTheme`.
 */
export function ShellThemeProvider({ bridge, mode, children }: { bridge?: Bridge, mode?: PaletteMode, children: ReactNode }) {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const systemScheme: ColorScheme = mode ?? (prefersDark ? 'dark' : 'light')

  const themes = useRemoteThemes(bridge)
  const selection = useRemoteSelection(bridge, systemScheme)
  const [previewing, setPreviewing] = useState<ThemeCandidate>()
  const preview = useCallback((candidate?: ThemeCandidate) => setPreviewing(candidate), [])

  const apply = useCallback(async (candidate: ThemeCandidate) => {
    if (!bridge) throw new Error('There is no main process to apply the theme')
    return bridge.invoke<ThemeSelection, ThemeCandidate>(THEME_SET, candidate)
  }, [bridge])
  const onChooserRequested = useCallback((listener: (windowId: number) => void) =>
    bridge ? bridge.on<ThemePickerOpen>(THEME_PICKER_OPEN, ({ windowId }) => listener(windowId)) : () => {}, [bridge])

  const resolve = useMemo(() => createThemeResolver(), [])
  const applied = useMemo(() => {
    const themeId = previewing?.themeId ?? selection.effectiveThemeId
    const chosenMode = previewing?.mode ?? selection.mode
    const scheme = chosenMode === 'system' ? selection.resolvedMode : chosenMode
    return resolve(themes.find(theme => theme.id === themeId) ?? (themeId === SHELL_THEME_ID ? BUILT_IN : undefined), scheme)
  }, [themes, selection, previewing, resolve])

  // A theme that could not be used is reported once, and whenever the problem changes.
  const [dismissed, setDismissed] = useState<string>()
  useEffect(() => { if (applied.problem) console.error(`[themes] ${applied.problem}`) }, [applied.problem])

  const value = useMemo<ShellThemeContextValue>(
    () => ({ themes, selection, applied, resolve, preview, previewing, apply, onChooserRequested }),
    [themes, selection, applied, resolve, preview, previewing, apply, onChooserRequested])

  return (
    <ShellThemeContext.Provider value={value}>
      <ThemeProvider theme={applied.theme}>
        <CssBaseline enableColorScheme />
        <GlobalStyles styles={pageStyles} />
        {children}
        <Snackbar open={applied.problem !== undefined && applied.problem !== dismissed} onClose={() => setDismissed(applied.problem)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
          <Alert severity="warning" variant="filled" onClose={() => setDismissed(applied.problem)}>
            {applied.problem} Using the built-in theme instead.
          </Alert>
        </Snackbar>
      </ThemeProvider>
    </ShellThemeContext.Provider>
  )
}

/** The themes, the choice, and preview, for the chooser. */
export function useShellTheme(): ShellThemeContextValue {
  const value = useContext(ShellThemeContext)
  if (!value) throw new Error('useShellTheme must be used inside <ShellThemeProvider>')
  return value
}

/** The list of themes: fetched once, and again whenever the main process says it changed. */
function useRemoteThemes(bridge?: Bridge): ThemeDescriptor[] {
  const [themes, setThemes] = useState<ThemeDescriptor[]>([BUILT_IN])

  useEffect(() => {
    if (!bridge) return
    let live = true
    let latest = 0

    // Only the most recent request may set the list, so a slow early reply can't overwrite a newer one.
    const load = () => {
      const request = ++latest
      bridge.invoke<ThemeDescriptor[]>(THEMES_LIST).then(
        list => { if (live && request === latest) setThemes(list) },
        err => console.error('[themes] Failed to list themes', err))
    }

    load()
    const stop = bridge.on(THEMES_CHANGED, load)
    return () => {
      live = false
      stop()
    }
  }, [bridge])

  return themes
}

/** The choice, mirrored from the main process; until it has answered, the built-in theme in the system's scheme. */
function useRemoteSelection(bridge: Bridge | undefined, systemScheme: ColorScheme): ThemeSelection {
  const [remote] = useState(() => bridge && createRemoteState<ThemeSelection, ThemeSelection>(bridge, {
    initial: { themeId: SHELL_THEME_ID, mode: 'system', resolvedMode: systemScheme, effectiveThemeId: SHELL_THEME_ID },
    load: THEME_GET,
    event: THEME_CHANGED,
    apply: (_current, next) => next
  }))
  const local = useMemo<ThemeSelection>(
    () => ({ themeId: SHELL_THEME_ID, mode: 'system', resolvedMode: systemScheme, effectiveThemeId: SHELL_THEME_ID }), [systemScheme])

  const snapshot = useSyncExternalStore(remote?.subscribe ?? noSubscription, remote?.getSnapshot ?? (() => local))
  return remote ? snapshot : local
}

const noSubscription = () => () => {}
