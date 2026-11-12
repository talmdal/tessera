// The CSV Columns dialog's input and result, shared by the format (which opens it through `context.prompt`) and the
// dialog. See docs/import-formats-design.md, "The CSV Columns dialog".
import type { DateOrder } from '@tessera/import-api'
import type { CsvLayout } from './layout'
import type { Uncertain } from './guess'

export const LAYOUT_DIALOG = 'import-csv.dialog.layout'

/** Where the layout shown came from: the table in "What the dialog starts from". */
export type LayoutStart =
  /** Remembered, and it reads this file. */
  | 'remembered'
  /** Nothing remembered; the guess is sure of everything. */
  | 'recognised'
  /** Nothing remembered; some of the guess is a guess. */
  | 'guessed'
  /** Remembered, but it doesn't read this file. */
  | 'misfit'
  /** Remembered, and it reads this file once its date order is changed. */
  | 'dateOrderChanged'

export interface LayoutDialogInput {
  fileName: string
  /** The file's text, decoded: the dialog splits it itself, so it can change the separator. */
  text: string
  /** The text is the start of a very long file: the preview's counts are for that part. */
  truncated: boolean
  /** What the dialog starts from. */
  layout: CsvLayout
  start: LayoutStart
  /** The guess's uncertain choices (only when the layout shown is the guess, or the date order was corrected). */
  uncertain: Uncertain[]
  /** When the remembered layout was last used: YYYY-MM-DD. */
  lastUsed?: string
  /** Why the remembered layout doesn't read this file. */
  misfit?: string
  /** The remembered layout's date order, when this file's dates are in another. */
  previousDateOrder?: DateOrder
  /** For two-digit years, as the format reads them. */
  pivot: number
}

export type LayoutDialogResult = { kind: 'layout', layout: CsvLayout } | { kind: 'skip' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** '2026-11-05' → '5 Nov 2026'. */
const inWords = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** The dialog's first line, for where its layout came from. */
export function firstLine(input: Pick<LayoutDialogInput, 'start' | 'lastUsed' | 'misfit' | 'layout' | 'previousDateOrder'>): string {
  switch (input.start) {
    case 'remembered':
      return `Same columns as last time (files like this one${input.lastUsed ? `, last imported ${inWords(input.lastUsed)}` : ''}). Check the preview, then Import.`
    case 'recognised':
      return 'Tessera recognised these columns. Check the preview, then Import: they’ll be remembered for files like this.'
    case 'guessed':
      return 'Tessera guessed these columns. Check the highlighted ones and the preview, then Import: they’ll be remembered for files like this.'
    case 'misfit':
      return `These columns worked last time, but not for this file: ${input.misfit ?? 'its rows can’t be read with them.'} Choose the columns again.`
    case 'dateOrderChanged': {
      const name = { YMD: 'year first', MDY: 'month first', DMY: 'day first' }
      const before = input.previousDateOrder ? `last time they were read ${name[input.previousDateOrder]}` : 'last time they were read differently'
      return `The dates in this file are ${name[input.layout.dateOrder]}; ${before}. Check the preview.`
    }
  }
}
