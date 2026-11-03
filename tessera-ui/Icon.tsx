// tessera-ui/Icon.tsx — the shell's icons, for the shell and for plugin views.
import { styled } from '@mui/material'
import type { SvgIconProps, SxProps, Theme } from '@mui/material'
import { isIconName, isIconUrl } from '../shared/layout/icons'
import type { IconName } from '../shared/layout/icons'
import { ICONS } from './icons'

type IconSize = NonNullable<SvgIconProps['fontSize']>

/** Props an icon shares with SvgIcon: size and colour come from the theme, and `sx` tunes the rest. */
interface IconBaseProps {
  /** The same scale as SvgIcon: `inherit` is 1em, `small` 20px, `medium` (default) 24px, `large` 35px. */
  fontSize?: IconSize
  className?: string
  sx?: SxProps<Theme>
}

export interface IconProps extends IconBaseProps, Omit<SvgIconProps, keyof IconBaseProps | 'children' | 'component'> {
  /** One of the shell's icon names. */
  name: IconName
}

/**
 * One of the shell's icons, by name. It is an MUI `SvgIcon`, so it takes
 * `fontSize`, `color` and `sx`, and is painted in the current text colour.
 * Plugins use it for the icons the shell ships; for their own, they wrap a
 * path in `SvgIcon` from `@mui/material` or contribute an SVG file.
 */
export function Icon({ name, ...props }: IconProps) {
  const Glyph = ICONS[name]
  return <Glyph data-icon={name} {...props} />
}

export interface ContributionIconProps extends IconBaseProps {
  /** A shell icon name, or the URL of a plugin's icon file, as resolved by the main process. */
  icon?: string
  /** The contribution's title; its initial is shown when there is no icon to draw. */
  title: string
}

/**
 * The icon of a contribution (a view or a bar item). A shell icon name draws
 * that icon; a plugin's file (a URL) is painted through a mask, in the current
 * text colour so it follows the theme like the named icons; anything else,
 * such as a view whose icon has not arrived yet, shows the initial of `title`.
 */
export function ContributionIcon({ icon, title, fontSize = 'medium', ...props }: ContributionIconProps) {
  if (icon && isIconName(icon)) return <Icon name={icon} fontSize={fontSize} {...props} />

  if (icon && isIconUrl(icon)) {
    return <MaskedIcon aria-hidden data-icon={icon} url={icon} size={fontSize} {...props} />
  }

  return (
    <InitialIcon aria-hidden data-icon size={fontSize} {...props}>
      <span>{title.charAt(0).toUpperCase()}</span>
    </InitialIcon>
  )
}

/** SvgIcon's sizes, so a masked file and an initial line up with the named icons beside them. */
const sizeOf = (theme: Theme, size: IconSize) =>
  ({ inherit: 'inherit', small: theme.typography.pxToRem(20), medium: theme.typography.pxToRem(24), large: theme.typography.pxToRem(35) })[size]

const skip = new Set(['size', 'url'])

const IconBox = styled('span', { shouldForwardProp: prop => !skip.has(prop as string) })<{ size: IconSize }>(({ theme, size }) => ({
  display: 'inline-block',
  flexShrink: 0,
  width: '1em',
  height: '1em',
  fontSize: sizeOf(theme, size),
  userSelect: 'none',
  verticalAlign: 'middle'
}))

const MaskedIcon = styled(IconBox)<{ url: string }>(({ url }) => {
  const mask = `url("${url}") center / contain no-repeat`
  return { backgroundColor: 'currentColor', mask, WebkitMask: mask }
})

const InitialIcon = styled(IconBox)({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  lineHeight: 1,
  // The letter sits inside the box as a glyph sits inside its viewBox.
  '& > span': { fontSize: '0.7em' }
})
