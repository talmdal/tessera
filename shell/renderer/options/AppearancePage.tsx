// shell/renderer/options/AppearancePage.tsx
//
// The options dialog's Appearance page: where the application-wide theme is chosen. It took over from the
// View ▸ Theme chooser dialog, keeping its preview — the page cannot show a candidate theme by switching the
// window to it, since nothing applies before Apply or OK, so the preview is how the user sees it first.
// Per-window overrides stay on the View menu: they are state, not an option.
import { useEffect, useState } from 'react'
import type { OptionsPageProps, ThemeDescriptor, ThemeModePreference, ThemeSnapshot } from '@tessera/types'
import {
  Alert, Box, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, ToggleButton, ToggleButtonGroup,
  Typography
} from '@tessera/ui'
import { contrastFindings } from '../../../shared/theme/contrast'
import { followsSystem, modesOf, resolveSelection, selectionFor } from '../../../shared/theme/selection'
import { tokensFor } from '../../../shared/theme/tokens'
import { THEME_GET } from '../../../shared/theme/types'
import type { ShellOptionsValue } from '../../../shared/options/types'
import { Loading } from '../Loading'
import { ThemePreview } from '../theme/ThemePreview'

const MODES: { mode: ThemeModePreference, label: string }[] = [
  { mode: 'system', label: 'System' }, { mode: 'light', label: 'Light' }, { mode: 'dark', label: 'Dark' }
]

/** What a theme can show, in words, when it is not both. */
const limits = (theme: ThemeDescriptor) => followsSystem(theme) ? undefined : `${modesOf(theme)[0] === 'dark' ? 'Dark' : 'Light'} only`

export function AppearancePage({ value, onChange, disabled }: OptionsPageProps<ShellOptionsValue>) {
  // The registered themes and the platform's setting, fetched as the page opens. The chosen *selection* is the
  // page's draft (`value.appearance`), owned by the dialog like any other option.
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>()
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    window.api.invoke<ThemeSnapshot>(THEME_GET).then(setSnapshot, err => {
      console.error('[options] Could not read the themes', err)
      setFailure(err instanceof Error ? err.message : String(err))
    })
  }, [])

  if (failure !== undefined) return <Alert severity="error">The themes could not be read: {failure}</Alert>
  if (!snapshot) return <Loading>Loading…</Loading>

  const { themes } = snapshot
  const systemDark = snapshot.systemPrefersDark ?? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const selection = value.appearance
  const known = themes.find(t => t.id === selection.theme)
  const theme = known ?? themes[0]
  // What the user wants for the mode. A theme that can't show it shows what it can; picking a theme that can brings it back.
  const wish = selection.mode

  const modeOf = (candidate: ThemeDescriptor) => resolveSelection(selectionFor(candidate, wish), themes, systemDark).mode
  const previewMode = modeOf(theme)
  const findings = contrastFindings(theme).filter(finding => finding.mode === previewMode)

  const choose = (candidate: ThemeDescriptor, mode: ThemeModePreference) =>
    onChange({ ...value, appearance: selectionFor(candidate, mode) })

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(0, 2fr)', gap: 3 }}>
      <Stack spacing={2}>
        {known === undefined && (
          <Alert severity="warning">
            The chosen theme ({selection.theme}) is not available right now — its plugin may be gone. The default
            is shown in its place, and the choice is kept in case it returns.
          </Alert>
        )}

        <FormControl>
          <FormLabel id="appearance-theme-label">Theme</FormLabel>
          <RadioGroup aria-labelledby="appearance-theme-label" value={theme.id}
            onChange={(_event, id) => { const candidate = themes.find(t => t.id === id); if (candidate) choose(candidate, wish) }}>
            {themes.map(candidate => {
              const tokens = tokensFor(candidate, modeOf(candidate))
              return (
                <FormControlLabel key={candidate.id} value={candidate.id} control={<Radio disabled={disabled} />}
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
          <FormLabel id="appearance-mode-label">Mode</FormLabel>
          <ToggleButtonGroup exclusive size="small" aria-labelledby="appearance-mode-label" value={selection.mode}
            onChange={(_event, mode: ThemeModePreference | null) => { if (mode) choose(theme, mode) }}>
            {MODES.map(({ mode, label }) => (
              <ToggleButton key={mode} value={mode}
                disabled={disabled || (mode === 'system' ? !followsSystem(theme) : !modesOf(theme).includes(mode))}>
                {label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </FormControl>
      </Stack>

      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2" component="h4">
          Preview <Typography component="span" variant="caption" color="text.secondary">· {theme.label}, {previewMode} mode{selection.mode === 'system' && followsSystem(theme) ? ' (following the system)' : ''}</Typography>
        </Typography>
        <ThemePreview theme={theme} mode={previewMode} />
        {findings.length > 0 && (
          <Alert severity="warning">
            This theme may be hard to read in {previewMode} mode: {findings.map(finding => `${finding.pair} is ${finding.ratio.toFixed(1)}:1 (needs ${finding.minimum}:1)`).join('; ')}.
          </Alert>
        )}
      </Stack>
    </Box>
  )
}

/** A few colour dots: the background, the paper and the primary colour a theme shows. */
function Swatches({ colours }: { colours: string[] }) {
  return (
    <Box aria-hidden sx={{ display: 'inline-flex', flex: 'none' }}>
      {colours.map((colour, index) => (
        <Box key={index} sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: colour, border: 1, borderColor: 'divider', ml: index === 0 ? 0 : -0.5 }} />
      ))}
    </Box>
  )
}
