// shell/renderer/settings/pages/FontsPage.tsx — the Options dialog's Fonts page: the user's font for each kind of text
// (the `shell.fonts` setting). See docs/font-roles-design.md#the-fonts-page.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FontRoleId, FontSettings, FontSource, FontWeight, ResolvedFontRole, SettingsPageProps } from '@tessera/types'
import { Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@tessera/ui'
import { GENERIC_FAMILIES } from '../../../../shared/fonts/families'
import { resolveFonts } from '../../../../shared/fonts/resolveFonts'
import { FONT_ROLES, FONT_WEIGHTS, describeThemeFonts, fontSpecProblems, type FontRoleDefinition } from '../../../../shared/fonts/roles'
import { themeOf } from '../../../../shared/theme/tokens'
import { FamilyPicker } from '../../fonts/FamilyPicker'
import { useInstalledFonts } from '../../fonts/InstalledFonts'
import { useThemeCatalogue, useWindowTheme } from '../../theme/ShellThemeProvider'
import { ThemePreview } from '../../theme/ThemePreview'

type RoleValue = Record<string, string[] | number | null>

/** A size for people, beside a "px": whole pixels as they are, the automatic ratios to one place ("11.1"). */
const pixels = (size: number | undefined) => size === undefined ? '' : String(Math.round(size * 10) / 10)

/** Where a value comes from, in words, for a role. */
function sourceText(role: FontRoleDefinition, source: FontSource | undefined): string {
  switch (source) {
    case 'user': return 'yours'
    case 'theme': return 'from the theme'
    case 'inherited': return role.id === 'numeric' ? 'follows the text around it' : 'follows Interface text'
    default: return 'automatic'
  }
}

/**
 * What Automatic gives a role's font now: "Inter", "the system's interface font". Why it gives that (it follows
 * Interface text, the theme sets it) is the row's sources line, so the box stays short enough to read.
 */
const automaticFamily = (role: FontRoleDefinition, resolved: ResolvedFontRole): string =>
  resolved.primary ?? (role.id === 'monospace' ? "the system's fixed-width font" : role.id === 'numeric' ? 'the font of the text around it' : "the system's interface font")

/** What Automatic gives a role's weight, said in its sources line. */
const automaticWeight = (role: FontRoleDefinition, resolved: ResolvedFontRole) =>
  role.id === 'heading' ? "each heading's own" : FONT_WEIGHTS.find(w => w.weight === resolved.weight)?.label ?? 'Regular'

/** What a role falls back to when its own font is missing: said in the warning that it isn't installed. */
const fallbackText = (id: FontRoleId) =>
  id === 'ui' ? "the system's interface font" : id === 'monospace' ? "the system's fixed-width font" : 'the Interface text font'

/**
 * The user's font for each role: a row per role with the controls its facets allow, where each value comes from, and
 * a Reset; whether to use the fonts themes choose; and a preview of the draft in the window's theme. Choosing changes
 * the draft only: OK or Apply saves it, and every window is drawn in it.
 */
export function FontsPage({ value, onChange, onValidityChange, disabled }: SettingsPageProps<FontSettings>) {
  const installed = useInstalledFonts()
  const { themes } = useThemeCatalogue()
  const windowTheme = useWindowTheme()
  const theme = themeOf(windowTheme, themes)
  // The draft, resolved over the fonts of the window's theme: what the preview draws, and what Automatic means in each row
  const resolved = useMemo(() => resolveFonts(value, theme.fonts), [value, theme.fonts])
  const themeSets = describeThemeFonts(theme.fonts)

  // Each control reports whether what it holds can be saved; the page is valid when all can
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const validity = useCallback((key: string) => (valid: boolean) =>
    setInvalid(current => current[key] === !valid ? current : { ...current, [key]: !valid }), [])
  useEffect(() => { onValidityChange(!Object.values(invalid).some(Boolean)) }, [invalid, onValidityChange])

  const setRole = (id: FontRoleId, next: RoleValue) => onChange({ ...value, roles: { ...value.roles, [id]: next } } as FontSettings)

  return (
    <Stack spacing={2.5} data-fonts-page>
      <Box>
        <FormControlLabel label="Use the fonts themes choose"
          control={<Checkbox checked={value.useThemeFonts} disabled={disabled}
            onChange={event => onChange({ ...value, useThemeFonts: event.target.checked })} />} />
        <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: 4, mt: -0.5 }} data-theme-fonts>
          {themeSets.length === 0
            ? `The ${theme.label} theme sets no fonts of its own. A role you leave on Automatic uses the theme's font when it sets one.`
            : value.useThemeFonts
              ? `The ${theme.label} theme sets: ${themeSets.join(', ')}. They're used for roles you leave on Automatic.`
              : `The ${theme.label} theme sets: ${themeSets.join(', ')}. They aren't used while this is off.`}
        </Typography>
      </Box>

      {FONT_ROLES.map(role => (
        <FontRoleRow key={role.id} role={role} value={value.roles[role.id] as RoleValue} resolved={resolved[role.id]}
          installed={installed} disabled={disabled} validity={validity}
          onChange={next => setRole(role.id, next)} />
      ))}

      <Stack spacing={1.5}>
        <Typography variant="subtitle2" component="h3">
          Preview <Typography component="span" variant="caption" color="text.secondary">· {theme.label}, {windowTheme.mode} mode</Typography>
        </Typography>
        <ThemePreview theme={theme} mode={windowTheme.mode} fonts={resolved} fontSamples />
      </Stack>
    </Stack>
  )
}

