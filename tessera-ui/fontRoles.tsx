import { createContext, useContext } from 'react'
import type { ResolvedFonts } from '@tessera/types'

/** The window's font roles, resolved. Provided by the shell. */
export const FontRolesContext = createContext<ResolvedFonts | null>(null)

/**
 * The fonts each role shows in this window (CSS family, size in px, weight), as data: for what the MUI theme can't
 * style, such as a canvas or a third-party chart. Components should use the theme instead: `variant="numeric"` for
 * amounts, `variant="monospace"` for paths, and the other variants and components, which follow their roles. Read only;
 * fonts are changed by the user (and themes), not by plugins.
 */
export function useFontRoles(): ResolvedFonts {
  const fonts = useContext(FontRolesContext)
  if (!fonts) throw new Error('useFontRoles must be used inside the shell')
  return fonts
}
