// The options the exchange plugin owns, and their defaults. Here rather than in the plugin because the options
// page (renderer) and the pipeline (privileged) must agree on the shape, and because a test wants the defaults
// without activating anything. See docs/import-export-design.md#options.

export interface ExchangeImportOptions {
  /**
   * Days either side for a near match; 0 means same-day only. The default for every source, overridden per
   * account by `AccountLink.dateWindow` where a bank is slower or faster.
   */
  dateWindow: number
  /** Merge a bank row into an uncleared one the user typed, rather than entering it twice. */
  mergeManualEntries: boolean
  /** When merging, take the source's memo and number as well as its reference. */
  adoptBankDetail: boolean
  /** Apply the book's payee rules while planning. */
  applyRules: boolean
  /** Offer “always rename this” after a payee edit. */
  learnRules: boolean
  /** Create the categories a file defines. */
  createCategories: boolean
  /** Refuse a file with more rows than this. */
  maxRows: number
  /** The folder the open dialog starts in; empty means Documents. */
  defaultFolder: string
}

/** The question the QIF reader raises for an ambiguous date order; the `qif.dateOrder` option answers it. */
export const QIF_DATE_ORDER_QUESTION = 'exchange-qif.dateOrder'

export interface ExchangeQifOptions {
  /**
   * How a QIF file's slash dates are read when the file itself does not settle it: `auto` infers from the file
   * and asks when it cannot; `dmy` and `mdy` answer without asking.
   */
  dateOrder: 'auto' | 'dmy' | 'mdy'
}

export interface ExchangeOptions {
  import: ExchangeImportOptions
  history: {
    /** Batches kept per book; older ones are trimmed and can no longer be undone. */
    keep: number
  }
  qif: ExchangeQifOptions
}

export const EXCHANGE_OPTIONS_DEFAULTS: ExchangeOptions = {
  import: {
    dateWindow: 3,
    mergeManualEntries: true,
    adoptBankDetail: false,
    applyRules: true,
    learnRules: true,
    createCategories: true,
    maxRows: 100_000,
    defaultFolder: ''
  },
  history: { keep: 100 },
  qif: { dateOrder: 'auto' }
}

/** How far either side of a row the Change… dialog looks, before the user widens it. Wider than the matcher's. */
export const CANDIDATE_WINDOW_DAYS = 30

/** How many candidates the dialog asks for at a time. */
export const CANDIDATE_LIMIT = 50

/**
 * The shortest prefix that may stand in for a whole payee when matching. A standard-QIF file truncates names to
 * 15 characters, so `Canadian Tire S` must reach `Canadian Tire Store`; 8 is short enough to allow that and long
 * enough that two unrelated merchants rarely collide.
 */
export const MIN_PAYEE_PREFIX = 8

/**
 * The widest matching window, in days either side. Two months: beyond that, an equal amount is more likely a
 * different transaction than a late one. One limit for the option and for every source's own override.
 */
export const MAX_DATE_WINDOW = 60

/** Whether `days` is a usable matching window: a whole number from 0 to `MAX_DATE_WINDOW`. */
export const isDateWindow = (days: unknown): days is number =>
  typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= MAX_DATE_WINDOW

/** Problems in an options value, for `OptionsSpec.validate`. */
export function validateExchangeOptions(value: ExchangeOptions): string[] {
  const problems: string[] = []
  const { dateWindow, maxRows } = value.import
  if (!isDateWindow(dateWindow)) {
    problems.push(`The matching window must be a whole number of days from 0 to ${MAX_DATE_WINDOW}.`)
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) problems.push('The row limit must be at least 1.')
  if (!Number.isInteger(value.history.keep) || value.history.keep < 1) {
    problems.push('Keep at least one import in the history.')
  }
  return problems
}
