// Every name the import plugin publishes: ids, services, the extension point, collections, commands, context keys,
// dialogs, IPC channels, events and views, with the arguments and payloads that go with them. Both halves of the
// plugin, format plugins and the tests use these constants, never the strings.
import { channelFor } from '@tessera/types'
import type { Account } from '@tessera/accounts-api'
import type { KeyStrength } from './contract'
import type { CategoryExample, CategorySource, ImportReport } from './manager'
import type { AccountLink, BankLine, MatchCandidate, MatchState } from './model'

export const IMPORT_PLUGIN_ID = 'import'

/** Extension point for `ImportFormatContribution`s. */
export const IMPORT_FORMATS_POINT = 'import.formats'

/** The service other plugins may require to start imports: `ImportManager`. */
export const IMPORT_MANAGER_SERVICE = 'import.manager'

/** The import plugin's `RegisterAnnotator` for `accounts.register.annotations` (the review marks and buttons). */
export const IMPORT_ANNOTATOR_SERVICE = 'import.annotator'

/** The `Migrator` for the import schema, named by its `ledger.schema` contribution. */
export const IMPORT_MIGRATOR_SERVICE = 'import.migrator'

/** Current version of the import schema in a ledger. */
export const IMPORT_SCHEMA_VERSION = 1

/** The import plugin's collections in a ledger. */
export const IMPORT_COLLECTIONS = {
  /** One per statement imported into an account: the file, the counts, and whether it was applied or undone. */
  batches: 'import.batches',
  /** One per bank line that wasn't a duplicate: its import id, the bank's fields, its outcome and review state. */
  lines: 'import.lines',
  /** Saved account matches (`AccountLink`). */
  accountLinks: 'import.accountLinks',
  /** How the bank writes a payee → the user's payee name, learnt on Accept and Change. */
  payeeAliases: 'import.payeeAliases',
  /** Formats' `context.memory`. */
  memory: 'import.memory'
} as const

/**
 * Keys in the import plugin's `context.state` (application state, not ledger data). The store prefixes them with the
 * plugin id, so `lastFolder` is kept as `import.lastFolder` in `app.state`.
 */
export const IMPORT_STATE_KEYS = {
  /** The folder the file dialog showed last. */
  lastFolder: 'lastFolder'
} as const

export const IMPORT_LIMITS = {
  /** Larger files are refused with TOO_LARGE. Bank statements are a few hundred kilobytes. */
  maxFileSize: 25 * 1024 * 1024,
  /** How much of a file `ImportFormat.sniff` is given. */
  sniffBytes: 4096,
  /** How long one file's `parse` may take before it is aborted. */
  parseTimeoutMs: 30_000
} as const

/** The prefix of an import id made from a line's content, when the line has no bank id. */
export const FINGERPRINT_PREFIX = 'fp:'

export const IMPORT_COMMANDS = {
  /** File › Import…. No argument: the files are chosen in the dialog, and the account comes from each statement. */
  file: 'import.file',
  /** The register's Accept button. Argument: `AcceptArgs`. */
  accept: 'import.review.accept',
  /** The review bar's Accept All…. Argument: `AcceptAllArgs`. */
  acceptAll: 'import.review.acceptAll',
  /** The register's Change… button, and Change Match… in an accepted row's menu. Argument: `ChangeArgs`. */
  change: 'import.review.change',
  /** File › Import History (phase 4). */
  showHistory: 'import.history.show',
  /**
   * File › Saved Import Choices…: everything imports remember, in one place: saved account matches, payee names learnt
   * from the bank's text, and each source's file settings and choices. (Since import-api 1.7.)
   */
  manageLinks: 'import.links.manage',
  /** Undo Import…, from the history view (phase 4). Argument: `UndoImportArgs`. */
  undoImport: 'import.batch.undo'
} as const

/** Argument of `import.review.accept`: the bank lines whose rows were accepted. */
export interface AcceptArgs {
  lineIds: string[]
}

