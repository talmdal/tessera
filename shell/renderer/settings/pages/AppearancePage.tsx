// shell/renderer/settings/pages/AppearancePage.tsx — the Options dialog's Appearance page: the application's theme.
import { useEffect, useId, useMemo, useState } from 'react'
import type { SettingsPageProps, ThemeDescriptor, ThemeModePreference, ThemeSelection } from '@tessera/types'
import { Alert, Box, FormControl, FormLabel, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@tessera/ui'
import { resolveFonts } from '../../../../shared/fonts/resolveFonts'
import { contrastFindings } from '../../../../shared/theme/contrast'
import { followsSystem, modesOf, resolveSelection, selectionFor } from '../../../../shared/theme/selection'
import { DEFAULT_THEME_ID } from '../../../../shared/theme/types'
import { useThemeCatalogue, useWindowTheme } from '../../theme/ShellThemeProvider'
import { ThemeGallery, themeFonts } from '../../theme/ThemeGallery'
import { ThemePreview } from '../../theme/ThemePreview'

const MODES: { mode: ThemeModePreference, label: string }[] = [
  { mode: 'system', label: 'System' }, { mode: 'light', label: 'Light' }, { mode: 'dark', label: 'Dark' }
]

/** Whether a theme can be shown in a mode: `system` needs both variants. A theme that isn't registered can't be asked. */
const offers = (theme: ThemeDescriptor | undefined, mode: ThemeModePreference) =>
  theme === undefined || (mode === 'system' ? followsSystem(theme) : modesOf(theme).includes(mode))

/**
 * The application's theme and mode, the `shell.theme` setting. Choosing here changes the draft only: OK or Apply
 * saves it, and the theme manager then re-themes every window.
 *
 * The mode the user asks for is kept as a wish: a theme without that variant shows what it has, and choosing a theme
 * that has it brings the wish back. The preview draws the shell's own components in the chosen theme.
 */
export function AppearancePage({ value, onChange, disabled }: SettingsPageProps<ThemeSelection>) {
  const headingId = useId()
  const modeId = useId()
  const { themes, systemPrefersDark, fonts: userFonts } = useThemeCatalogue()
  const windowTheme = useWindowTheme()
  const systemDark = systemPrefersDark ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)

  const [wish, setWish] = useState<ThemeModePreference>(value.mode)
  const theme = themes.find(t => t.id === value.theme)
  const selectionWith = (candidate: ThemeDescriptor | undefined, mode: ThemeModePreference): ThemeSelection =>
    candidate ? selectionFor(candidate, mode) : { theme: value.theme, mode }

  // A value set from outside (Restore Defaults, another window) that the wish would not give resets the wish.
  useEffect(() => {
    const current = themes.find(t => t.id === value.theme)
    const wished = current ? selectionFor(current, wish).mode : wish
    if (wished !== value.mode) setWish(value.mode)
  }, [themes, value.theme, value.mode, wish])

  const shown = theme ?? themes.find(t => t.id === DEFAULT_THEME_ID)!
  // The preview shows the theme with its fonts under the user's, as choosing it would
  const fonts = useMemo(() => resolveFonts(userFonts, shown.fonts), [userFonts, shown.fonts])
  const shownFonts = themeFonts(shown)
  const previewMode = resolveSelection(value, themes, systemDark).mode
  const modeOf = (candidate: ThemeDescriptor) => resolveSelection(selectionFor(candidate, wish), themes, systemDark).mode
  const findings = contrastFindings(shown).filter(f => f.mode === previewMode)
  const override = windowTheme.override && (themes.find(t => t.id === windowTheme.override!.theme)?.label ?? windowTheme.override.theme)

  return (
    <Stack spacing={3}>
      {override && (
        <Alert severity="info">
          This window has a theme of its own ({override}). The theme you apply here is used in every window, this one too.
        </Alert>
      )}
      {!theme && (
        <Alert severity="warning">
          The chosen theme, “{value.theme}”, is not available (its plugin may not be installed), so Tessera shows its own.
          Choose another, or keep this choice for when it returns.
        </Alert>
      )}

      <Box>
        <Typography id={headingId} variant="subtitle2" component="h3" sx={{ mb: 1 }}>Theme</Typography>
        <ThemeGallery themes={themes} selected={value.theme} modeOf={modeOf} disabled={disabled} labelledBy={headingId}
          onSelect={id => onChange(selectionWith(themes.find(t => t.id === id), wish))} />
      </Box>

      <FormControl disabled={disabled}>
        <FormLabel id={modeId}>Mode</FormLabel>
        <ToggleButtonGroup exclusive size="small" aria-labelledby={modeId} value={value.mode} disabled={disabled} sx={{ mt: 0.5 }}
          onChange={(_event, mode: ThemeModePreference | null) => {
            if (!mode) return
            setWish(mode)
            onChange(selectionWith(theme, mode))
          }}>
          {MODES.map(({ mode, label }) => (
            <ToggleButton key={mode} value={mode} disabled={disabled || !offers(theme, mode)}>{label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        {value.mode === 'system' && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
            Follows your system, which is set to {systemDark ? 'dark' : 'light'} now.
          </Typography>
        )}
      </FormControl>

      <Stack spacing={1.5}>
        <Typography variant="subtitle2" component="h3">
          Preview <Typography component="span" variant="caption" color="text.secondary">· {shown.label}, {previewMode} mode</Typography>
        </Typography>
        <ThemePreview theme={shown} mode={previewMode} fonts={fonts} />
        {shownFonts && !userFonts.useThemeFonts && (
          <Alert severity="info">
            {shown.label} sets fonts of its own ({shownFonts.replace(/^Sets fonts: /, '')}), but themes' fonts are turned off,
            so they aren't used. Turn them on under Fonts.
          </Alert>
        )}
        {findings.length > 0 && (
          <Alert severity="warning">
            This theme may be hard to read in {previewMode} mode: {findings.map(f => `${f.pair} is ${f.ratio.toFixed(1)}:1 (needs ${f.minimum}:1)`).join('; ')}.
          </Alert>
        )}
      </Stack>
    </Stack>
  )
}
