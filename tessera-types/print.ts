// Printing: what the shell offers plugins so every plugin prints the same way.
//
//  - `shell.print` (service): the system's print dialog for a window, and a window printed to a PDF file.
//
// What prints is decided in the renderer, by the shell's print stylesheet: a view that has something to print puts it
// in a print area (`PrintArea` from `@tessera/ui`), and only that prints, in the light variant of the window's theme,
// whatever the window shows; a window with no print area prints its main area's shown view, un-scrolled, without the
// bars. Pages are numbered ("Page 2 of 5"), table headings repeat on each page, and table rows aren't split across
// pages. See docs/reporting-design.md, "Printing and exporting".
import type { DialogTarget } from './dialogs'

/** The service id of `ShellPrint`. The shell provides it before any plugin activates, so `requires` can name it. */
export const SHELL_PRINT_SERVICE = 'shell.print'

/** Paper sizes a PDF is written on. */
export type PaperSize = 'A4' | 'Letter'

export interface PrintOptions extends DialogTarget {
  /** Landscape, as the dialog first offers it; the user can change it there. Default portrait. */
  landscape?: boolean
}

export interface PdfOptions extends DialogTarget {
  /** Where to write it: usually a path `shell.files.showSaveDialog` gave. Written whole or not at all. */
  path: string
  /** Default portrait. */
  landscape?: boolean
  /** Default `paperSize()`: the paper of the user's region. */
  pageSize?: PaperSize
}

/** The `shell.print` service. */
export interface ShellPrint {
  /**
   * Opens the system's print dialog for the window (default: the focused one) and prints what the user confirms.
   * Resolves true once sent to the printer, false if the user cancelled. Rejects when printing failed, saying why.
   */
  print(options?: PrintOptions): Promise<boolean>
  /** Prints the window to a PDF file at `path`, written as `shell.files.writeFile` writes. Rejects saying why not. */
  savePdf(options: PdfOptions): Promise<void>
  /** The paper the user's region uses: Letter in the United States, Canada, Mexico and a few more; A4 elsewhere. */
  paperSize(): PaperSize
}
