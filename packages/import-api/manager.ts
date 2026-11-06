// The `import.manager` service: how other plugins (a bank connection, a Downloads watcher) start an import without
// the menu. Neither method takes an account: as with File › Import…, the statement decides, through a saved account
// match, its account number or the Account dialog (docs/import-manager-design.md, decision 14).
import type { Event } from '@tessera/types'
import type { ImportErrorCode } from './errors'
import type { ParsedStatement } from './contract'

/** A valid format, as the file dialog lists it. */
export interface ImportFormatInfo {
  id: string
  label: string
  extensions: string[]
  description?: string
}

export interface ImportManager {
  /** The valid `import.formats` contributions, in the file dialog's order. */
  formats(): ImportFormatInfo[]
  /**
   * The whole File › Import… flow for these files; asks for files when `paths` is omitted. Resolves undefined if the
   * user cancels the file dialog.
   */
  importFiles(paths?: string[]): Promise<ImportReport | undefined>
  /**
   * Imports statements a plugin already has (from a bank connection, say): account resolution, duplicates, matching
   * and review exactly as for a file. With `interactive: false`, a statement whose account can't be found without
   * asking is reported as 'needsAccount' instead of opening the Account dialog.
   */
  importStatements(statements: ParsedStatement[], source: ImportSource, options?: { interactive?: boolean }): Promise<ImportReport>
  /** After every import, with its report. */
  readonly onDidImport: Event<ImportReport>
}

/** Where statements came from, when not from a file. */
export interface ImportSource {
  /** Shown in the summary and the history: 'TD Canada Trust (connected)'. */
  label: string
  /** The format the statements came through, if any; its contribution's `stableIds` applies. */
  formatId?: string
}

export type StatementOutcome =
  /** Applied: its new lines added, its matches proposed. */
  | 'imported'
  /** The user chose Skip This File, or nothing could be read. */
  | 'skipped'
  /** The user cancelled the import at or before this statement. */
  | 'cancelled'
  /** Something went wrong; `error` says what. Other files and statements still import. */
  | 'failed'
  /** Non-interactive only: no account could be found without asking. */
  | 'needsAccount'

export interface ImportCounts {
  /** Lines in the statement. */
  lines: number
  /** Added as new transactions. */
  added: number
  /** Proposed as matches scoring 0.85 or more. */
  matched: number
  /** Proposed as possible matches (below 0.85). */
  possible: number
  /** Already imported before, or twice in the file. */
  duplicates: number
  /** Left out with a warning (a bad date or amount, a zero amount). */
  invalid: number
}

/** One statement's result. A file with several statements has several. */
export interface StatementReport {
  /** The file's name, or the caller's source label. */
  source: string
  /** Which statement of the source, from 0. */
  statementIndex: number
  /** The account it went into, once known, and its name, for the summary. */
  accountId?: string
  accountName?: string
  outcome: StatementOutcome
  counts: ImportCounts
  /** The import's record, for the history and Undo Import. */
  batchId?: string
  error?: { code: ImportErrorCode, message: string }
  warnings: string[]
}

/** What an import did, statement by statement. Structured-cloneable: it is the summary dialog's input. */
export interface ImportReport {
  results: StatementReport[]
  /** About the import as a whole, not one statement: an earlier import found interrupted and put right, say. */
  notices?: string[]
}
