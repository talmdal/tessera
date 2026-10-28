// shared/layout/icons.ts — the shell's icon set, and how a contribution's `icon` is resolved.
//
// Names are Material icon names (as in MUI's @mui/icons-material), so the set
// can be swapped for the package wholesale. The glyphs live in
// shell/renderer/layout/iconGlyphs.ts.

export const ICON_NAMES = [
  'Add', 'AccountBalance', 'CalendarToday', 'Circle', 'Close', 'Home', 'Info', 'List', 'Save', 'Search'
] as const

export type IconName = typeof ICON_NAMES[number]

export function isIconName(value: string): value is IconName {
  return (ICON_NAMES as readonly string[]).includes(value)
}

/** True when an (already resolved) icon is a URL to a plugin file rather than a shell icon name. */
export function isIconUrl(icon: string) {
  return icon.includes('://')
}

/**
 * Resolves a contribution's `icon`: a shell icon name passes through, and a
 * `./file.svg` in the plugin's renderer folder becomes the URL `iconUrlFor`
 * gives it. Anything else is a problem, described in the result.
 */
export function resolveIcon(
  icon: string,
  pluginId: string,
  iconUrlFor?: (pluginId: string, relativePath: string) => string | undefined
): { icon: string } | { problem: string } {
  if (icon.startsWith('./')) {
    const relative = icon.slice(2)
    if (!relative || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '')) {
      return { problem: `icon "${icon}" must be a file inside the plugin's renderer folder` }
    }
    const url = iconUrlFor?.(pluginId, relative)
    return url ? { icon: url } : { problem: `icon "${icon}" needs a plugin with a renderer entry` }
  }

  return isIconName(icon) ? { icon } : { problem: `unknown icon "${icon}"` }
}
