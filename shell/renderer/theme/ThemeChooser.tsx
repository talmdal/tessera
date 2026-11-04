// shell/renderer/theme/ThemeChooser.tsx
import { useEffect, useState } from 'react'
import type { TesseraBridge, ThemeDescriptor, ThemeModePreference, ThemeSelection, ThemeSnapshot } from '@tessera/types'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, FormLabel,
  Radio, RadioGroup, Stack, ToggleButton, ToggleButtonGroup, Typography
} from '@tessera/ui'
import { COMMANDS_EXECUTE, ExecuteCommandRequest } from '../../../shared/shellEvents'
import { contrastFindings } from '../../../shared/theme/contrast'
import { followsSystem, modesOf, resolveSelection, selectionFor } from '../../../shared/theme/selection'
import { tokensFor } from '../../../shared/theme/tokens'
import { THEME_CHOOSER_OPEN, THEME_COMMANDS, THEME_GET, ThemeChooserOpen } from '../../../shared/theme/types'
import { ThemePreview } from './ThemePreview'
import { useWindowTheme } from './ShellThemeProvider'

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>
type Scope = 'application' | 'window'

/**
 * Opens the theme chooser in this window when the main process says so (the
 * View ▸ Theme ▸ Choose Theme… command). The current themes are fetched as it
 * opens, so the list and the operating system's setting are fresh.
 */
export function ThemeChooser({ bridge }: { bridge: Bridge }) {
  const { windowId } = useWindowTheme()
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>()

  useEffect(() => bridge.on<ThemeChooserOpen>(THEME_CHOOSER_OPEN, request => {
    if (request.windowId !== windowId) return
    bridge.invoke<ThemeSnapshot>(THEME_GET).then(setSnapshot, err => console.error('[theme] Could not open the theme chooser', err))
  }), [bridge, windowId])

  return snapshot ? <ChooserDialog snapshot={snapshot} bridge={bridge} onClose={() => setSnapshot(undefined)} /> : null
}

const same = (a?: ThemeSelection, b?: ThemeSelection) => a !== undefined && b !== undefined && a.theme === b.theme && a.mode === b.mode

const MODES: { mode: ThemeModePreference, label: string }[] = [
  { mode: 'system', label: 'System' }, { mode: 'light', label: 'Light' }, { mode: 'dark', label: 'Dark' }
]

/** What a theme can show, in words, when it is not both. */
const limits = (theme: ThemeDescriptor) => followsSystem(theme) ? undefined : `${modesOf(theme)[0] === 'dark' ? 'Dark' : 'Light'} only`

function ChooserDialog({ snapshot, bridge, onClose }: { snapshot: ThemeSnapshot, bridge: Bridge, onClose(): void }) {
  const { state, themes } = snapshot
  const systemDark = snapshot.systemPrefersDark ?? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [scope, setScope] = useState<Scope>(state.override ? 'window' : 'application')
  const [themeId, setThemeId] = useState(state.theme)
  // What the user wants for the mode. A theme that can't show it shows what it can; picking a theme that can brings it back.
  const [wish, setWish] = useState<ThemeModePreference>((state.override ?? state.global).mode)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const theme = themes.find(t => t.id === themeId) ?? themes[0]
  const selection = selectionFor(theme, wish)
  const modeOf = (candidate: ThemeDescriptor) => resolveSelection(selectionFor(candidate, wish), themes, systemDark).mode
  const previewMode = modeOf(theme)

  const findings = contrastFindings(theme).filter(f => f.mode === previewMode)
  const unchanged = scope === 'application' ? same(state.global, selection) && !state.override : same(state.override, selection)

  const run = (id: string, args: unknown[] = []) => bridge.invoke(COMMANDS_EXECUTE, { id, args } satisfies ExecuteCommandRequest)

  const apply = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (scope === 'application') {
        await run(THEME_COMMANDS.set, [selection])
        // "Everywhere" means this window too, so a theme of its own would defeat the choice
        if (state.override) await run(THEME_COMMANDS.clearWindowOverride)
      } else {
        await run(THEME_COMMANDS.setForWindow, [selection])
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^HANDLER_ERROR: /, '') : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="md" fullWidth aria-labelledby="theme-chooser-title">
      <DialogTitle id="theme-chooser-title">Choose a theme</DialogTitle>

      <DialogContent dividers>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(0, 2fr)', gap: 3 }}>
          <Stack spacing={2}>
            <FormControl>
              <FormLabel id="theme-list-label">Theme</FormLabel>
              <RadioGroup aria-labelledby="theme-list-label" value={theme.id} onChange={(_event, id) => setThemeId(id)}>
                {themes.map(candidate => {
                  const tokens = tokensFor(candidate, modeOf(candidate))
                  return (
                    <FormControlLabel key={candidate.id} value={candidate.id} control={<Radio />}
                      label={
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Swatches colours={[tokens.background.default, tokens.background.paper, tokens.primary]} />
                          <span>
                            {candidate.label}
                            {limits(candidate) && <Typography component="span" variant="caption" color="text.secondary"> · {limits(candidate)}</Typography>}
                          </span>
                        </Stack>
                      } />
                  )
                })}
              </RadioGroup>
            </FormControl>

            <FormControl>
              <FormLabel id="theme-mode-label">Mode</FormLabel>
              <ToggleButtonGroup exclusive size="small" aria-labelledby="theme-mode-label" value={selection.mode}
                onChange={(_event, mode: ThemeModePreference | null) => { if (mode) setWish(mode) }}>
                {MODES.map(({ mode, label }) => (
                  <ToggleButton key={mode} value={mode}
                    disabled={mode === 'system' ? !followsSystem(theme) : !modesOf(theme).includes(mode)}>
                    {label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </FormControl>

            <FormControl>
              <FormLabel id="theme-scope-label">Use it</FormLabel>
              <RadioGroup aria-labelledby="theme-scope-label" value={scope} onChange={(_event, value) => setScope(value as Scope)}>
                <FormControlLabel value="application" control={<Radio />} label="Everywhere" />
                <FormControlLabel value="window" control={<Radio />} label="In this window only" />
              </RadioGroup>
              {scope === 'application' && state.override && (
                <Typography variant="caption" color="text.secondary">This window has a theme of its own; choosing Everywhere replaces it.</Typography>
              )}
            </FormControl>
          </Stack>

          <Stack spacing={1.5} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" component="h3">
              Preview <Typography component="span" variant="caption" color="text.secondary">· {theme.label}, {previewMode} mode{selection.mode === 'system' ? ' (following the system)' : ''}</Typography>
            </Typography>
            <ThemePreview theme={theme} mode={previewMode} />
            {findings.length > 0 && (
              <Alert severity="warning">
                This theme may be hard to read in {previewMode} mode: {findings.map(f => `${f.pair} is ${f.ratio.toFixed(1)}:1 (needs ${f.minimum}:1)`).join('; ')}.
              </Alert>
            )}
          </Stack>
        </Box>
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={apply} disabled={busy || unchanged}>Apply</Button>
      </DialogActions>
    </Dialog>
  )
}

/** A few colour dots: the background, the paper and the primary colour a theme shows. */
function Swatches({ colours }: { colours: string[] }) {
  return (
    <Box aria-hidden sx={{ display: 'inline-flex', flex: 'none' }}>
      {colours.map((colour, i) => (
        <Box key={i} sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: colour, border: 1, borderColor: 'divider', ml: i === 0 ? 0 : -0.5 }} />
      ))}
    </Box>
  )
}
