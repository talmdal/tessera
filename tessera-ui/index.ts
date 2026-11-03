// tessera-ui — @tessera/ui: the part of the shell's look that plugin views may depend on.
//
// The shell builds this into its bundle and shares it with plugin renderer
// remotes as a Module Federation singleton (see shared/federation.ts), so a
// plugin that imports it gets the shell's icons and tokens, not a copy. It is
// small on purpose: components come from @mui/material, which is shared the
// same way, and this adds only what is Tessera's own.

/** Must match package.json; the federation host announces it to remotes. */
export const version = '0.1.0'

export { Icon, ContributionIcon } from './Icon'
export type { IconProps, ContributionIconProps } from './Icon'
export { ICONS } from './icons'
export { ICON_NAMES, isIconName, isIconUrl } from '../shared/layout/icons'
export type { IconName } from '../shared/layout/icons'
export { deriveTokens } from './tokens'
export type { TesseraTokens, TesseraTokenOptions } from './tokens'
export { mergeThemeOptions } from './mergeThemeOptions'
