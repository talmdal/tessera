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
  /**
   * Non-interactive only: the statement's amounts look the wrong way round for its account, so it wasn't imported; its
   * warnings say why. Importing a statement whose signs may be wrong is never silent. (Since import-api 1.5.)
   */
  | 'needsConfirmation'

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
  /**
   * Lines dated before the account's last archival date that would have been added: left out, because that period
   * is in an archive file, and they may be transactions an archive removed. (Such a line can still be proposed as a
   * match for a transaction that stayed.) Absent when none, and in batches recorded before archiving existed.
   */
  archived?: number
  /**
   * Lines whose bank id had been used before for a different transaction (dated more than 3 days from what the id named
   * then, or with both another amount and another payee): imported by their content (a fingerprint) instead of being
   * dropped as duplicates. Absent when none. (Since import-api 1.3.)
   */
  idConflicts?: number
  /**
   * Lines that look like transactions already imported from another file (the same amount, dates within 3 days,
   * payees alike, known by other ids): proposed as *Already imported?* on those transactions, and not added. Absent
   * when none. (Since import-api 1.4.)
   */
  alreadyImported?: number
}

/**
 * Which category a new line takes when its file gives one: the file's ('file'), or the payee's usual one, with the
 * file's left unused ('payee'). The user chooses, per source; nothing in a file is used until they have.
 */
export type CategorySource = 'file' | 'payee'

/** A line whose file gives a category, as the Categories from the File dialog shows it. */
export interface CategoryExample {
  /** The payee the new transaction will have. */
  payee: string
  /** The file's category, as the ledger names it: 'Food : Groceries'. */
  file: string
  /** The payee's usual category, when it has one. */
  usual?: string
}

/** What a statement's categories did: present when some of its new lines' file categories name categories the ledger has. */
export interface StatementCategories {
  /** New lines whose file category names a category the ledger has. */
  offered: number
  /** Of those, how many have a different usual category for their payee. */
  differing: number
  /** The rule the new lines followed. */
  source: CategorySource
  /** 'asked': the user answered now; 'remembered': as they answered before for this source; 'default': not asked (a non-interactive import), so the file's weren't used. */
  decidedBy: 'asked' | 'remembered' | 'default'
  /** The answer is kept for the source, so the summary offers to change it. */
  remembered: boolean
  /** The source: its key (`StatementAccount.key`, or the file-name key), and how the file names it. */
  key: string
  sourceLabel: string
  /** A few of the lines, the differing ones first. */
  examples: CategoryExample[]
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
  /** The account's last archival date, when lines dated before it were left out (`counts.archived`). */
  lastArchiveDate?: string
  /** The import's record, for the history and Undo Import. */
  batchId?: string
  /** Present when the file gave categories the ledger has. (Since import-api 1.3.) */
  categories?: StatementCategories
  /**
   * Present when the statement's amounts were reversed: 'asked', by the user's answer now; 'remembered', by a correction
   * kept from an earlier answer. `remembered` says whether the correction is kept for the next file. (Since import-api 1.5.)
   */
  reversed?: { decidedBy: 'asked' | 'remembered', remembered: boolean }
  error?: { code: ImportErrorCode, message: string }
  warnings: string[]
}

/** What an import did, statement by statement. Structured-cloneable: it is the summary dialog's input. */
export interface ImportReport {
  results: StatementReport[]
  /** About the import as a whole, not one statement: an earlier import found interrupted and put right, say. */
  notices?: string[]
}
