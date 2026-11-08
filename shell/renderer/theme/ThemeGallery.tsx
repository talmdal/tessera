// shell/renderer/theme/ThemeGallery.tsx — every registered theme, as cards to choose from.
import { KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import type { ThemeDescriptor, ThemeMode } from '@tessera/types'
import { Box, Icon, TextField, Typography } from '@tessera/ui'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../shared/fonts/resolveFonts'
import { describeThemeFonts } from '../../../shared/fonts/roles'
import { followsSystem, modesOf } from '../../../shared/theme/selection'
import { tokensFor } from '../../../shared/theme/tokens'
import { DEFAULT_THEME_ID } from '../../../shared/theme/types'

/** From this many themes, a filter box is shown above the cards. */
export const FILTER_FROM = 7

/** What a theme can show, in words, when it can't follow the system. */
export function themeLimits(theme: ThemeDescriptor): string | undefined {
  return followsSystem(theme) ? undefined : `${modesOf(theme)[0] === 'dark' ? 'Dark' : 'Light'} only`
}

/** Who offers a theme: the shell, or the plugin whose id prefixes the theme's (the registry enforces the prefix). */
export function themeSource(theme: ThemeDescriptor): string | undefined {
  return theme.id === DEFAULT_THEME_ID ? undefined : theme.id.slice(0, theme.id.indexOf('.'))
}

/** What a theme's fonts set, in words ("Sets fonts: Headings (Georgia)"), or undefined when it sets none. */
export function themeFonts(theme: ThemeDescriptor): string | undefined {
  const set = describeThemeFonts(theme.fonts)
  return set.length > 0 ? `Sets fonts: ${set.join(', ')}` : undefined
}

/**
 * The family a theme's name is drawn in on its card, so a theme that sets fonts presents itself: its heading font, else
 * its interface font. Undefined when it sets neither. Resolved, so the name is checked and quoted as everywhere else.
 */
function labelFamily(theme: ThemeDescriptor): string | undefined {
  if (!theme.fonts) return undefined
  const { heading, ui } = resolveFonts(DEFAULT_FONT_SETTINGS, theme.fonts)
  return heading.sources.family === 'theme' ? heading.fontFamily : ui.sources.family === 'theme' ? ui.fontFamily : undefined
}

const matches = (theme: ThemeDescriptor, query: string) => {
  const text = [theme.label, theme.description ?? '', themeSource(theme) ?? '', themeFonts(theme) ?? ''].join('\n').toLocaleLowerCase()
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word))
}

/**
 * The themes as a grid of cards, one radio choice each. A card is drawn from nothing but the theme's tokens, in the
 * mode choosing it would show (`modeOf`), so a theme a plugin contributes presents itself with no code of its own; its
 * optional description and where it comes from are shown under its name. The grid fills whatever width it has, and
 * a filter box appears once there are enough themes to need one.
 *
 * Keyboard: the arrow keys (and Home, End) move the choice, as in any radio group; only the chosen card is a tab stop.
 */
export function ThemeGallery({ themes, selected, onSelect, modeOf, disabled = false, labelledBy }: {
  themes: readonly ThemeDescriptor[]
  selected?: string
  onSelect(themeId: string): void
  modeOf(theme: ThemeDescriptor): ThemeMode
  disabled?: boolean
  /** The id of the element that names the group. */
  labelledBy: string
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => themes.filter(theme => matches(theme, query)), [themes, query])
  const cards = useRef(new Map<string, HTMLElement>())
  // The tab stop: the chosen card if it is shown, otherwise the first one
  const focusable = shown.some(t => t.id === selected) ? selected : shown[0]?.id

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (disabled) return
    const last = shown.length - 1
    const next = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: last }[event.key]
    if (next !== undefined) {
      event.preventDefault()
      const theme = shown[(next + shown.length) % shown.length]
      onSelect(theme.id)
      cards.current.get(theme.id)?.focus()
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      onSelect(shown[index].id)
    }
  }

  return (
    <Box>
      {themes.length >= FILTER_FROM && (
        <TextField size="small" placeholder="Filter themes" value={query} onChange={event => setQuery(event.target.value)} sx={{ mb: 1.5, width: 260 }}
          slotProps={{ htmlInput: { 'aria-label': 'Filter themes' } }} />
      )}
      <Box role="radiogroup" aria-labelledby={labelledBy} aria-disabled={disabled || undefined}
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 1.5 }}>
        {shown.map((theme, index) => (
          <ThemeCard key={theme.id} theme={theme} mode={modeOf(theme)} checked={theme.id === selected} disabled={disabled}
            tabIndex={theme.id === focusable && !disabled ? 0 : -1}
            cardRef={element => { if (element) cards.current.set(theme.id, element); else cards.current.delete(theme.id) }}
            onSelect={() => { if (!disabled) onSelect(theme.id) }}
            onKeyDown={event => onKeyDown(event, index)} />
        ))}
      </Box>
      {shown.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No theme matches “{query}”.</Typography>}
    </Box>
  )
}

