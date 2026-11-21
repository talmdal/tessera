// The `exchange.service` service: reading a file, filing its statements against accounts, and the pending
// statements the register then reads row by row. Other plugins use this rather than reaching for the formats
// themselves.
//
// `read` → `file` → (per row) `accept` as separate calls is what lets the Statements to Read list and the
// register's provisional rows exist, lets a test drive each stage with a hand-built input, and survives a
// restart: a filed statement is a document in the book, not a plan in memory.
import type { Event, Json } from '@tessera/types'
import type { ExchangeConfirmation } from './errors'
import type { ExchangeFormatDescriptor } from './format'
import type {
  AccountLink, ExchangeChange, ExchangeDocument, ExchangeStatement, ImportBatch, MatchingCandidate,
  LinkPatch, NewPayeeRule, PayeeRule, PendingStatement, PendingSummary, RenamePreview, RowEdit, UndoResult
} from './model'

export interface ReadOptions {
  /** Use this format rather than choosing by extension and sniffing. */
  formatId?: string
  /** Answers to give the reader without asking: a QIF dialect, a date order. */
  answers?: Record<string, Json>
}

/** A document, with what only the reader's caller knows about the file it came from. */
export interface ReadResult {
  /** The path it was read from. Kept by the caller; only `fileName` is ever stored. */
  path: string
  /** The file's own name, without its folder — never the path, which can carry a user's name. */
  fileName: string
  /** SHA-256 of the file's bytes, hex: how a re-import of the identical file is noticed. */
  fileHash: string
  document: ExchangeDocument
}

/** What filing one statement came to. */
export interface FileResult {
  /** The statement as stored, or undefined when every row was already in the book. */
  statement?: PendingStatement
  /** Rows filed to read. */
  filed: number
  /** Rows dropped because their bank reference is already in the account, or already waiting. */
  duplicates: number
}

export interface FileOptions {
  /** Where the document came from: recorded on the pending statement and later on its batch. */
  source: { fileName: string, fileHash: string, formatId: string, dialect?: string }
  /** Remember this source → account link, so the next import of it asks nothing. Default false. */
  remember?: boolean
  /** Payees in the file may be cut at this many characters: the document's `truncatedAt`. */
  truncatedAt?: number
  /** The file's account names → the accounts chosen for them, for transfers between statements of one file. */
  accountMap?: Record<string, string>
  /** Accounts and categories reading this file created, for the batch's undo summary to name. */
  created?: { accounts?: string[], categories?: string[] }
  /**
   * File it even though this file has been imported into this account before. Without it, a file whose bytes
   * match an earlier import is refused with `ALREADY_IMPORTED` so the caller can ask — a bank re-issuing a
   * corrected file is a real thing, and so is pressing Import twice by accident.
   */
  force?: boolean
  /** Import rows dated before the account's opening date after an explicit user confirmation. */
  archivedOverride?: boolean
}

/**
 * Accepting a row that merges into a **reconciled** transaction rewrites a figure the user has already agreed
 * with their bank, so it needs `confirm: ['reconciled']`; without it `accept` fails with
 * `CONFIRMATION_REQUIRED` and writes nothing, and the caller asks.
 */
export interface AcceptOptions {
  confirm?: ExchangeConfirmation[]
}

export interface UndoOptions {
  confirm?: ExchangeConfirmation[]
}

export interface HistoryFilter {
  accountId?: string
  /** Default 50. */
  limit?: number
  /** Default false: batches already taken back out are left out. */
  includeUndone?: boolean
}

/** What to write out. */
export interface ExportRequest {
  scope:
    | { kind: 'account', accountId: string }
    | { kind: 'subBook', subBookId: string, includeDescendants: boolean }
    | { kind: 'book' }
  /** Inclusive; absent means from the beginning / to the end. */
  range?: { from?: string, to?: string }
  formatId: string
  path: string
  /** Default false: voided transactions are excluded, as they are from every balance. */
  includeVoided?: boolean
  /** Default false. */
  clearedOnly?: boolean
  /** Default true for QIF (the receiving program needs them), false for CSV. */
  includeCategories?: boolean
  /** Format-specific: the QIF flavour, the CSV profile, the OFX version. */
  formatOptions?: Json
}

export interface ExportResult {
  path: string
  accounts: number
  transactions: number
  bytes: number
}