/** Argument of `import.review.acceptAll`: every row to review in this account. */
export interface AcceptAllArgs {
  accountId: string
}

/** Argument of `import.review.change`: the bank line of the row. */
export interface ChangeArgs {
  lineId: string
}

/** Argument of `import.batch.undo`. */
export interface UndoImportArgs {
  batchId: string
}

export const IMPORT_CONTEXT_KEYS = {
  /** At least one valid `import.formats` contribution is installed. */
  hasFormats: 'import.hasFormats',
  /** An import is in progress. */
  isRunning: 'import.isRunning'
} as const

export const IMPORT_VIEWS = {
  /** Every import, with Undo Import (phase 4). */
  history: 'import.history'
} as const

/** The import's page in the Options dialog (how closely lines must match): `shell.settings.open` with it shows it. */
export const IMPORT_SETTINGS_PAGE = 'import.settings'

export const IMPORT_DIALOGS = {
  /** Which format reads this file, when more than one could. Input `FormatDialogInput`, result `FormatDialogResult`. */
  format: 'import.dialog.format',
  /** Which account a statement is for. Input `AccountDialogInput`, result `AccountDialogResult`. */
  account: 'import.dialog.account',
  /** Change Match: another transaction, Unmatch, or Don't import. Input `ChangeArgs`, result `MatchDialogResult`. */
  match: 'import.dialog.match',
  /** What an import did. Input `ImportReport`, result `SummaryDialogResult`. */
  summary: 'import.dialog.summary',
  /**
   * Whether new lines take the categories a file gives, for a source that hasn't said. Input `CategoriesDialogInput`,
   * result `CategoriesDialogResult`. (Since import-api 1.3.)
   */
  categories: 'import.dialog.categories',
  /**
   * Whether a statement's amounts are the wrong way round, when the sign cross-check says they may be. Input
   * `SignsDialogInput`, result `SignsDialogResult`. (Since import-api 1.5.)
   */
  signs: 'import.dialog.signs',
  /**
   * Saved Import Choices: saved account matches, payee aliases, and what imports remember about each source. No input,
   * no result: it changes what it shows as the user goes. (Since import-api 1.7.)
   */
  links: 'import.dialog.links'
} as const

/** The Choose Format dialog. */
export interface FormatDialogInput {
  fileName: string
  formats: { id: string, label: string, description?: string }[]
}

export interface FormatDialogResult {
  formatId: string
}

/** An account the Account dialog lists, in the order it ranks them (the best first). */
export interface AccountChoice {
  account: Account
  /** The balance to show, Money-style (`shownBalance`). */
  balance: number
  /** Why it can't be chosen ('Other currency'), or undefined when it can. */
  disabledReason?: string
  /** A note beside it: 'Used last time', 'Account number matches'. */
  hint?: string
}

/** The Account dialog: what the file says, the accounts ranked, and what is chosen to begin with. */
export interface AccountDialogInput {
  fileName: string
  formatLabel: string
  /** Which statement of the file, from 0, and how many it has: titled "Statement 2 of 3" when there are several. */
  statementIndex: number
  statementCount: number
  /** What the file says about the account, for the dialog's second line. */
  statement: {
    label?: string
    institution?: string
    /** Masked for display: '•••• 5678'. */
    accountNumber?: string
    typeLabel?: string
    currency?: string
    lineCount: number
    period?: { from?: string, to?: string }
  }
  /** Open accounts, ranked; closed ones last, shown when "Show closed accounts" is ticked. */
  choices: AccountChoice[]
  /** The account chosen to begin with. */
  preselectedId?: string
  /** Why the dialog appeared despite a saved match: 'Last time this went to “Old Chequing”, which is closed.' */
  note?: string
  /** The checkbox under the list, which depends on the key's strength. */
  remember: {
    strength: KeyStrength
    /** 'Remember this account for “TD Canada Trust •••• 5678”' or 'Don't ask again for files with these columns'. */
    label: string
    /** Ticked to begin with: true for a strong key, false for a weak one. */
    checked: boolean
  }
}

