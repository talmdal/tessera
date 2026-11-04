import { Box } from '@mui/material'
import type { SvgIconProps } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'
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

/** The sizes MUI's SvgIcon uses for `fontSize`. */
const SIZE = { small: '1.25rem', medium: '1.5rem', large: '2.1875rem', inherit: '1.5em' } as const

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
  const url = isIconName(name) ? undefined : name.includes('://') ? name : registry.get(name)
  const source = useIconSource(url)

  if (isIconName(name)) {
    const Standard = STANDARD_ICONS[name]
    return <Standard data-icon={name} fontSize={fontSize} color={color} sx={sx} titleAccess={titleAccess} {...rest} />
  }

  const size = SIZE[fontSize]
  const base: SxProps<Theme> = {
    display: 'inline-block',
    flex: 'none',
    width: size,
    height: size,
    userSelect: 'none',
    ...(source
      ? { bgcolor: paletteColor(color), mask: `url("${source}") center / contain no-repeat`, WebkitMask: `url("${source}") center / contain no-repeat` }
      : { textAlign: 'center', fontWeight: 600, lineHeight: size, color: paletteColor(color) })
  }
  const label = titleAccess ? { role: 'img', 'aria-label': titleAccess } : { 'aria-hidden': true }

  return (
    <Box component="span" data-icon={name} {...label} sx={[base, ...(Array.isArray(sx) ? sx : [sx])]} {...(rest as object)}>
      {source ? null : fallback?.charAt(0).toUpperCase()}
    </Box>
  )
}
