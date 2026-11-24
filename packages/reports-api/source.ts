// Data sources: what a plugin contributes to `reports.sources` (a description, as data) and the `ReportSource` service
// behind it, which reads the ledger, applies its rules and answers a query with flat rows. The engine never reads the
// ledger; a source never shapes a table. See docs/reporting-design.md, "The model: sources, definitions, results".
import type { Event } from '@tessera/types'
import type { AccountType } from '@tessera/accounts-api'

/** How a source's figures relate to time. */
export type SourceTime =
  /** Flows between two dates: its time dimension is keyed by month, 'YYYY-MM'. */
  | 'range'
  /** The same, in whole months only (a budget's). */
  | 'months'
  /** How things stood at dates: its time dimension is keyed by date, 'YYYY-MM-DD'. */
  | 'asOf'

export type ScopeKind = 'ledger' | 'subLedger' | 'types' | 'accounts'

/** What a plugin contributes to `reports.sources`. */
export interface ReportSourceContribution {
  /** Starts with the contributing plugin's id: '<pluginId>.<name>'. */
  id: string
  label: string
  description?: string
  /** The `ReportSource` service, looked up when a report on it runs. */
  service: string
  time: SourceTime
  /** The most months (or dates) one query may cover. */
  maxPeriods?: number
  /** Which scopes it takes; 'none' when it has its own (a budget). Default: every kind. */
  scopes?: ScopeKind[] | 'none'
  /** Default true: it reports in one currency, chosen by the user (or each account's own, with a `currency` dimension). */
  currency?: boolean
  /** Parameters of its own, offered in the report's heading. */
  parameters?: SourceParameter[]
  /** It can list the transactions behind a figure (`ReportSource.transactions`). */
  drillDown?: boolean
  fields: ReportField[]
}

/** A parameter of a source's own: its choices come from `members({ parameter })`, or are listed here. */
export interface SourceParameter {
  key: string
  label: string
  kind: 'member' | 'choice'
  choices?: { value: string, label: string }[]
}

export type ReportField = DimensionField | MeasureField

/** A value of an enum dimension, or a top-level member of a signed tree. */
export interface EnumValue {
  id: string
  label: string
  /** +1 or −1, for net rows. */
  sign?: 1 | -1
  /**
   * Under this top member, a negative figure is bad (R5): what is left of an expense budget. Rows beneath it are
   * coloured so; under income, less left than nothing is good news.
   */
  negativeIsBad?: boolean
}

/** Something rows can be grouped by. */
export interface DimensionField {
  kind: 'dimension'
  key: string
  label: string
  /** 'time': the source's dates (months or days); 'member': ids with labels from the source; 'enum': fixed `values`. */
  type: 'time' | 'member' | 'enum'
  /** Members form a tree: rows roll up to a depth. */
  tree?: boolean
  /** Members carry a sign (+1 or −1) for net rows. */
  signed?: boolean
  /** An enum's values; for a signed tree, its top-level members, with their signs. */
  values?: EnumValue[]
  /** The label of a row whose key is null (no payee: "No payee"). Default "(none)". */
  noneLabel?: string
  /** The plural, for *Other*: "Other payees (143)". */
  plural?: string
}

/** Something added up. Figures are integers: minor units, counts, or basis points. */
export interface MeasureField {
  kind: 'measure'
  key: string
  label: string
  /** 'percent' figures are basis points, from the source (a budget's % used). */
  unit: 'money' | 'count' | 'percent'
  /**
   * 'sum' adds, across members and across time; 'last' adds across members and takes the last across time (a
   * balance); 'none': the source gives its totals (`SourceResult.totals`).
   */
  combine: 'sum' | 'last' | 'none'
  /** The dimensions it may be broken down by. Default: every one. */
  dimensions?: string[]
  /** A figure of it is bad when negative (what is owed), for colouring. */
  negativeIsBad?: boolean
  /**
   * False: its figures have no transactions behind them (a budget's plan), so Show Transactions isn't offered on them,
   * even from a source that lists transactions. (R5.)
   */
  drillDown?: boolean
}

/** Which accounts a report covers. As a budget's scope, plus account types and accounts chosen by id. */
export type ScopeValue =
  | { kind: 'ledger' }
  | { kind: 'subLedger', subLedgerId: string }
  /** *Everyday accounts*, or the types named; with a sub-ledger, only there and beneath it. */
  | { kind: 'types', types: AccountType[], subLedgerId?: string }
  /** Chosen by the user: only in parameters, never in a definition. */
  | { kind: 'accounts', accountIds: string[] }

/** A filter on an enum or member dimension. On a tree, a member's descendants match with it. */
export type Filter = { dimension: string, in: string[] } | { dimension: string, notIn: string[] }

/** The dates a query covers: a range (inclusive), or the dates balances are wanted at. */
export type SourcePeriod = { from: string, to: string } | { dates: string[] }