/** One role: its font, and its size and weight where it has them, each Automatic until set. */
function FontRoleRow({ role, value, resolved, installed, disabled, validity, onChange }: {
  role: FontRoleDefinition
  value: RoleValue
  resolved: ResolvedFontRole
  installed: ReturnType<typeof useInstalledFonts>
  disabled: boolean
  validity: (key: string) => (valid: boolean) => void
  onChange(next: RoleValue): void
}) {
  const id = useId()
  const legendId = `${id}-legend`
  const sourcesId = `${id}-sources`
  const family = (value.family ?? null) as string[] | null
  const set = (facet: string, next: string[] | number | null) => onChange({ ...value, [facet]: next })
  const chosen = Object.values(value).some(v => v !== null)

  const missing = installed.complete && family
    ? family.filter(name => !GENERIC_FAMILIES.includes(name.toLowerCase()) && !installed.families.some(f => f.toLowerCase() === name.toLowerCase()))
    : []

  const sources = [
    `Font: ${sourceText(role, resolved.sources.family)}`,
    ...(role.facets.includes('size') ? [`Size: ${sourceText(role, resolved.sources.size)}`] : []),
    ...(role.facets.includes('weight')
      ? [`Weight: ${sourceText(role, resolved.sources.weight)}${value.weight === null || value.weight === undefined ? ` (${automaticWeight(role, resolved)})` : ''}`]
      : [])
  ]

  return (
    <Box role="group" aria-labelledby={legendId} data-font-role={role.id} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={legendId} component="h3" variant="subtitle2">{role.label}</Typography>
          <Typography variant="caption" color="text.secondary" component="p">{role.description}</Typography>
        </Box>
        <Button size="small" disabled={disabled || !chosen} aria-label={`Reset ${role.label} to Automatic`}
          onClick={() => onChange(Object.fromEntries(Object.keys(value).map(facet => [facet, null])))}>
          Reset
        </Button>
      </Stack>

      {/*
        * Spaced with gap (useFlexGap), not margins: a Stack spacing with margins sets its children's margins to 0, which
        * took the theme's top margin from the size and weight boxes but not from the font box, which is wrapped, and left
        * them out of line with it.
        */}
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 0.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Box sx={{ flex: '1 1 16em', minWidth: 0 }}>
          <FamilyPicker label="Font" value={family} automatic={automaticFamily(role, resolved)} installed={installed}
            disabled={disabled} onChange={names => set('family', names)} onValidityChange={validity(`${role.id}.family`)} describedBy={sourcesId} />
        </Box>
        {role.facets.includes('size') && (
          <SizeField role={role} value={(value.size ?? null) as number | null} automatic={resolved.size} disabled={disabled}
            describedBy={sourcesId} onChange={size => set('size', size)} onValidityChange={validity(`${role.id}.size`)} />
        )}
        {role.facets.includes('weight') && (
          <TextField select label="Weight" value={value.weight ?? ''} disabled={disabled} sx={{ width: '12em' }}
            slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true }, htmlInput: { 'aria-describedby': sourcesId } }}
            onChange={event => set('weight', event.target.value === '' ? null : Number(event.target.value) as FontWeight)}>
            <MenuItem value="">Automatic</MenuItem>
            {FONT_WEIGHTS.map(({ weight, label }) => <MenuItem key={weight} value={weight}>{label}</MenuItem>)}
          </TextField>
        )}
      </Stack>

      <Typography id={sourcesId} variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>{sources.join(' · ')}</Typography>
      {missing.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {missing.map(name => `“${name}”`).join(', ')} {missing.length === 1 ? "isn't" : "aren't"} installed on this computer; {fallbackText(role.id)} is used instead.
        </Alert>
      )}
    </Box>
  )
}

/** A size in whole pixels, blank for Automatic (whose size shows as the placeholder). */
function SizeField({ role, value, automatic, disabled, describedBy, onChange, onValidityChange }: {
  role: FontRoleDefinition
  value: number | null
  automatic: number | undefined
  disabled: boolean
  describedBy: string
  onChange(next: number | null): void
  onValidityChange(valid: boolean): void
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [problem, setProblem] = useState<string | undefined>()

  // A value changed from outside (Reset, Restore Defaults) replaces what was typed
  const shown = useRef(value)
  useEffect(() => {
    if (shown.current === value) return
    shown.current = value
    setText(value === null ? '' : String(value))
    setProblem(undefined)
  }, [value])
  useEffect(() => { onValidityChange(problem === undefined) }, [problem, onValidityChange])

  const type = (typed: string) => {
    setText(typed)
    const size = typed.trim() === '' ? null : Number(typed.trim())
    const problems = size === null ? [] : fontSpecProblems(role.id, { size }, 'user')
    // The message without the role's name, which the row already shows
    setProblem(problems[0]?.replace(`${role.label}: c`, 'C'))
    if (problems.length === 0) {
      shown.current = size
      if (size !== value) onChange(size)
    }
  }

  return (
    <TextField label="Size" value={text} disabled={disabled} error={problem !== undefined}
      helperText={problem}
      placeholder={pixels(automatic)} onChange={event => type(event.target.value)} sx={{ width: '9em' }}
      slotProps={{
        inputLabel: { shrink: true },
        input: { endAdornment: <Typography variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>px</Typography> },
        htmlInput: { inputMode: 'numeric', 'aria-describedby': describedBy }
      }} />
  )
}
