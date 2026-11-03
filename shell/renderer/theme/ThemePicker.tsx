// shell/renderer/theme/ThemePicker.tsx — the theme chooser: pick a theme and a mode, see it, then apply it.
import { KeyboardEvent, useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, List, ListItemButton, ListItemText,
  ListSubheader, Stack, Switch, ToggleButton, ToggleButtonGroup, Typography
} from '@mui/material'
import type { ColorScheme, ThemeDescriptor, ThemeMode } from '@tessera/types'
import { Icon } from '@tessera/ui'
import { SHELL_THEME_ID } from '../../../shared/themes/types'
import { ShellThemeContextValue, ThemeCandidate, useShellTheme } from './ShellThemeProvider'
import { ThemeSample } from './ThemeSample'

const MODE_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/**
 * A dialog listing every theme, with a mode switch, a preview pane showing a
 * sample of the application under the highlighted theme, and a switch to
 * preview it on the whole window. Nothing reaches the main process until
 * Apply; Cancel, Escape or closing discards the candidate, and any preview
 * ends when the dialog does.
 */
export function ThemePicker({ open, onClose }: { open: boolean, onClose(): void }) {
  const shellTheme = useShellTheme()
  const { themes, selection, resolve, preview, apply } = shellTheme

  const [candidate, setCandidate] = useState<ThemeCandidate>({ themeId: selection.themeId, mode: selection.mode })
  const [previewWindow, setPreviewWindow] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string>()

  // Opening starts from the current choice; a theme that disappears while highlighted falls back to it too.
  useEffect(() => {
    if (!open) return
    setCandidate({ themeId: selection.themeId, mode: selection.mode })
    setPreviewWindow(false)
    setError(undefined)
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && !themes.some(theme => theme.id === candidate.themeId)) setCandidate(current => ({ ...current, themeId: selection.themeId }))
  }, [open, themes, candidate.themeId, selection.themeId])

  // The whole-window preview follows the candidate while it is on, and ends with the dialog, whatever closed it.
  useEffect(() => {
    preview(open && previewWindow ? candidate : undefined)
  }, [open, previewWindow, candidate, preview])
  useEffect(() => () => preview(undefined), [preview])

  const scheme: ColorScheme = candidate.mode === 'system' ? selection.resolvedMode : candidate.mode
  const highlighted = themes.find(theme => theme.id === candidate.themeId)
  const sample = resolve(highlighted, scheme)
  const groups = useMemo(() => groupByPlugin(themes), [themes])
  const unchanged = candidate.themeId === selection.themeId && candidate.mode === selection.mode

  const choose = (themeId: string) => setCandidate(current => ({ ...current, themeId }))
  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = themes.findIndex(theme => theme.id === candidate.themeId)
    const next = themes[(index + (event.key === 'ArrowDown' ? 1 : -1) + themes.length) % themes.length]
    if (next) choose(next.id)
  }

  const onApply = async () => {
    setApplying(true)
    setError(undefined)
    try {
      await apply(candidate)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="theme-picker-title">
      <DialogTitle id="theme-picker-title">Theme</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          {selection.effectiveThemeId !== selection.themeId && (
            <Alert severity="warning">
              The chosen theme <strong>{selection.themeId}</strong> is not available, so <strong>{labelOf(themes, selection.effectiveThemeId)}</strong> is in use.
              Its plugin may be disabled; choosing it again brings it back when the plugin returns.
            </Alert>
          )}

          <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
            <Typography id="theme-mode-label" variant="subtitle2">Mode</Typography>
            <ToggleButtonGroup exclusive size="small" value={candidate.mode} aria-labelledby="theme-mode-label"
              onChange={(_event, mode: ThemeMode | null) => { if (mode) setCandidate(current => ({ ...current, mode })) }}>
              {(['light', 'dark', 'system'] as ThemeMode[]).map(mode => (
                <ToggleButton key={mode} value={mode} aria-label={MODE_LABELS[mode]}>{MODE_LABELS[mode]}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            {candidate.mode === 'system' && <Typography variant="body2" color="text.secondary">currently {selection.resolvedMode}</Typography>}
          </Stack>

          <Stack direction="row" spacing={3} sx={{ alignItems: 'stretch', minHeight: 360 }}>
            <List role="listbox" aria-label="Themes" dense disablePadding onKeyDown={onListKeyDown}
              sx={{ width: 240, flex: 'none', overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
              {groups.map(group => (
                <Box key={group.pluginId} component="li" sx={{ listStyle: 'none' }}>
                  <ListSubheader disableSticky>{group.label}</ListSubheader>
                  <Box component="ul" sx={{ p: 0, m: 0 }}>
                    {group.themes.map(theme => (
                      <ThemeOption key={theme.id} theme={theme} scheme={scheme} selected={theme.id === candidate.themeId}
                        applied={theme.id === selection.themeId} onChoose={() => choose(theme.id)} shellTheme={shellTheme} />
                    ))}
                  </Box>
                </Box>
              ))}
            </List>

            <Stack sx={{ flex: 1, minWidth: 0 }} spacing={2}>
              <Box role="region" aria-label="Preview">
                <ThemeSample theme={sample.theme} />
              </Box>
              {sample.problem && <Alert severity="warning">{sample.problem} The built-in theme is shown instead.</Alert>}
              <FormControlLabel label="Preview in the whole window"
                control={<Switch checked={previewWindow} onChange={event => setPreviewWindow(event.target.checked)} />} />
            </Stack>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={onApply} disabled={unchanged || applying}>Apply</Button>
      </DialogActions>
    </Dialog>
  )
}

/** One theme in the list: its swatch for the current scheme, its label, and whether it is chosen or has one scheme only. */
function ThemeOption({ theme, scheme, selected, applied, onChoose, shellTheme }: {
  theme: ThemeDescriptor
  scheme: ColorScheme
  selected: boolean
  applied: boolean
  onChoose(): void
  shellTheme: ShellThemeContextValue
}) {
  const colours = theme.swatch?.[scheme] ?? swatchOf(shellTheme, theme, scheme)
  const only = theme.schemes.length === 1 ? `${theme.schemes[0]} only` : undefined
  return (
    <ListItemButton role="option" aria-selected={selected} selected={selected} onClick={onChoose} autoFocus={selected} data-theme-option={theme.id}>
      <Stack direction="row" sx={{ mr: 2, borderRadius: 0.5, overflow: 'hidden', border: 1, borderColor: 'divider' }} aria-hidden>
        {colours.map((colour, i) => <Box key={i} sx={{ width: 10, height: 20, bgcolor: colour }} />)}
      </Stack>
      <ListItemText primary={theme.label} slotProps={{ primary: { noWrap: true } }} />
      {applied && <Icon name="Circle" titleAccess="current theme" color="primary" sx={{ fontSize: 8, ml: 1 }} />}
      {only && <Chip label={only} size="small" variant="outlined" sx={{ ml: 1 }} />}
    </ListItemButton>
  )
}

/** The swatch a theme did not give: its built palette's backgrounds, primary and secondary. */
function swatchOf(shellTheme: ShellThemeContextValue, theme: ThemeDescriptor, scheme: ColorScheme): string[] {
  const { palette } = shellTheme.resolve(theme, scheme).theme
  return [palette.background.default, palette.background.paper, palette.primary.main, palette.secondary.main]
}

function groupByPlugin(themes: ThemeDescriptor[]) {
  const groups = new Map<string, { pluginId: string, label: string, themes: ThemeDescriptor[] }>()
  for (const theme of themes) {
    const label = theme.pluginId === 'shell' ? 'Built in' : theme.pluginId
    if (!groups.has(theme.pluginId)) groups.set(theme.pluginId, { pluginId: theme.pluginId, label, themes: [] })
    groups.get(theme.pluginId)!.themes.push(theme)
  }
  return [...groups.values()]
}

const labelOf = (themes: ThemeDescriptor[], id: string) => themes.find(theme => theme.id === id)?.label ?? (id === SHELL_THEME_ID ? 'Tessera' : id)
