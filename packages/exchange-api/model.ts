// The neutral model every format reader produces and every writer consumes, and the documents the `exchange`
// plugin keeps in a book. Money is integer minor units, dates are 'YYYY-MM-DD'. See docs/import-export-design.md.
import type { Json } from '@tessera/types'
import type { AccountType, ClearingStatus, Transaction, TransactionDraft } from '@tessera/accounts-api'

// ---- What a file turned into -----------------------------------------------------------------

/** One file, read. It may describe several accounts: a whole-book QIF does. */
export interface ExchangeDocument {
  /** The descriptor that read it, e.g. 'exchange-ofx.qbo'. */
  formatId: string
  /** What the reader concluded about the file, shown in the review header: 'QIF (Microsoft dialect)'. */
  dialect?: string
  /** The institution, where the file names one. */
  institution?: { name?: string, id?: string, bankId?: string }
  /** When the file was produced, if it says: an ISO timestamp. */
  generatedAt?: string
  statements: ExchangeStatement[]
  /** Category definitions the file carried (a QIF `!Type:Cat` list). Created on apply only if the user allows it. */
  categories?: { path: string, kind: 'income' | 'expense' }[]
  /** Records recognised but not representable: investments, budgets, memorised transactions. Never silent. */
  unsupported: UnsupportedRecords[]
  /** Problems that did not stop the read: a malformed row, an unparsable date. */
  warnings: ExchangeWarning[]
  /**
   * Payees in this file may have been cut short at this many characters (standard QIF: fifteen), so the matcher
   * compares them by prefix rather than equality. Absent when names are whole.
   */
  truncatedAt?: number
}

export interface UnsupportedRecords {
  /** 'investment', 'budget', 'memorised', 'foreignCurrency'. */
  kind: string
  count: number
  /** A sentence for the review banner: 'Tessera has no investment accounts yet.' */
  detail?: string
}

/** One account's worth of a file. Every field of `account` is optional, because formats vary. */
export interface ExchangeStatement {
  account: {
    /** OFX ACCTID, a QIF `!Account` N line, a CSV column. As printed, not normalised. */
    number?: string
    /** OFX BANKID / routing number. */
    bankId?: string
    name?: string
    /** Mapped onto an `AccountType` where the file is clear enough; else undefined. */
    type?: AccountType
    /** ISO 4217, from OFX CURDEF or a CSV column. Undefined means “ask”. */
    currency?: string
    /** The file's own type word, verbatim, for diagnostics. */
    rawType?: string
  }
  /** The period the file covers, where it says. */
  period?: { from?: string, to?: string }
  /** Minor units, signed like a Tessera balance. */
  balances?: {
    ledger?: { amount: number, asOf: string }
    available?: { amount: number, asOf: string }
  }
  transactions: ExchangeTransaction[]
}

/** How a source says a row was cleared. OFX says nothing; QIF has a `C` field. */
export type ExchangeCleared = 'cleared' | 'reconciled'

export interface ExchangeTransaction {
  /** YYYY-MM-DD, already normalised by the reader. */
  date: string
  /** The date the bank says the money moved, where the format distinguishes it. Shown, never matched on. */
  postedDate?: string
  /** Minor units, signed from the account's point of view: positive raises its balance. */
  amount: number
  /**
   * ISO 4217, only when the row is in a currency of its own (OFX `<CURRENCY>`), which is the multi-currency case
   * this release does not handle. A row the bank already converted (OFX `<ORIGCURRENCY>`) leaves this unset and
   * puts the original in `originalAmount`. See docs/import-export-design.md#currencies.
   */
  currency?: string
  /** What the row was originally in, when the bank converted it for us. Shown; never used in a balance. */
  originalAmount?: { amount: number, currency: string }
  /** The source's id for the row: an OFX FITID. Absent for QIF and most CSV. */
  externalId?: string
  /** OFX CORRECTFITID + CORRECTACTION: this row replaces or deletes an earlier one. */
  corrects?: { externalId: string, action: 'replace' | 'delete' }
  /** As the file wrote it, before any payee rule. Both are kept: renaming happens in the pipeline, not the reader. */
  payee?: string
  memo?: string
  /** A cheque number or the source's reference. */
  number?: string
  /** A category path the file named, `Parent : Child`. */
  category?: string
  /** A transfer the file named, by the account's name *in the file* (QIF `L[Savings]`). */
  transferAccount?: string
  /** Split lines, summing to `amount`. Parked until `Transaction.splits` is real. */
  splits?: ExchangeSplit[]
  /** What the file said the clearing state was. */
  cleared?: ExchangeCleared
  /** The format's own type word (OFX TRNTYPE, a CSV column). Shown in the review; used for nothing else. */
  kind?: string
  /** Where in the file this came from, for a warning the user can act on. */
  source?: { line?: number, record?: number }
}

