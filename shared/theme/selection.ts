// shared/theme/selection.ts — theme selections: reading saved ones, checking new ones, and resolving to what a window shows.
import type { ThemeDescriptor, ThemeMode, ThemeModePreference, ThemeSelection } from '@tessera/types'
import { DEFAULT_THEME_ID } from './types'

export const THEME_MODES: readonly ThemeModePreference[] = ['system', 'light', 'dark']

export const DEFAULT_SELECTION: ThemeSelection = { theme: DEFAULT_THEME_ID, mode: 'system' }

const isMode = (value: unknown): value is ThemeModePreference => (THEME_MODES as readonly unknown[]).includes(value)

/** The modes a theme has a variant for. */
export function modesOf(theme: ThemeDescriptor): ThemeMode[] {
  return [...(theme.light ? ['light' as const] : []), ...(theme.dark ? ['dark' as const] : [])]
}

/** True for a theme with both variants, so one that can follow the system. */
export const followsSystem = (theme: ThemeDescriptor) => theme.light !== undefined && theme.dark !== undefined

/**
 * Reads a saved selection. Absent means "none saved". The values the old theme
 * hook wrote (`'light'`, `'dark'`) become explicit modes of the shell's theme;
 * anything else is reported in `warning` and treated as absent.
 */
export function parseStoredSelection(raw: unknown): { selection?: ThemeSelection, warning?: string } {
  if (raw === undefined || raw === null) return {}
  if (raw === 'light' || raw === 'dark') return { selection: { theme: DEFAULT_THEME_ID, mode: raw } }

  if (typeof raw === 'object') {
    const { theme, mode } = raw as Record<string, unknown>
    if (typeof theme === 'string' && theme.length > 0 && isMode(mode)) return { selection: { theme, mode } }
  }
  return { warning: `Ignored an unreadable saved theme: ${JSON.stringify(raw)}` }
}

/** What is wrong with a selection for the registered `themes`, or undefined when it can be used. */
export function selectionProblem(selection: unknown, themes: readonly ThemeDescriptor[]): string | undefined {
  if (typeof selection !== 'object' || selection === null) return 'A theme selection must be an object with a theme and a mode'

  const { theme: id, mode } = selection as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return 'A theme selection needs a theme id'
  if (!isMode(mode)) return `Unknown theme mode "${String(mode)}"; use system, light or dark`

  const theme = themes.find(t => t.id === id)
  if (!theme) return `Unknown theme "${id}"`
  if (mode === 'system' && !followsSystem(theme)) return `Theme "${id}" has a single variant and cannot follow the system`
  if (mode !== 'system' && !modesOf(theme).includes(mode)) return `Theme "${id}" has no ${mode} variant`
  return undefined
}

/**
 * The selection that shows a theme: the wanted mode if the theme has it,
 * otherwise what the theme can do (`system` for a theme with both variants).
 */
export function selectionFor(theme: ThemeDescriptor, wanted: ThemeModePreference): ThemeSelection {
  const modes = modesOf(theme)
  if (wanted === 'system' ? followsSystem(theme) : modes.includes(wanted)) return { theme: theme.id, mode: wanted }
  return { theme: theme.id, mode: followsSystem(theme) ? 'system' : modes[0] }
}

/**
 * What a selection shows: the theme (the shell's own if it is not registered,
 * reported in `fellBack`) and its mode. `system` takes the OS's mode; a mode the
 * theme has no variant for becomes the one it has.
 */
export function resolveSelection(
  selection: ThemeSelection,
  themes: readonly ThemeDescriptor[],
  systemPrefersDark: boolean
): { theme: string, mode: ThemeMode, fellBack: boolean } {
  const found = themes.find(t => t.id === selection.theme)
  const theme = found ?? themes.find(t => t.id === DEFAULT_THEME_ID)!
  const modes = modesOf(theme)

  const wanted: ThemeMode = selection.mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : selection.mode
  return { theme: theme.id, mode: modes.includes(wanted) ? wanted : modes[0], fellBack: found === undefined }
}