function ThemeCard({ theme, mode, checked, disabled, tabIndex, cardRef, onSelect, onKeyDown }: {
  theme: ThemeDescriptor
  mode: ThemeMode
  checked: boolean
  disabled: boolean
  tabIndex: number
  cardRef(element: HTMLElement | null): void
  onSelect(): void
  onKeyDown(event: KeyboardEvent): void
}) {
  const id = useId()
  const details = [theme.description, themeLimits(theme), themeFonts(theme), themeSource(theme) && `From ${themeSource(theme)}`].filter(Boolean).join(' · ')
  return (
    <Box ref={cardRef} role="radio" aria-checked={checked} aria-disabled={disabled || undefined} aria-labelledby={`${id}-label`}
      aria-describedby={details ? `${id}-details` : undefined} tabIndex={tabIndex} data-theme-id={theme.id}
      onClick={onSelect} onKeyDown={onKeyDown}
      sx={{
        borderRadius: 1.5, p: 1, cursor: disabled ? 'default' : 'pointer', outline: 'none', opacity: disabled ? 0.6 : 1,
        border: 2, borderColor: checked ? 'primary.main' : 'divider',
        '&:hover': disabled ? undefined : { borderColor: checked ? 'primary.main' : 'text.secondary' },
        '&:focus-visible': { outline: theme => `2px solid ${theme.palette.primary.main}`, outlineOffset: '2px' }
      }}>
      <ThemeMiniature theme={theme} mode={mode} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
        <Typography id={`${id}-label`} variant="body2" sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0, fontFamily: labelFamily(theme) }} noWrap>{theme.label}</Typography>
        {checked && <Icon name="Check" fontSize="small" color="primary" />}
      </Box>
      {details && <Typography id={`${id}-details`} variant="caption" color="text.secondary" sx={{ display: 'block' }}>{details}</Typography>}
    </Box>
  )
}

/**
 * A small sketch of a window in a theme: its page, a title bar and a side panel on paper, lines of text and a
 * button in the primary colour. Decorative: the card names the theme.
 */
export function ThemeMiniature({ theme, mode }: { theme: ThemeDescriptor, mode: ThemeMode }) {
  const t = tokensFor(theme, mode)
  const line = (width: string, colour: string) => <Box sx={{ height: 4, width, borderRadius: 1, bgcolor: colour, mb: 0.75 }} />
  return (
    <Box aria-hidden sx={{ height: 72, borderRadius: 1, overflow: 'hidden', bgcolor: t.background.default, border: 1, borderColor: t.divider, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ height: 14, bgcolor: t.background.paper, borderBottom: 1, borderColor: t.divider, display: 'flex', alignItems: 'center', px: 0.75, gap: 0.5 }}>
        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: t.primary }} />
        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: t.secondary }} />
      </Box>
      <Box sx={{ display: 'flex', flexGrow: 1 }}>
        <Box sx={{ width: '30%', bgcolor: t.background.paper, borderRight: 1, borderColor: t.divider, p: 0.75 }}>
          {line('80%', t.text.secondary)}
          {line('60%', t.text.secondary)}
        </Box>
        <Box sx={{ flexGrow: 1, p: 0.75 }}>
          {line('70%', t.text.primary)}
          {line('90%', t.text.secondary)}
          <Box sx={{ height: 8, width: 28, borderRadius: 0.5, bgcolor: t.primary, mt: 0.5 }} />
        </Box>
      </Box>
    </Box>
  )
}
