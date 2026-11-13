// How a QIF source's files are read, and the QIF Options dialog that asks, shared by the format (which opens it
// through `context.prompt`) and the dialog. The dialog appears only when a file can be read two ways: its dates (every
// day 12 or less) or its decimal separator. Answers are remembered per source; the sign cross-check's reversal is kept
// here too, through `correct`. See docs/import-formats-design.md, "The QIF Options dialog".
import type { DateOrder, DecimalSeparator } from '@tessera/import-api'

export const OPTIONS_DIALOG = 'format-qif.dialog.options'

/** What is remembered for a source: `options:<statement key>` in the format's memory. */
export interface QifOptions {
  dateOrder?: DateOrder
  decimal?: DecimalSeparator
  /** Every amount is negated: the sign cross-check found this source's files the wrong way round. */
  reversed?: boolean
  /** The source's name (the account's, or the file's), for Saved Import Choices. Since F6. */
  label?: string
}

/** A choice the dialog offers, with how it reads the file's own example. */
export interface QifChoice<T> {
  value: T
  /** 'Month/Day/Year: 03/04/26 is Mar 4, 2026'. */
  label: string
}

export interface OptionsDialogInput {
  fileName: string
  /** Asked when the file's dates fit more than one order. `value` is the choice offered first. */
  dates?: { example: string, choices: QifChoice<DateOrder>[], value: DateOrder }
  /** Asked when every amount fits either decimal separator. */
  decimal?: { example: string, choices: QifChoice<DecimalSeparator>[], value: DecimalSeparator }
}

export type OptionsDialogResult =
  | { kind: 'options', dateOrder?: DateOrder, decimal?: DecimalSeparator }
  | { kind: 'skip' }
