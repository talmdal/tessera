// The `recurring.service` service: the recurring transactions of the open book, and the integrity boundary for
// them. Everything it writes into a register goes through `accounts.service`, so every rule the account manager
// enforces still applies. See docs/recurring-transactions-design.md.
import type { Event } from '@tessera/types'
import type { RecurringConfirmation } from './errors'
import type { Schedule } from './schedule'
import type {
  ForecastEntry, Holiday, Posting, RecurringSnapshot, Series, SeriesKind, SeriesTemplate
} from './model'

export interface WriteOptions {
  /** The write fails with CONFLICT unless the series is still at this revision. */
  expectedRev?: number
  /** Confirmations the caller has obtained from the user. */
  confirm?: RecurringConfirmation[]
}

export interface SeriesFilter {
  accountId?: string
  kinds?: SeriesKind[]
  /** Default false: a paused series is left out of forecasts. */
  includePaused?: boolean
  /** Default false. */
  includeEnded?: boolean
}

/** What the series dialog sends. The service derives `nextIndex`, `nextDate` and the counts. */
export interface SeriesInput {
  accountId: string
  /** Defaults to the payee's name, or the transfer's other account. */
  name?: string
  template: SeriesTemplate
  schedule: Schedule
  /** Default `DEFAULT_REMIND_DAYS`. */
  remindDays?: number
  /** Default false. */
  autoEnter?: boolean
  notes?: string
}

/** An edit: only the fields given change, and `null` clears an optional one. */
export type SeriesPatch = {
  [K in keyof SeriesInput]?: undefined extends SeriesInput[K] ? SeriesInput[K] | null : SeriesInput[K]
}

/**
 * One occurrence to enter, as the enter dialog sends it. Every field but `seriesId` overrides what the series would
 * otherwise produce; the dialog fills them from the occurrence, so they are normally all present.
 */
export interface EnterRequest {
  seriesId: string
  /** Signed, minor units. Defaults to the template's amount. */
  amount?: number
  /** YYYY-MM-DD. Defaults to the occurrence's date — the date the transaction is *for*, never the day it was entered. */
  date?: string
  /** Defaults to the template's number, or the account's next cheque number when `autoNumber` is set. */
  number?: string
  memo?: string
  /** Store `amount` as the series' new estimate (an `estimated` series only). */
  updateEstimate?: boolean
}

export interface EnteredOccurrence {
  seriesId: string
  transactionId: string
  accountId: string
  date: string
  amount: number
}

/** What a bulk entry did. A failure stops neither the rest nor what was already written. */
export interface EnterResult {
  entered: EnteredOccurrence[]
  failed: { seriesId: string, code: string, message: string }[]
}

/** What a committed change touched. Events follow every change, after it is stored. */
export interface RecurringChange {
  created: string[]
  updated: string[]
  deleted: string[]
  /** Accounts whose registers now have a new transaction, so they reload. */
  accounts: string[]
  /** Anything the Recurring view shows changed. */
  snapshot: boolean
  /** The holidays changed, so dates a business-day rule moved may have moved again. */
  holidays?: boolean
}

/** The `recurring.service` service. Every method fails with NO_BOOK while no book is open. */
export interface RecurringService {
  get(id: string): Promise<Series | undefined>
  list(filter?: SeriesFilter): Promise<Series[]>

  /** Everything the Recurring view shows, resolved and sorted ascending by date. */
  snapshot(options?: { includePaused?: boolean, includeEnded?: boolean }): Promise<RecurringSnapshot>

  /**
   * Every occurrence of every matching series in `range`, ascending — not just the first. For a later cash-flow or
   * budget feature. Bounded: `range` may span at most ten years, and the result is capped.
   */
  forecast(range: { from: string, to: string }, filter?: SeriesFilter): Promise<ForecastEntry[]>

  create(input: SeriesInput): Promise<Series>

  /**
   * What a transaction already in a register would make, for prefilling the series dialog: its amount, payee,
   * memo and category or transfer, and the date it is on. A cheque number is deliberately left out — it does not
   * repeat.
   */
  templateFrom(accountId: string, transactionId: string): Promise<{ date: string, template: SeriesTemplate }>

  /**
   * Creates a series and records `source` — a transaction already in a register — as its last entry, so the
   * schedule starts at the first occurrence after it and the register gains no duplicate.
   *
   * `input` is the whole series as the user confirmed it, not as the transaction was: the dialog prefills from
   * `templateFrom` and the user may change any of it before saving.
   */
  createFromTransaction(input: SeriesInput, source: { accountId: string, transactionId: string }): Promise<Series>
  update(id: string, patch: SeriesPatch, options?: WriteOptions): Promise<Series>
  /** The transactions a series has already produced stay in their registers. */
  delete(ids: string[], options?: WriteOptions): Promise<void>
  setPaused(ids: string[], paused: boolean): Promise<void>

  /**
   * Writes each request's occurrence into its account's register and advances its series. Sequential, in ascending
   * date order; partial success is reported rather than rolled back, since rolling back would delete real
   * transactions. So a problem with one occurrence lands in `failed`, not as a rejection: only an empty list, or a
   * confirmation the user has not given yet, rejects.
   */
  enter(requests: EnterRequest[], options?: WriteOptions): Promise<EnterResult>

  /** Advances past the next occurrence (or `count` of them) without writing anything, recording a skipped posting. */
  skip(ids: string[], options?: { count?: number }): Promise<void>

  history(seriesId: string, limit?: number): Promise<Posting[]>

  // ---- The book's holidays, which a business-day rule steps over

  /** Every holiday, ascending by date. */
  holidays(): Promise<Holiday[]>
  /** Adds one. A date that is already a holiday fails with INVALID. Every series' next date is placed again. */
  addHoliday(input: { date: string, name: string }): Promise<Holiday>
  /** Removes one. Every series' next date is placed again. */
  removeHoliday(id: string): Promise<void>

  readonly onDidChange: Event<RecurringChange>
}