export interface ExchangeSplit {
  amount: number
  category?: string
  memo?: string
  transferAccount?: string
}

export interface ExchangeWarning {
  /** 'date.unparsable', 'amount.unparsable', 'record.malformed', 'encoding.replaced', 'externalId.duplicate'. */
  code: string
  message: string
  source?: { line?: number, record?: number }
}

// ---- What the pipeline proposes --------------------------------------------------------------

/**
 * What the matcher concluded about one incoming row. A proposal only: nothing is written until the user accepts
 * it, and `Change…` may replace the match entirely.
 */
export type Disposition =
  /** Nothing in the book looks like this. */
  | 'new'
  /** The same `externalId` is already in this account. Cannot be written; accepting it only acknowledges it. */
  | 'duplicate'
  /** An existing uncleared row is almost certainly this one; writing it updates that row. */
  | 'merge'
  /** Same `externalId`, different amount or date: the source restated it. */
  | 'conflict'

/** How a row reached its disposition. `user` rows survive a re-plan untouched. */
export type MatchedBy = 'externalId' | 'heuristic' | 'none' | 'user'

/** A draft as an import writes it: the account manager's draft, with the source's reference. */
export type ImportDraft = TransactionDraft & { externalId?: string }

/** How a statement's account was settled. */
export type AccountMatchedBy = 'link' | 'number' | 'name' | 'user'

/** Enough to prefill the account dialog from a statement. The real `AccountInput` is the accounts plugin's. */
export interface AccountCreationInput {
  name: string
  type: AccountType
  subBookId: string | null
  currency: string
  institution?: string
  /** The statement's `BANKID` — a routing or transit number — so an export can write it back. */
  routingNumber?: string
  accountNumber?: string
  openingDate: string
  /** The statement's ledger balance less the sum of its transactions, so the balance afterwards is the bank's. */
  openingBalance: number
}

// ---- Statements to read ------------------------------------------------------------------------

/**
 * A statement read and filed against an account, waiting to be gone through in that account's register. This is
 * the document behind both the Statements to Read view and the register's provisional rows. A row leaves it when
 * it is accepted; a statement with no rows left is deleted.
 */
export interface PendingStatement {
  id: string
  accountId: string
  /** When the file was read: an ISO timestamp. The “Last Downloaded” column. */
  readAt: string
  formatId: string
  dialect?: string
  /** The file's base name only — never its path. */
  fileName: string
  /** SHA-256 of the file's bytes, so re-reading the identical file is noticed. */
  fileHash: string
  /** What the file said about the account, as printed, for display and the saved link. */
  source: { number?: string, bankId?: string, name?: string }
  period?: { from?: string, to?: string }
  /** The statement's ledger balance, when the file carried one. The “Bank Balance” column. */
  ledger?: { amount: number, asOf: string }
  rows: PendingRow[]
  /** The batch recording what accepting this statement's rows wrote, once the first row was accepted. */
  batchId?: string
  /** Payees may be cut at this many characters (standard QIF), so matching compares them by prefix. */
  truncatedAt?: number
  /**
   * The file's own account names mapped to the accounts the user chose for them, so a transfer the file wrote
   * as `[Savings]` reaches the right account even when the book calls it something else.
   */
  accountMap?: Record<string, string>
  /**
   * Accounts and categories that reading this file brought into being. Recorded here because they are created
   * while the file is being filed, before any row is accepted and so before the batch exists — the batch takes
   * them when it opens, so Undo Import can say what it is leaving behind.
   */
  created?: { accounts?: string[], categories?: string[] }
  rev: number
}

