// shell/renderer/layout/Icon.tsx
import { CSSProperties } from 'react'
import { ICON_GLYPHS } from './iconGlyphs'

/**
 * A resolved contribution icon: a URL (contains "://", painted through a CSS
 * mask so it follows the theme's currentColor) or a shell icon-set name.
 * Decorative: the surrounding control carries the accessible name.
 */
export function Icon({ icon }: { icon?: string }) {
  if (!icon) return null

  if (icon.includes('://')) {
    const mask: CSSProperties = {
      WebkitMaskImage: `url("${icon}")`,
      maskImage: `url("${icon}")`
    }
    return <span className="wm-icon wm-icon-mask" style={mask} aria-hidden="true" />
  }

  const glyph = ICON_GLYPHS[icon]
  if (!glyph) return null
  return (
    <svg className="wm-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon={icon}>
      <path d={glyph} fill="currentColor" />
    </svg>
  )
}
