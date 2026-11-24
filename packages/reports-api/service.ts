// `reports.service`: the reports offered, the open ledger's saved reports, and running either. For other plugins (a
// home widget, a link from the budget view) and for the reports plugin's own views. Every method fails with NO_LEDGER
// while no ledger is open, except `definitions` and `groups`, which don't depend on one.
import type { Event } from '@tessera/types'
import type { ReportResult } from './result'
import type { ScopeValue } from './source'
import type { AsOfValue, CompareValue, OptionValues, PeriodValue, ReportSpec } from './spec'

/** What to run: a definition (offered by a plugin), or one of the ledger's saved reports. */
export type ReportRef = { definitionId: string } | { savedId: string }

/** What the report's heading chose. Ids (of sub-ledgers, accounts, members) may appear here, never in a definition. */
export interface ReportParameters {
  period?: PeriodValue
  asOf?: AsOfValue
  scope?: ScopeValue
  currency?: 'mostUsed' | 'all' | string
  compare?: CompareValue
  /** The source's own parameters (*Budget*). */
  source?: Record<string, string>
  /** The members picked in the heading, by dimension (`ParameterDefaults.choose`): nothing picked means all. */
  chosen?: Record<string, string[]>
}

/** What a saved report is made from: a definition, customised; or (for the report designer) a spec of its own. */
export type SavedBasis =
  | { kind: 'definition', definitionId: string, definitionVersion: number, options: OptionValues }
  | { kind: 'spec', spec: ReportSpec }

/** A report the user kept, in the ledger. */
export interface SavedReport {
  id: string
  name: string
  basis: SavedBasis
  /** As chosen in the heading. A preset period stays a preset. */
  parameters: ReportParameters
  /** What the user chose to see: the chart, the table, or both; which rows were collapsed. */
  view?: { show?: 'chart' | 'table' | 'both', collapsed?: string[] }
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}

/** What saving a report takes. A definition's version is taken from the definition as it is now. */
export interface SavedReportInput {
  name: string
  basis: { kind: 'definition', definitionId: string, options?: OptionValues } | { kind: 'spec', spec: ReportSpec }
  parameters: ReportParameters
  view?: SavedReport['view']
  notes?: string
}

export interface ReportGroupInfo {
  id: string
  label: string
  order: number
}

/** A definition as it is offered. */
export interface ReportDefinitionInfo {
  id: string
  label: string
  description: string
  icon?: string
  order: number
  group: ReportGroupInfo
  /** The plugin that contributed it. */
  contributor: string
  /** Its context-key expression, for the views and menus to follow. */
  when?: string
  /** False while its source's plugin isn't running; `reason` says which plugin it needs. */
  available: boolean
  reason?: string
}

/** What changed: the reports offered or saved (`catalog`), or the figures of reports on some sources (`figures`). */
export interface ReportsChange {
  catalog: boolean
  figures: boolean
  /** With `figures`: the sources whose figures may have changed; every source when absent. */
  sources?: string[]
}

/** The options a definition offers, applied: for a heading, a dialog, or a saved report. Mostly for the views. */
export interface OpenedReport {
  title: string
  /** The spec with the options applied. */
  spec: ReportSpec
  options: OptionValues
  parameters: ReportParameters
  /** Notes about what was dropped opening it (an option the definition no longer offers). */
  notes: string[]
}

export interface WriteOptions {
  /** The write fails with CONFLICT unless the saved report is still at this revision. */
  expectedRev?: number
}

export interface ReportsService {
  /** Every report offered now, validated, ordered by group and order. Doesn't need a ledger. */
  definitions(): ReportDefinitionInfo[]
  /** The groups, ordered. */
  groups(): ReportGroupInfo[]
  /** The open ledger's saved reports, by name. */
  saved(): Promise<SavedReport[]>
  /** A definition or saved report with its options applied and its parameters filled in. */
  open(ref: ReportRef): Promise<OpenedReport>
  /**
   * Runs a report. `parameters` override the definition's defaults (or the saved report's); `options` its option
   * values. Fails with NOT_FOUND (the definition or saved report), NO_SOURCE, INVALID (a parameter, naming it),
   * TOO_LARGE, TIMEOUT or SOURCE_FAILED.
   */
  run(ref: ReportRef, parameters?: ReportParameters, options?: OptionValues): Promise<ReportResult>
  /** A spec that isn't contributed or saved: the designer's preview, and tests. */
  runSpec(spec: ReportSpec, parameters?: ReportParameters, title?: string): Promise<ReportResult>

  /** Saves a new report. DUPLICATE_NAME, NOT_FOUND (its definition), INVALID, READ_ONLY. */
  saveReport(input: SavedReportInput): Promise<SavedReport>
  /** Changes a saved report: its name, basis, parameters, view or notes. */
  updateReport(id: string, patch: Partial<SavedReportInput>, options?: WriteOptions): Promise<SavedReport>
  /** A copy, under a new name. */
  duplicateReport(id: string, name: string): Promise<SavedReport>
  deleteReport(id: string): Promise<void>

  readonly onDidChange: Event<ReportsChange>
}