export interface PayeeRuleDirectory {
  list(): Promise<PayeeRule[]>
  /** Replaces the whole list, in the order given; `order` is assigned from the position. */
  replace(rules: (NewPayeeRule | PayeeRule)[]): Promise<PayeeRule[]>
  /** Appends rules learned from a review edit. */
  add(rules: NewPayeeRule[]): Promise<PayeeRule[]>
}

/** The `exchange.service` service. Every method fails with NO_BOOK while no book is open. */
export interface ExchangeService {
  /** Every usable format descriptor, in dialog order. Works without a book. */
  formats(): ExchangeFormatDescriptor[]

  /**
   * Reads a file into the neutral model. No book is touched and nothing is matched. The result carries the
   * file's name and hash as well as the document, because `plan` needs both and only the reader's caller has
   * seen the bytes.
   */
  read(path?: string, options?: ReadOptions): Promise<ReadResult>

  /**
   * Files one statement against an account: drops the rows whose bank reference the account (or another pending
   * statement of it) already holds, stores the rest as a `PendingStatement`, and optionally remembers the
   * source → account link. Nothing touches the register until a row is accepted there.
   */
  file(statement: ExchangeStatement, accountId: string, options: FileOptions): Promise<FileResult>

  /**
   * Creates the categories a document carried (a QIF `!Type:Cat` list) that the book does not have yet, so the
   * rows filed from it resolve to them. Resolves the ids created.
   */
  ensureCategories(document: Pick<ExchangeDocument, 'categories'>): Promise<string[]>

  /** The Statements to Read lines: every account with pending rows, plus every remembered source. */
  pendingSummary(): Promise<PendingSummary[]>

  /** The pending statements filed against one account. */
  pendingFor(accountId: string): Promise<PendingStatement[]>

  /**
   * Accepts one pending row: a matched row merges into its register transaction (which adopts the statement's
   * date, amount, payee and reference, and becomes `electronic`); an unmatched row is written as a new
   * transaction. The row leaves the pending statement, and what was written is recorded on the statement's batch.
   */
  accept(accountId: string, statementId: string, rowKey: string, options?: AcceptOptions): Promise<void>

  /**
   * The user's answer from Change Transaction Matching: a transaction id to merge into, or `null` to keep the
   * row unmatched. It wins over the matcher until the row is accepted.
   */
  setMatch(accountId: string, statementId: string, rowKey: string, matchTo: string | null): Promise<void>

  /**
   * The user's own payee and category for one row, from Edit Statement Line, winning over every payee rule.
   * Either field is `null` to clear it and let the rules and the file decide again, and absent to leave it.
   * Renaming happens before matching, so it may change what the row matches.
   */
  editRow(accountId: string, statementId: string, rowKey: string, edit: RowEdit): Promise<void>

  /** What a row would become under a proposed payee, saving nothing: for the rename dialog's live preview. */
  previewRename(accountId: string, statementId: string, rowKey: string, payee: string | null): Promise<RenamePreview>

  /**
   * Puts statement rows aside without importing them: one row, or everything still waiting in the statement
   * when no `rowKey` is given. Resolves how many were put aside, counted on the batch as `skipped`.
   */
  dismiss(accountId: string, statementId: string, rowKey?: string): Promise<number>

  /** Register transactions one pending row could match, nearest first, for Change Transaction Matching. */
  matchingCandidates(accountId: string, statementId: string, rowKey: string): Promise<MatchingCandidate[]>

  /**
   * Takes a whole batch back out: every created transaction deleted, every merged one restored. All or nothing.
   * A batch holding a transaction reconciled or edited since the import fails with CONFIRMATION_REQUIRED and
   * writes nothing; with the confirmation, those go too.
   */
  undo(batchId: string, options?: UndoOptions): Promise<UndoResult>

  /** Past imports, most recent first. */
  history(filter?: HistoryFilter): Promise<ImportBatch[]>

  export(request: ExportRequest): Promise<ExportResult>

  /** The saved source-to-account bindings of this book. */
  links(): Promise<AccountLink[]>
  removeLink(id: string): Promise<void>
  /**
   * Changes a saved source's own settings. A `dateWindow` overrides the option for this source only, because
   * posting lag is the bank's; `null` goes back to the option. Pending statements re-match at once.
   */
  updateLink(id: string, patch: LinkPatch): Promise<AccountLink>

  readonly payeeRules: PayeeRuleDirectory
  readonly onDidChange: Event<ExchangeChange>
}
