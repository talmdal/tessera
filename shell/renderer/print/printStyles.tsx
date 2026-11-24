// shell/renderer/print/printStyles.tsx — the print stylesheet: what a window prints, for `shell.print` and the system's
// print dialog alike (docs/reporting-design.md, "Printing and exporting").
//
//  - A view with something to print puts it in a print area (`PrintArea` from `@tessera/ui`), which is drawn off screen
//    at the width of a page; printing, only the print area prints, and nothing else in the window.
//  - With no print area, the main area's shown view prints, without the bars, un-scrolled, less anything a view marks
//    `data-print="hide"`, its text in black (a dark theme's light text would print faint; colours that mean something,
//    a red figure, are a print area's to keep).
//  - Pages are numbered in their bottom margin. Table headings repeat on each page (Chromium's own, for a `thead`), and
//    rows and figures aren't split across pages.
//
// R0 found the stylesheet necessary: without it, Chromium printed one page holding the left bar and 22 of 300 rows (the
// main area scrolls, and only what it shows printed), in a dark theme's black.
export const PRINT_STYLES = `
@media print {
  @page {
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt system-ui, sans-serif; color: #555; }
  }
  html, body, #root { height: auto !important; overflow: visible !important; background: #fff !important; }
  [data-print="hide"] { display: none !important; }
  tr, figure, [role="figure"] { break-inside: avoid; }
  thead { display: table-header-group; }

  /* A print area: it alone prints, in the flow of the page */
  body:has(> [data-print-area]) > :not([data-print-area]) { display: none !important; }
  [data-print-area] { position: static !important; left: auto !important; top: auto !important; width: auto !important; visibility: visible !important; }

  /* No print area: the main area's shown view, un-scrolled, without the bars */
  body:not(:has(> [data-print-area])) [data-layout] { display: block !important; height: auto !important; }
  body:not(:has(> [data-print-area])) [data-layout] > :not([data-region="main"]) { display: none !important; }
  body:not(:has(> [data-print-area])) [data-region="main"] { overflow: visible !important; padding: 0 !important; }
  /* …in dark ink whatever the window's theme: a dark theme's light text would print faint on white paper */
  body:not(:has(> [data-print-area])) [data-region="main"] * { color: #000 !important; }
}
`

/**
 * The print stylesheet, once per window: mounted by the renderer's composition root. A plain style element, not
 * Emotion's global styles, whose parser doesn't keep the page's margin boxes (`@bottom-right` inside `@page`).
 */
export function PrintStyles() {
  return <style data-print-styles>{PRINT_STYLES}</style>
}
