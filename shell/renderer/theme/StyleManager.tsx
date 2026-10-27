// shell/renderer/theme/StyleManager.tsx
//
// Applies the mirrored theme to the document: one CSS custom property per
// resolved token on <html> (`--shell-bar-background`), the shell's
// typography variables beside them, `color-scheme` so scrollbars and form
// controls follow, and data attributes for kind-specific CSS. Everything in
// the document, shell or plugin view, reads the colours with var(); nothing
// here injects CSS text. See docs/style-manager-design.md.
import { ReactNode, useLayoutEffect } from 'react'
import { cssVariableFor } from '../../../shared/theme/types'
import { SHELL_TYPOGRAPHY } from '../../../shared/theme/typography'
import { useTheme } from '../state/ShellState'
import './base.css'

export function StyleManager({ children = null }: { children?: ReactNode }) {
  const { activeTheme, kind, colors } = useTheme()

  // A layout effect, so the variables are in place before the browser paints
  // the frame that React just committed.
  useLayoutEffect(() => {
    applyTheme(document.documentElement, { activeTheme, kind, colors })
  }, [activeTheme, kind, colors])

  return <>{children}</>
}

const APPLIED = new WeakMap<HTMLElement, Set<string>>()

/** Writes the theme onto an element, removing the variables of tokens that have gone. */
export function applyTheme(
  root: HTMLElement,
  { activeTheme, kind, colors }: { activeTheme: string, kind: string, colors: Record<string, string> }
) {
  const previous = APPLIED.get(root) ?? new Set<string>()
  const current = new Set<string>()

  const set = (token: string, value: string) => {
    const variable = cssVariableFor(token)
    root.style.setProperty(variable, value)
    current.add(variable)
  }
  for (const [token, value] of Object.entries(SHELL_TYPOGRAPHY)) set(token, value)
  for (const [token, value] of Object.entries(colors)) set(token, value)
  for (const variable of previous) {
    if (!current.has(variable)) root.style.removeProperty(variable)
  }
  APPLIED.set(root, current)

  root.style.colorScheme = kind
  root.dataset.themeId = activeTheme
  root.dataset.themeKind = kind
}
