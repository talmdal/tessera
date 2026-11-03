// shell/renderer/theme/resolveTheme.ts — turns a theme contribution into the MUI theme the window renders with.
import { getContrastRatio } from '@mui/material'
import type { Theme, ThemeOptions } from '@mui/material'
import type { ColorScheme, ThemeDescriptor } from '@tessera/types'
import { SHELL_THEME, SHELL_THEME_ID } from '../../../shared/themes/types'
import { createShellTheme } from './createShellTheme'

export interface ResolvedTheme {
  theme: Theme
  /** The theme that was built: the descriptor's, or the shell's when the descriptor's could not be. */
  themeId: string
  /** Why the descriptor's theme was not used, when it was not. */
  problem?: string
}

/** The shell's own theme as a descriptor, for when there is no catalogue yet or nothing else will do. */
export const BUILT_IN: ThemeDescriptor = { ...SHELL_THEME, pluginId: 'shell', schemes: ['light', 'dark'] }

/** Text on the page background must be readable; anything less than this is a broken theme, not a choice. */
const MIN_CONTRAST = 3

/**
 * Builds the MUI theme for `descriptor` in `scheme`: the shell's base, the
 * descriptor's common options, then its scheme (or the one it has, when it
 * lacks this one). A descriptor whose options throw in `createTheme`, or that
 * yields unreadable text or an absurd type size, is replaced by the shell's
 * theme for the same scheme, with the problem reported, so a broken theme
 * plugin can never leave the window unusable.
 */
export function resolveTheme(descriptor: ThemeDescriptor | undefined, scheme: ColorScheme): ResolvedTheme {
  if (!descriptor) return { theme: createShellTheme(scheme), themeId: SHELL_THEME_ID, problem: undefined }

  try {
    const options = descriptor[scheme] ?? descriptor[scheme === 'dark' ? 'light' : 'dark']
    const theme = createShellTheme(scheme, descriptor.common as ThemeOptions | undefined, options as ThemeOptions | undefined)
    const problem = check(theme)
    if (problem) throw new Error(problem)
    return { theme, themeId: descriptor.id }
  } catch (err) {
    const problem = `Theme "${descriptor.label}" (${descriptor.pluginId}) could not be used: ${err instanceof Error ? err.message : String(err)}`
    return { theme: createShellTheme(scheme), themeId: SHELL_THEME_ID, problem }
  }
}

/** What createTheme does not check, and a user would notice at once. */
function check(theme: Theme): string | undefined {
  const { background, text } = theme.palette
  const contrast = getContrastRatio(text.primary, background.default)
  if (contrast < MIN_CONTRAST) return `text (${text.primary}) is unreadable on the background (${background.default}): contrast ${contrast.toFixed(1)}`
  const size = theme.typography.fontSize
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 8 || size > 32) return `the base font size ${String(size)} is not between 8 and 32`
  return undefined
}

/**
 * `resolveTheme`, remembering the last few results by descriptor and scheme,
 * so switching back and forth does not rebuild, and a descriptor that is
 * re-contributed unchanged does not re-render the window.
 */
export function createThemeResolver(capacity = 8) {
  const cache = new Map<string, ResolvedTheme>()
  return (descriptor: ThemeDescriptor | undefined, scheme: ColorScheme): ResolvedTheme => {
    const key = `${scheme}:${descriptor ? JSON.stringify(descriptor) : ''}`
    const hit = cache.get(key)
    if (hit) return hit
    const resolved = resolveTheme(descriptor, scheme)
    if (cache.size >= capacity) cache.delete(cache.keys().next().value!)
    cache.set(key, resolved)
    return resolved
  }
}
