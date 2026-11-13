// The recurring domain: a series (a template plus a schedule), what has already been done with it, and what the
// Recurring view shows. Money is integer minor units signed from the account's point of view, and dates are
// 'YYYY-MM-DD', as in @tessera/accounts-api. See docs/recurring-transactions-design.md.
import type { AccountType, CurrencyTotals } from '@tessera/accounts-api'
import { addIsoDays } from './scheduleEngine'
import type { Occurrence, Schedule } from './schedule'

/**
 * How many days before its date an occurrence counts as due soon, unless a series says otherwise. Three days was
 * chosen in review; it becomes a book-wide setting once there are settings (see docs/settings-design.md).
 */
export const DEFAULT_REMIND_DAYS = 3

export const MAX_REMIND_DAYS = 90

export const SERIES_NAME_MAX_LENGTH = 100
export const SERIES_NOTES_MAX_LENGTH = 2000

/** The most entries `forecast` returns, and the longest window it will look over. */
export const MAX_FORECAST_ENTRIES = 5000
export const MAX_FORECAST_YEARS = 10

/** What a series does with money, derived from its template; never stored. */
export type SeriesKind = 'payment' | 'deposit' | 'transfer'

export function seriesKind(template: Pick<SeriesTemplate, 'amount' | 'transferAccountId'>): SeriesKind {
  if (template.transferAccountId !== undefined) return 'transfer'
  return template.amount < 0 ? 'payment' : 'deposit'
}

/** The transaction a series writes. Nearly a `TransactionDraft`: it has no date, which the occurrence supplies. */
export interface SeriesTemplate {
  /** Minor units, signed from the account's point of view: a payment is negative. */
  amount: number
  /** A payee name, as the register takes it: created if new, matched ignoring case. */
  payee?: string
  /** A category, or… */
  categoryId?: string
  /** …the other account of a transfer (not both), as in `TransactionDraft`. */
  transferAccountId?: string
  memo?: string
  /** A fixed number or code, e.g. 'EFT'. Ignored when `autoNumber` is set. */
  number?: string
  /** Take the next cheque number from the account when entering. */
  autoNumber: boolean
  /** The amount varies (a hydro bill); the stored amount is the estimate, and the enter dialog focuses it. */
  estimated: boolean
}

/** Why a series is paused: the user asked, or the plugin paused it because its account went away. */
export type PausedReason = 'user' | 'accountClosed' | 'transferAccountGone'

export interface Series {
  id: string
  /** The account the transaction is written into. */
  accountId: string
  /** What the list shows. Defaults to the payee's name, or the transfer's other account. */
  name: string
  template: SeriesTemplate
  schedule: Schedule
  /** How many days before its date an occurrence counts as due soon. Default `DEFAULT_REMIND_DAYS`. */
  remindDays: number
  /** Enter it without asking when a book opens and it is due. Phase 6; false until then. */
  autoEnter: boolean
  paused: boolean
  pausedReason?: PausedReason
  /** Index of the next occurrence that has been neither entered nor skipped. */
  nextIndex: number
  /**
   * Its date — `occurrenceAt(schedule, nextIndex).date` — or null once the series has ended. Stored, and indexed,
   * only so the list can sort and range-query in the database; it is recomputed, never trusted.
   */
  nextDate: string | null
  lastEnteredDate?: string
  enteredCount: number
  skippedCount: number
  /** The day the end rule was reached. A finished series is kept, greyed, until deleted. */
  endedOn?: string
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}

/** What was done with one occurrence. Never rewritten: it records what the user did, not what survives. */
/** The index given to the transaction a series was made from: it predates occurrence 0, so it has none. */
export const SOURCE_POSTING_INDEX = -1

export interface Posting {
  id: string
  seriesId: string
  accountId: string
  /**
   * The occurrence's index and date, so history survives an edited schedule. `SOURCE_POSTING_INDEX` for the
   * transaction a series was made from, which is not an occurrence of its schedule.
   */
  index: number
  dueDate: string
  outcome: 'entered' | 'skipped'
  /** For 'entered': the transaction `accounts.service` created. It may since have been deleted. */
  transactionId?: string
  /** The date the transaction was given — the date it is *for*, not the day it was entered. */
  date?: string
  /** Minor units, as entered: it can differ from the template for an estimated series. */
  amount?: number
  /** When the user did it, ISO 8601. */
  at: string
}

export type DueState =
  /** Its date is before today: it should have been entered already. */
  | 'overdue'
  | 'dueToday'
  /** Within `remindDays` of today. */
  | 'dueSoon'
  | 'upcoming'
  /** Paused and ended win over the date states: a paused series is never overdue. */
  | 'paused'
  | 'ended'

/** The states a warning is shown for. */
export const LATE_STATES: readonly DueState[] = ['overdue', 'dueToday']

/**
 * Where a series stands against a date. Paused and ended win over the dates: a paused series is never overdue,
 * which is the point of pausing one.
 */
export function dueStateOf(series: Pick<Series, 'paused' | 'nextDate' | 'endedOn' | 'remindDays'>, today: string): DueState {
  if (series.paused) return 'paused'
  if (series.nextDate === null || series.endedOn !== undefined) return 'ended'
  if (series.nextDate < today) return 'overdue'
  if (series.nextDate === today) return 'dueToday'
  return series.nextDate <= addIsoDays(today, Math.max(0, series.remindDays)) ? 'dueSoon' : 'upcoming'
}

/** One series as the Recurring view shows it: its first unentered occurrence, resolved for display. */
export interface RecurringRow {
  series: Series
  kind: SeriesKind
  /** The first occurrence not yet entered or skipped. Absent for an ended series. */
  occurrence?: Occurrence
  state: DueState
  /** Occurrences due on or before today: 1 when it is due today, 3 when two were also missed. */
  dueCount: number
  account: { id: string, name: string, type: AccountType, currency: string, closed: boolean }
  payeeName?: string
  /** `Parent : Child`, or `Transfer to: Savings`, as the register shows it. */
  categoryLabel?: string
  /** `describeSchedule(series.schedule)`. */
  scheduleLabel: string
  /** Why this row can't be entered: a closed account, a missing transfer account. */
  blockedReason?: string
}

export interface RecurringSummary {
  overdueCount: number
  /** Per currency, like `Chart.totals`: a book can hold accounts in several. */
  overdueTotals: CurrencyTotals
  dueSoonCount: number
  dueSoonTotals: CurrencyTotals
  /** Rows with a `blockedReason`. */
  blockedCount: number
}

/** Everything the Recurring view shows. */
export interface RecurringSnapshot {
  /** One row per series, ascending by the occurrence's date; ended and paused series last. */
  rows: RecurringRow[]
  summary: RecurringSummary
  /** The local date the states were computed against. */
  today: string
}

/** One occurrence of one series in a window, for a forecast. */
export interface ForecastEntry {
  seriesId: string
  accountId: string
  name: string
  kind: SeriesKind
  date: string
  /** Signed from `accountId`'s point of view. A transfer's other account receives the opposite. */
  amount: number
  currency: string
  estimated: boolean
  /** For a transfer: the account the opposite amount lands in, so a projection of that account can count it. */
  transferAccountId?: string
}

/** A day the book treats as not a business day, over and above weekends: a business-day rule steps over it. */
export interface Holiday {
  id: string
  /** YYYY-MM-DD. Unique in the book. */
  date: string
  name: string
  rev: number
}

export const HOLIDAY_NAME_MAX_LENGTH = 100

/** How far ahead the register's projected balance and the Upcoming panel look by default. */
export const DEFAULT_HORIZON_DAYS = 30
