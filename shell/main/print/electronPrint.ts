// shell/main/print/electronPrint.ts — `shell.print` over Electron's `webContents.print` (the system's print dialog) and
// `printToPDF`. What prints is the renderer's business: its print stylesheet prints a view's print area, in light
// colours, with numbered pages (shell/renderer/print/printStyles.ts). Here: which window, the paper, the orientation,
// and the PDF written whole or not at all. See docs/reporting-design.md, "Printing and exporting".
import type { PaperSize, PdfOptions, PrintOptions, ShellPrint } from '@tessera/types'
import { parentWindow } from '../dialogs/electronPrompts'
import { writeFailure } from '../dialogs/writeFile'

/** What printing needs of a window's web contents. */
export interface PrintableContents {
  print(options: Record<string, unknown>, callback: (success: boolean, failureReason: string) => void): void
  printToPDF(options: Record<string, unknown>): Promise<Uint8Array>
}

/** The parts of Electron this needs, so tests can pass fakes. */
export interface PrintPlatform {
  BrowserWindow: {
    getFocusedWindow(): unknown
    fromId(id: number): unknown
    getAllWindows?(): unknown[]
  }
  app: { getLocaleCountryCode(): string }
  /** Writes the PDF whole or not at all: `shell.files.writeFile`. */
  writeFile(path: string, data: Uint8Array): Promise<void>
}

/**
 * Regions that use US Letter (ISO 3166 codes): the United States and its territories, Canada, Mexico, and the Central
 * and South American countries that follow them, and the Philippines. Everywhere else uses A4.
 */
const LETTER_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'CA', 'MX', 'BZ', 'CR', 'GT', 'HN', 'NI', 'PA', 'SV', 'DO', 'VE', 'CO', 'CL', 'PH'])

export const paperFor = (region: string): PaperSize => LETTER_REGIONS.has(region.toUpperCase()) ? 'Letter' : 'A4'

/** What Chromium's print reports when the user closed the dialog without printing. */
const CANCELLED = /cancel/i

function contentsOf(platform: PrintPlatform, options: PrintOptions): PrintableContents {
  const target = parentWindow(platform, options) ?? platform.BrowserWindow.getAllWindows?.()[0]
  const contents = (target as { webContents?: PrintableContents, isDestroyed?(): boolean } | undefined)
  if (!contents?.webContents || contents.isDestroyed?.()) throw new Error('There is no window to print.')
  return contents.webContents
}

export function createElectronPrint(platform: PrintPlatform): ShellPrint {
  const paperSize = () => {
    try { return paperFor(platform.app.getLocaleCountryCode() ?? '') } catch { return 'A4' as const }
  }

  return {
    paperSize,

    async print(options = {}) {
      const contents = contentsOf(platform, options)
      return new Promise<boolean>((resolve, reject) => {
        // Backgrounds aren't printed: paper is white, whatever the theme (the print stylesheet prints light colours)
        contents.print({ silent: false, printBackground: false, landscape: options.landscape === true }, (success, failureReason) => {
          if (success) resolve(true)
          else if (!failureReason || CANCELLED.test(failureReason)) resolve(false)
          else reject(new Error(`The report couldn’t be printed: ${failureReason}.`))
        })
      })
    },

    async savePdf(options: PdfOptions) {
      const contents = contentsOf(platform, options)
      let bytes: Uint8Array
      try {
        // The default margins (about 1 cm) leave room for the page numbers the print stylesheet puts in them
        bytes = await contents.printToPDF({ landscape: options.landscape === true, pageSize: options.pageSize ?? paperSize(), printBackground: false })
      } catch (err) {
        throw writeFailure(err, options.path)
      }
      await platform.writeFile(options.path, bytes)
    }
  }
}