export type AccountDialogResult =
  /**
   * Import into this account. `remember` is the checkbox: for a strong key, save the match (used without asking from
   * then on); for a weak key, the match is saved either way, and `remember` says to use it without asking.
   */
  | { kind: 'account', accountId: string, remember: boolean }
  /**
   * Create a new account: the accounts plugin's New Account dialog opens next, filled in from the statement. `remember`
   * is the checkbox, as for an account chosen (absent: as it started).
   */
  | { kind: 'create', remember?: boolean }
  /** Skip This File: go on to the next file. (Cancel Import closes the dialog with no result.) */
  | { kind: 'skip' }

export type MatchDialogResult =
  /** Match the bank line to this transaction; `rememberPayee` saves a payee alias for the bank's text. */
  | { kind: 'match', transactionId: string, rememberPayee: boolean }
  /** Take the bank line off its transaction, which stays (or goes back to) what it was; the line becomes a new one. */
  | { kind: 'unmatch' }
  /** Don't import this bank line. */
  | { kind: 'skip' }

/**
 * The summary dialog's answer: Review in Register names the account to show; Change… beside a statement's categories
 * names that statement (its index in the report's results), to change the source's answer.
 */
export interface SummaryDialogResult {
  review?: string
  changeCategories?: number
}

/** The Categories from the File dialog: what the file offers, and the question. */
export interface CategoriesDialogInput {
  fileName: string
  /** How the file names its source: 'Maple Chequing'. The answer is remembered for it. */
  sourceLabel: string
  accountName: string
  /** New lines whose file category names a category the ledger has. */
  offered: number
  /** Of those, how many have a different usual category for their payee. */
  differing: number
  examples: CategoryExample[]
  /**
   * Set when changing a remembered answer from the summary: the answer to start from. When asking during an import,
   * nothing is chosen to begin with: the user decides.
   */
  current?: CategorySource
}

/** A line of the statement shown both ways in the Amounts Reversed? dialog. */
export interface SignExample {
  date: string
  payee?: string
  /** As the file has it, in minor units; reversed is its negation. */
  amount: number
}

/** The Amounts Reversed? dialog: why the amounts look the wrong way round, and a line or two both ways. */
export interface SignsDialogInput {
  fileName: string
  accountName: string
  /** The account's type, as the accounts plugin names it: 'Credit card'. */
  accountTypeLabel: string
  currency: string
  /** The register's names for money each way ('Charge' and 'Payment' for a card), for the examples. */
  columns: { decrease: string, increase: string }
  /** Each piece of evidence that points at reversed amounts, in words. */
  reasons: string[]
  /** A line that lowers the balance as read, and one that raises it, when the statement has them. */
  examples: SignExample[]
  /** The checkbox's label: 'Remember for files like this one going into “Visa”'. */
  rememberLabel: string
  /**
   * Set when a correction kept from an earlier answer already reverses this source's files: the amounts shown are after
   * it, and reversing them again takes the correction off.
   */
  correctedSince?: string
}

export interface SignsDialogResult {
  reverse: boolean
  /** Keep the answer for this source's next files. */
  remember: boolean
}

export interface CategoriesDialogResult {
  source: CategorySource
  /** Keep the answer for files from this source. Unticked when changing from the summary: forget it, and ask next time. */
  remember: boolean
}