/** One downloaded transaction waiting to be read. The matcher's proposal is recomputed; this is what persists. */
export interface PendingRow {
  /** Stable within the statement. */
  key: string
  transaction: ExchangeTransaction
  /**
   * The user's decision from Change Transaction Matching, winning over the matcher: a transaction id to merge
   * into, or `null` for “keep this transaction unmatched”. Absent: the matcher proposes.
   */
  userMatch?: string | null
  /**
   * The user's own rename of this row, from Rename Payee…, winning over every rule. Absent: the book's rules
   * decide, and failing those the file's own text stands.
   *
   * Kept on the row rather than written straight into `transaction.payee` so that what the bank actually sent
   * is never lost — the rename dialog shows it, and a learned rule is derived from it.
   */
  userPayee?: string
  /**
   * The category the user picked for this row, winning over any a rule or the file chose.
   *
   * It applies to a row written as **new**. A row that merges takes the register transaction's own category,
   * which is already the user's and which an import has no business overwriting — see `mergeInto`.
   */
  userCategoryId?: string
}

/**
 * A change the user made to one pending row in Edit Statement Line. Each field is `null` to clear the user's
 * own choice and let the rules and the file decide again, and **absent** to leave it as it is — the two are
 * different, and collapsing them would make clearing a payee indistinguishable from not mentioning it.
 */
export interface RowEdit {
  payee?: string | null
  categoryId?: string | null
}

/**
 * What a row would become under a proposed payee: the name, and the match it would then have. Because renaming
 * happens before matching, a rename can turn a row from new into a merge — so the dialog shows this while the
 * user is still typing rather than letting the disposition move behind them.
 */
export interface RenamePreview {
  payee?: string
  disposition: Disposition
  /** The row's note as the register would draw it: 'New', 'Matches 3 Nov'. */
  note: string
  matchedId?: string
  /** The register transaction it would merge into, for the dialog to show. */
  matches?: { date: string, amount: number, payee?: string }
}

/** One line of the Statements to Read view. */
export interface PendingSummary {
  accountId: string
  accountName: string
  currency: string
  /** Statement rows waiting in this account's register. */
  items: number
  /** The newest statement's `readAt`; absent for a linked source with nothing waiting. */
  lastReadAt?: string
  /** The newest statement's ledger balance, when one carried it. */
  bankBalance?: number
  /** The account's current register balance. */
  localBalance: number
}

/** A register transaction as Change Transaction Matching lists it. */
export interface MatchingCandidate {
  id: string
  date: string
  number?: string
  payee?: string
  categoryLabel?: string
  amount: number
  status: ClearingStatus
  /** Choosing it needs care: it is reconciled. */
  caution?: 'reconciled'
}

/** One transaction in the book, as the review shows it beside a statement line. */
export interface RegisterLine {
  id: string
  date: string
  number?: string
  amount: number
  /** The payee's name, resolved. */
  payee?: string
  memo?: string
  categoryId?: string
  transferAccountId?: string
  status: ClearingStatus
  /** The bank's reference, when an earlier import gave it one. */
  externalId?: string
}

export interface MatchCandidate {
  transaction: Transaction
  /** The transaction's payee, by name: `transaction` holds only its id. */
  payee?: string
  /** 0–1, for ordering. The dialog shows the reason, not the number. */
  score: number
  /** 'Same amount, 2 days earlier', 'Same cheque number', 'Same amount'. */
  reason: string
  /** This is the row's current match. */
  current?: boolean
  /** Accepting this one needs care: it is reconciled, or its amount differs from the statement's. */
  caution?: 'reconciled' | 'amountDiffers'
}

// ---- Questions a reader cannot answer for itself ----------------------------------------------

/**
 * Something the reader needs and cannot infer — a QIF dialect, a date order, a currency. It asks through
 * `ReadContext.request`; `exchange` answers from an option, a saved profile, or the user. This is what keeps a
 * reader a pure function of (bytes, answers) with no knowledge of dialogs.
 */
export type ExchangeQuestion =
  | { kind: 'choice', id: string, title: string, detail?: string, options: QuestionOption[], suggested?: Json }
  | { kind: 'csvProfile', id: string, title: string, detail?: string, sample: string[][], suggested?: Json }
  | { kind: 'currency', id: string, title: string, detail?: string, suggested?: string }
  /** Raised by the pipeline, not a reader: which account this statement belongs to. */
  | { kind: 'account', id: string, title: string, detail?: string, statementIndex: number, suggested?: string }

