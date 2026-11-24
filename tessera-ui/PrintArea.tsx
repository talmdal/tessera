// What a view prints: its print area. While mounted, the shell's print stylesheet prints it, and nothing else in the
// window (docs/reporting-design.md, "Printing and exporting"). It is drawn off screen, at the width of the page's
// printable part, so what is in it can be measured (a chart draws at its container's width) before printing; and in
// the light variant of the window's theme, so a dark window doesn't print black pages. Mount it when asked to print,
// and unmount it once printed: a report's whole table is drawn here, which it isn't on screen.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Box, ThemeProvider, useTheme, type Theme } from '@mui/material'

/**
 * The light variant of the window's theme, for printing, made when first asked for. Provided by the shell; without it,
 * the window's own.
 */
export const PrintThemeContext = createContext<(() => Theme) | null>(null)

/**
 * The width, in CSS pixels, that fits the printable part of both A4 and US Letter paper with the default margins (about
 * 1 cm): A4 portrait is 718 px across inside them, and Letter landscape 979. Draw a chart at this width to print it.
 */
export const PRINT_WIDTHS = { portrait: 680, landscape: 960 } as const

export interface PrintAreaProps {
  /** The document's title while it is mounted: the print job's name, and a PDF's title. */
  title?: string
  /** The page is landscape: the area is as wide as a landscape page's printable part. Default portrait. */
  landscape?: boolean
  children: ReactNode
}

export function PrintArea({ title, landscape = false, children }: PrintAreaProps) {
  const windowTheme = useTheme<Theme>()
  const make = useContext(PrintThemeContext)
  const printTheme = useMemo(() => make?.() ?? windowTheme, [make, windowTheme])
  // A child of the document's body, as the print stylesheet expects, beside the window's root
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.setAttribute('data-print-area', '')
    // Off screen, yet laid out, so what is in it can measure itself; the print stylesheet puts it back in the page
    Object.assign(element.style, { position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden', pointerEvents: 'none' })
    return element
  })
  // What is in it is drawn once it is in the document, so its own layout effects can measure it
  const [attached, setAttached] = useState(false)
  useLayoutEffect(() => {
    document.body.appendChild(host)
    setAttached(true)
    return () => { host.remove() }
  }, [host])
  useLayoutEffect(() => {
    host.style.width = `${landscape ? PRINT_WIDTHS.landscape : PRINT_WIDTHS.portrait}px`
  }, [host, landscape])
  useEffect(() => {
    if (title === undefined) return
    const before = document.title
    document.title = title
    return () => { document.title = before }
  }, [title])
  if (!attached) return null
  return createPortal(
    <ThemeProvider theme={printTheme}>
      <Box sx={{ color: 'text.primary', typography: 'body2', bgcolor: 'transparent' }}>{children}</Box>
    </ThemeProvider>,
    host
  )
}
