import { isIconName, isIconUrl } from '../../../shared/layout/icons'
import { ICON_GLYPHS } from './iconGlyphs'

const box = { display: 'inline-block', width: 18, height: 18, flex: 'none' } as const

/**
 * An icon for a bar view or item. A shell icon name draws its glyph and a
 * plugin's file (a URL) is painted through a mask, both in the current text
 * colour so they follow the theme. Anything else, such as a view whose icon
 * has not arrived yet, shows the initial of `title`.
 */
export function BarIcon({ icon, title }: { icon?: string, title: string }) {
  if (icon && isIconName(icon)) {
    return (
      <svg aria-hidden data-icon={icon} viewBox="0 0 24 24" width={18} height={18} fill="currentColor" style={{ flex: 'none' }}>
        <path d={ICON_GLYPHS[icon]} />
      </svg>
    )
  }

  if (icon && isIconUrl(icon)) {
    const mask = `url("${icon}") center / contain no-repeat`
    return <span aria-hidden data-icon={icon} style={{ ...box, backgroundColor: 'currentColor', mask, WebkitMask: mask }} />
  }

  return <span aria-hidden data-icon style={{ ...box, textAlign: 'center', fontWeight: 600 }}>{title.charAt(0).toUpperCase()}</span>
}