export interface QuestionOption {
  value: Json
  label: string
  detail?: string
}

// ---- What a book remembers ---------------------------------------------------------------------

/** A statement source bound to an account, with the quirks settled the first time it was imported. */
export interface AccountLink {
  id: string
  formatId: string
  bankId?: string
  /** The account number, normalised: no spaces, dashes or case. */
  numberKey: string
  accountId: string
  /** Shown in the review header: 'RBC chequing (QFX)'. */
  label: string
  /** Answers this source needed once and should not be asked again. */
  answers?: Record<string, Json>
  /** This source's sign convention, settled the first time. */
  signs?: 'asGiven' | 'invert' | 'fromType'
  /** How many days this bank takes to post. Overrides the option, because posting lag varies by bank. */
  dateWindow?: number
  lastImportedAt?: string
  rev: number
}

/**
 * A change to a saved source, from Statement Sources. `dateWindow: null` drops the source's own window and goes
 * back to the option; absent leaves it as it is.
 */
export interface LinkPatch {
  dateWindow?: number | null
}

export type PayeeRuleMatchKind = 'contains' | 'startsWith' | 'equals' | 'regex'

/** Turns a bank's payee string into one a person wants in their register, and optionally picks the category. */
export interface PayeeRule {
  id: string
  /** Lower first; the first match wins. */
  order: number
  match: {
    /** Tested against the file's payee, then its memo. */
    kind: PayeeRuleMatchKind
    value: string
    /** Default true. */
    ignoreCase?: boolean
  }
  /** The payee to use. With a regex, `$1` and friends are substituted. */
  payee: string
  /** Also set this category, when the transaction has none. */
  categoryId?: string
  /** Only in this account; absent means every account. */
  accountId?: string
  /** False while the user has switched it off, without deleting it. */
  enabled: boolean
  /** Written by “always rename this”; shown differently in the list. */
  learned?: boolean
  rev: number
}

export type NewPayeeRule = Omit<PayeeRule, 'id' | 'rev'>

/** A saved answer set for a source whose shape is recognisable: a CSV header, a QIF dialect. */
export interface FormatProfile {
  id: string
  formatId: string
  /** What identifies this file shape: a hash of a CSV's normalised header names, say. */
  fingerprint: string
  name: string
  /**
   * The answers this shape settled, as a list rather than a map keyed by question id. Storage forbids a dot in
   * a field name and every question id has one (`exchange-csv.profile:…`), so a map here cannot be written at
   * all — and failing to save would mean asking the user the same question every month forever.
   */
  answers: SavedAnswer[]
  rev: number
}

export interface SavedAnswer {
  questionId: string
  value: Json
}

/** One import, recorded so that it can be described, listed and taken back out. */
export interface ImportBatch {
  id: string
  /**
   * When the batch began — the moment its first row was accepted — and never rewritten afterwards. A batch is
   * open for as long as its statement has rows left, so this is the date the history shows and orders by: the
   * import the user started, not the last time they touched it.
   */
  importedAt: string
  /**
   * When its most recent row was accepted. Equal to `importedAt` for a statement read in one sitting, later
   * for one read over several. Kept apart from `importedAt` so neither has to mean both.
   */
  lastAcceptedAt: string
  /** Set when the statement this came from has no rows left: every row was accepted, so nothing more can join. */
  closedAt?: string
  formatId: string
  dialect?: string
  /** The file's base name only — never its path. */
  fileName: string
  /** SHA-256 of the file's bytes. */
  fileHash: string
  accountIds: string[]
  /**
   * Transactions this import created, grouped by the account they went into — undo needs the account to reach
   * a transaction, since the account manager scopes every write to one.
   */
  created: CreatedRecord[]
  /** Transactions it merged into: the id, and the fields it changed, so undo can restore them exactly. */
  merged: MergedRecord[]
  /** Accounts and categories it created, for the undo summary. They are not removed by an undo. */
  createdAccounts: string[]
  createdCategories: string[]
  /**
   * `read` is every row in the file. `imported` and `merged` are what was written. `duplicates` were already
   * here. `skipped` is what the user did not accept, which is worth recording: a statement imported with twelve
   * rows left behind is a different event from one imported whole.
   */
  counts: {
    read: number
    imported: number
    merged: number
    duplicates: number
    skipped: number
    unsupported: number
  }
  /** How many rows the user matched by hand. The measurement that should drive changing the matcher. */
  manualMatches: number
  /** Set once the batch has been taken back out. */
  undoneAt?: string
  /**
   * An undo in progress: what it has done so far, and what it would take to put each step back. Written after
   * every step, so that an undo which fails part-way — or a process that dies during one — can be backed out
   * to the batch's imported state rather than leaving the book half-reversed. Absent when no undo is running.
   */
  undoing?: UndoJournal
  rev: number
}

