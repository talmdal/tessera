// shared/layout/icons.ts
//
// Names of the shell's built-in icon set. Contributions may reference one of
// these by name instead of shipping a file; the glyphs themselves live in the
// renderer (shell/renderer/layout/iconGlyphs.ts). The set is intentionally
// small to start with; growing it (or swapping in Codicons wholesale) only
// means adding entries in both places.

export const SHELL_ICON_NAMES: readonly string[] = [
  'accounts',
  'calendar',
  'chart',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'circle-filled',
  'gear',
  'home',
  'info',
  'list-flat',
  'output',
  'save',
  'search',
  'warning'
]

/** True for "./relative/path.svg" icons, served from the plugin's renderer folder. */
export function isFileIcon(icon: string) {
  return icon.startsWith('./')
}

export function isShellIconName(icon: string) {
  return SHELL_ICON_NAMES.includes(icon)
}

/** A valid contribution icon: a renderer-folder file or a shell icon-set name. */
export function isValidIcon(icon: unknown): icon is string {
  return typeof icon === 'string' && icon.length > 0 && (isFileIcon(icon) || isShellIconName(icon))
}
