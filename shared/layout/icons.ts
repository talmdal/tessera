// shared/layout/icons.ts — the shell's icon set, and how a contribution's `icon` is resolved.
//
// Names are Material icon names (as in MUI's @mui/icons-material); they live in @tessera/types so that
// tessera-ui can use them too. The components are in tessera-ui/standardIcons.ts.
import { isIconName } from '@tessera/types'

export { ICON_NAMES, isIconName } from '@tessera/types'
export type { IconName } from '@tessera/types'

/** True when an (already resolved) icon is a URL to a plugin file rather than a shell icon name. */
export function isIconUrl(icon: string) {
  return icon.includes('://')
}

/** What is wrong with a `./file` icon path, or undefined when it names a file inside the renderer folder. */
export function iconFileProblem(icon: string): string | undefined {
  const relative = icon.slice(2)
  if (!relative || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '')) {
    return `icon "${icon}" must be a file inside the plugin's renderer folder`
  }
  return undefined
}

/**
 * Resolves a contribution's `icon`: a shell icon name passes through, a
 * `./file.svg` in the plugin's renderer folder becomes the URL `iconUrlFor`
 * gives it, and the id of an icon a plugin registered (`isRegistered`) passes
 * through for the renderer to look up. Anything else is a problem, described
 * in the result.
 */
export function resolveIcon(
  icon: string,
  pluginId: string,
  iconUrlFor?: (pluginId: string, relativePath: string) => string | undefined,
  isRegistered?: (id: string) => boolean
): { icon: string } | { problem: string } {
  if (icon.startsWith('./')) {
    const problem = iconFileProblem(icon)
    if (problem) return { problem }
    const url = iconUrlFor?.(pluginId, icon.slice(2))
    return url ? { icon: url } : { problem: `icon "${icon}" needs a plugin with a renderer entry` }
  }

  if (isIconName(icon) || isRegistered?.(icon)) return { icon }
  return { problem: `unknown icon "${icon}"` }
}