/** The steps an undo has taken so far, in order, each with what puts it back. See `ImportBatch.undoing`. */
export interface UndoJournal {
  startedAt: string
  /** Merged transactions already put back as they were before the import, with how the import had left them. */
  restored: { accountId: string, id: string, imported: MergedBefore }[]
  /** Created transactions already taken out, with enough to write each back. */
  removed: { accountId: string, rows: RemovedTransaction[] }[]
}

/** A transaction an undo deleted, as a draft that writes it back. It gets a new id when it is. */
export interface RemovedTransaction {
  /** The id it had, so the batch can be pointed at the transaction that replaces it. */
  id: string
  /** When the import accepted it, carried over to the replacement. */
  at: string
  draft: {
    date: string
    amount: number
    number?: string
    payee?: string
    memo?: string
    categoryId?: string
    transferAccountId?: string
    status: Transaction['status']
    externalId?: string
  }
  voided: boolean
}

/**
 * One transaction a batch wrote, and **when**. The time is per row rather than per batch because a batch is
 * accreted over however long the user takes to read the statement: a row accepted on Monday, edited by hand on
 * Tuesday and sitting in a batch whose last row was accepted on Wednesday has still been edited since *it* was
 * imported, and undo has to notice. A single `importedAt` cannot answer that for every row at once — see
 * `undoObstacles`.
 */
export interface AcceptedRow {
  id: string
  /** When this row was accepted: an ISO timestamp. */
  at: string
}

export interface CreatedRecord {
  accountId: string
  rows: AcceptedRow[]
}

export interface MergedRecord {
  accountId: string
  id: string
  /** When this merge was written, for the same reason `AcceptedRow` carries one. */
  at: string
  /** The fields as they were before the import changed them, so undo can put them back exactly. */
  before: MergedBefore
}

/**
 * The fields a merge may change. `null` means “it had none”, so undo removes what the import added.
 *
 * A merge never touches the date, the category or the payee — those are the user's — so they are not here.
 * `amount` appears only when the user ticked *use the statement's amount* in the Change… dialog.
 */
export interface MergedBefore {
  status: Transaction['status']
  externalId?: string | null
  memo?: string | null
  number?: string | null
  amount?: number
  date?: string
  /** By name; `null` when it had none. */
  payee?: string | null
  /**
   * Whether it was voided, recorded when the source withdrew the transaction (OFX `CORRECTACTION` DELETE) and
   * the merge voided it. Without it, undoing that import put the status back but left the row voided.
   */
  voided?: boolean
}

export interface UndoResult {
  batchId: string
  /** Transactions deleted. */
  removed: number
  /** Transactions put back as they were. */
  restored: number
  /** Accounts and categories the import created and this undo kept, by name, for the message. */
  kept: { accounts: string[], categories: string[] }
}

/**
 * What an import managed to write before something refused it. The pipeline records the batch anyway, so that
 * what did land can be taken straight back out — see `ExchangeError` code `INVALID` with this attached.
 */
export interface PartialImport {
  batchId: string
  written: number
}

/** What a committed change touched. Events follow every change, after it is stored. */
export interface ExchangeChange {
  /** Batches written or undone. */
  batches: string[]
  /** Accounts whose transactions an import or undo changed. */
  accounts: string[]
  /** Accounts whose pending statements changed — filed, re-matched, accepted. */
  pending: string[]
  rules: boolean
  links: boolean
  profiles: boolean
}