/** What a source is asked. Every id and date is checked by the report manager before the source sees it. */
export interface SourceQuery {
  sourceId: string
  period: SourcePeriod
  /** The accounts covered (absent for a source with scopes 'none'). */
  scope?: ScopeValue
  /** Sub-ledgers side by side: one scope per column, read once. Each row then says which (`scope`, an index). */
  scopes?: ScopeValue[]
  /** The currency figures are in; absent for 'all' (each account's own) and for sources without one. */
  currency?: string
  /** The grain: the dimensions the rows must be keyed by, in this order. */
  dimensions: string[]
  /** The measures the rows' values are, in this order. */
  measures: string[]
  filters: Filter[]
  /** The source's own parameters, by key. */
  parameters: Record<string, string>
}

export interface SourceRow {
  /** In `dimensions` order; null for none (no payee, no category). A time key is 'YYYY-MM' (range) or a date (asOf). */
  keys: (string | null)[]
  /** In `measures` order: integers. */
  values: number[]
  /** The row's currency, when the query's currency was 'all'. */
  currency?: string
  /** The index of its scope in `scopes`, for sub-ledgers side by side. */
  scope?: number
}

/** A member of a dimension: its label, and where it sits. */
export interface Member {
  id: string
  label: string
  /** For a tree: its parent member, or null at the top. */
  parentId?: string | null
  /** +1 or −1, for net rows. */
  sign?: 1 | -1
  /** Where it sorts among its siblings with sort 'natural'. */
  order?: number
  /** For a source parameter's choices: the one a report starts with. */
  isDefault?: boolean
  /** It stands for nothing in particular (Uncategorised): it comes last, and is never gathered into *Other*. */
  none?: boolean
}

export interface ReportNote {
  tone: 'info' | 'warning'
  text: string
}

export interface SourceResult {
  rows: SourceRow[]
  /** The members of each member dimension that appear (and their ancestors), with labels, trees and signs. */
  members: Record<string, Member[]>
  /** For measures with combine 'none': the source's totals, by rolled-up key ('' for the grand total), in `measures` order. */
  totals?: Record<string, number[]>
  notes: ReportNote[]
  /**
   * What the figures are of, for a source with a scope of its own (R5): "Household · Personal and its sub-ledgers". The
   * report's subtitle says it where it would name the accounts.
   */
  subject?: string
  /** The currency of a source with a currency of its own (`currency: false`: a budget's), for the figures. (R5.) */
  currency?: string
}

/** For pickers and labels: a dimension's members, or one of the source's parameters' choices. */
export interface MembersRequest {
  sourceId: string
  dimension?: string
  parameter?: string
  scope?: ScopeValue
  parameters: Record<string, string>
}

/**
 * What one figure of a result stands for, in the source's terms: for each dimension named, the keys a transaction must
 * have one of (null: none, as *Uncategorised*). On a tree, a key takes in its descendants, except in the dimensions
 * listed in `own` (what a parent holds of its own: "Food (other)"). A dimension not named is any. (Since 1.1: 1.0's
 * one key per dimension couldn't say what *Other* gathers, and nothing produced one.)
 */
export interface DrillKey {
  keys: Record<string, (string | null)[]>
  own?: string[]
  /**
   * A net (*Net income*): the dimension whose members' signs (+1 income, −1 expenses) each transaction's part is
   * multiplied by, so the list adds up to the net.
   */
  signed?: string
}

/**
 * What Show Transactions asks a source: the run's query (its scope, currency, filters and parameters) over the figure's
 * period, and the figure's keys. One scope: a sub-ledger column's own, side by side.
 */
export interface DrillRequest extends Omit<SourceQuery, 'dimensions' | 'measures' | 'scopes'> {
  key: DrillKey
  /** The measure the figure is of: each transaction is listed with its part of it (a count lists the net amounts). */
  measure: string
  /** The most transactions to list; `total` says how many there are. */
  limit: number
}

export interface DrillResult {
  /** In date order; `amount` is the transaction's part of the figure. */
  transactions: {
    id: string, accountId: string, accountName: string, date: string, amount: number,
    payee?: string, label?: string, currency: string
  }[]
  /** How many there are in all: more than `transactions` when the limit was reached. */
  total: number
  /** The part of the figure that archived transactions make up, which can't be listed. */
  archived?: { amount: number, before: string }
}

/** The service behind a source. It runs in the main process. */
export interface ReportSource {
  query(request: SourceQuery): Promise<SourceResult>
  /** A dimension's members, or a parameter's choices: for pickers, labels and filters. */
  members(request: MembersRequest): Promise<Member[]>
  /** The transactions behind a figure; only when the contribution says `drillDown`. */
  transactions?(request: DrillRequest): Promise<DrillResult>
  /** Anything the source reports on changed: shown reports on it refresh. */
  readonly onDidChange?: Event<void>
}
