import { Box } from '@mui/material'
import type { SvgIconProps } from '@mui/material'
import { useTheme, type SxProps, type Theme } from '@mui/material/styles'
import { useContext } from 'react'
import { isIconName } from '@tessera/types'
import { IconRegistryContext } from './iconRegistry'
import { useIconSource } from './iconSource'
import { STANDARD_ICONS } from './standardIcons'

export interface IconProps extends Omit<SvgIconProps, 'children' | 'component' | 'ref'> {
  /**
   * A standard icon (`'Save'`), or the id of an icon a plugin registered
   * through `shell.icons` (`'accounts.bank'`).
   */
  name: string
  /** Text shown at the icon's size while a registered icon loads, or if it can't be found. Default: nothing. */
  fallback?: string
}

/**
 * The sizes MUI's SvgIcon uses for `fontSize`, in px for its design scale. MUI passes them through the theme's `pxToRem`,
 * so they follow the interface size; a registered icon does the same, so the two kinds always match.
 */
const SIZE_PX = { small: 20, medium: 24, large: 35 } as const

/** The palette path for an SvgIcon `color`, for the icons that are painted rather than drawn. */
const COLOR: Record<string, string> = { action: 'action.active', disabled: 'action.disabled' }
const paletteColor = (color: string | undefined) => color === undefined || color === 'inherit' ? 'currentColor' : (COLOR[color] ?? `${color}.main`)

/**
 * An icon. A standard one is a Material SVG icon, so it takes the same props
 * (`fontSize`, `color`, `sx`, `titleAccess`). A plugin's registered one is
 * fetched when first drawn and painted through a mask in the current text
 * colour, which follows the theme and light or dark mode, so it is
 * monochrome and takes the same size and colour props. Both are hidden from
 * assistive technology unless given a `titleAccess`.
 */
export function Icon({ name, fallback, fontSize = 'medium', color, sx, titleAccess, ...rest }: IconProps) {
  const registry = useContext(IconRegistryContext)
  const theme = useTheme()
  const url = isIconName(name) ? undefined : name.includes('://') ? name : registry.get(name)
  const source = useIconSource(url)

  if (isIconName(name)) {
    const Standard = STANDARD_ICONS[name]
    return <Standard data-icon={name} fontSize={fontSize} color={color} sx={sx} titleAccess={titleAccess} {...rest} />
  }

  // As MUI sizes an SvgIcon: the size is the font size and the box is 1em square, so a container that sets the icon's
  // font size (a button's start icon, `fontSize="inherit"`) sizes this icon as it sizes a standard one.
  const base: SxProps<Theme> = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    fontSize: fontSize === 'inherit' ? 'inherit' : theme.typography.pxToRem(SIZE_PX[fontSize]),
    width: '1em',
    height: '1em',
    userSelect: 'none',
    ...(source
      ? { bgcolor: paletteColor(color), mask: `url("${source}") center / contain no-repeat`, WebkitMask: `url("${source}") center / contain no-repeat` }
      : { fontWeight: 600, lineHeight: 1, color: paletteColor(color) })
  }
  const label = titleAccess ? { role: 'img', 'aria-label': titleAccess } : { 'aria-hidden': true }

  return (
    <Box component="span" data-icon={name} {...label} sx={[base, ...(Array.isArray(sx) ? sx : [sx])]} {...(rest as object)}>
      {/* The placeholder letter at about the size of the text beside it, centred in the icon's box */}
      {source ? null : fallback && <Box component="span" sx={{ fontSize: '0.7em' }}>{fallback.charAt(0).toUpperCase()}</Box>}
    </Box>
  )
}