const channel = (event: string) => channelFor(IMPORT_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `ImportResult`s. */
export const IMPORT_CHANNELS = {
  /** `MatchCandidatesRequest` → `ImportResult<MatchCandidatesResponse>`, for the Change Match dialog. */
  matchCandidates: channel('match.candidates'),
  /** → the imports, newest first, for the history view (phase 4). */
  history: channel('history'),
  /** → `ImportResult<SavedLinks>`: saved account matches, and the accounts they may point at. (Since 1.7.) */
  links: channel('links'),
  /** `LinkUpdateRequest` → `ImportResult<void>`. (Since 1.7.) */
  updateLink: channel('links.update'),
  /** `{ id }` → `ImportResult<void>`. (Since 1.7.) */
  forgetLink: channel('links.forget'),
  /** → `ImportResult<PayeeAliasView[]>`: payee names learnt from the bank's text. (Since 1.7.) */
  aliases: channel('aliases'),
  /** `{ id }` → `ImportResult<void>`. (Since 1.7.) */
  forgetAlias: channel('aliases.forget'),
  /** → `ImportResult<RememberedChoice[]>`: what imports remember about each source, described. (Since 1.7.) */
  remembered: channel('remembered'),
  /** `{ id }` → `ImportResult<void>`: forgets one; the next file from its source is read, or asked about, afresh. (Since 1.7.) */
  forgetRemembered: channel('remembered.forget'),
  /** `RememberedUpdateRequest` → `ImportResult<void>`: a category choice changed in place. (Since 1.7.) */
  updateRemembered: channel('remembered.update')
} as const

/** Push events, main → renderer. */
export const IMPORT_EVENTS = {
  /** `{ accounts: string[] }`: imports into these accounts were added, applied or undone. */
  batches: channel('batches.changed'),
  /** `{}`: saved account matches changed. */
  links: channel('links.changed')
} as const

/** `import:match.candidates`. */
export interface MatchCandidatesRequest {
  lineId: string
  /** Filters by payee text or amount. */
  query?: string
  /** 'window': the matching window (the default); 'wide': ±60 days; 'all': the whole account. */
  range?: 'window' | 'wide' | 'all'
}

export interface MatchCandidatesResponse {
  /** The account the line is in, for its currency and column labels. */
  account: Account
  line: BankLine
  state: MatchState
  /** The transaction the line is proposed for or matched to; for a new row, the transaction it was added as. */
  currentId?: string
  /**
   * Best first. Excludes transactions linked to another bank line or proposed for one, reconciled and voided ones,
   * those of the other sign, and a new row's own transaction. The current proposal or match is included.
   */
  candidates: MatchCandidate[]
  /** The bank's payee text without its noise, as written ('COSTCO WHSE'), for "Remember that … is Costco". */
  bankName?: string
  /** For an accepted match: what Unmatch would put back (only the fields that still hold the bank's values). */
  restores?: { date?: string, amount?: number }
}

/** A saved account match with its account's name, for Saved Import Choices. */
export interface AccountLinkView extends AccountLink {
  accountName: string
  /** The format's label, when it is installed: 'OFX / QFX / QBO statement (…)'. */
  formatLabel?: string
}

/** `import:links`: the saved matches, and the open accounts one may be pointed at. (Since 1.7.) */
export interface SavedLinks {
  links: AccountLinkView[]
  accounts: { id: string, name: string, currency: string }[]
}

/** `import:links.update`: point a match at another account, or switch whether it is used without asking. */
export interface LinkUpdateRequest {
  id: string
  accountId?: string
  autoApply?: boolean
}

/** A payee name learnt from the bank's text, for Saved Import Choices. (Since 1.7.) */
export interface PayeeAliasView {
  id: string
  /** The bank's text, as it is compared (lower case, without store numbers). */
  bankText: string
  payeeName: string
  /** How many imports used it. */
  uses: number
  createdAt: string
}

/** Something imports remember about a source, described, for Saved Import Choices. (Since 1.7.) */
export interface RememberedChoice {
  id: string
  /** What it is: 'CSV columns', 'QIF options', 'Categories from the file', 'Amounts reversed'. */
  what: string
  /** What it is for: a source's name, a file's columns. */
  source: string
  detail?: string
  /** Who keeps it: the format's label, or 'Import' for the import manager's own choices. */
  owner: string
  /** For a category choice, the answer, which can be changed in place. */
  categories?: CategorySource
}

/** `import:remembered.update`: a category choice's new answer. */
export interface RememberedUpdateRequest {
  id: string
  categories: CategorySource
}

/** The summary dialog's input is the report itself. */
export type SummaryDialogInput = ImportReport
