// Every name the exchange plugin publishes: ids, collections, commands, context keys, IPC channels, events,
// views and dialogs. Both halves of the plugin, other plugins and the tests use these constants, never strings.
import { channelFor } from '@tessera/types'
import type { Json } from '@tessera/types'
import type { ExchangeConfirmation } from './errors'
import type { ExportOptionField } from './exportOptions'
import type {
  Disposition, ExchangeQuestion, ImportBatch, MatchingCandidate, NewPayeeRule, PayeeRule, RenamePreview
} from './model'
import type { ExportRequest } from './service'

export const EXCHANGE_PLUGIN_ID = 'exchange'

/** The service other plugins require: `ExchangeService`. */
export const EXCHANGE_SERVICE = 'exchange.service'

/** The `Migrator` for the exchange schema, named by its `book.schema` contribution. */
export const EXCHANGE_MIGRATOR_SERVICE = 'exchange.migrator'

/**
 * Current version of the exchange schema in a book. Version 2 added `exchange.pending`; version 3 settles its
 * shape as one document per statement, converting the per-row layout an earlier build of the same feature wrote;
 * version 4 gives each written row its own acceptance time, so undo can tell a row edited since it was imported
 * from one merely accepted later in the same batch.
 */
export const EXCHANGE_SCHEMA_VERSION = 4

/** The collections in a book. */
export const EXCHANGE_COLLECTIONS = {
  batches: 'exchange.batches',
  links: 'exchange.links',
  rules: 'exchange.rules',
  profiles: 'exchange.profiles',
  /** Statements read but not yet gone through in the register: the “statements to read”. */
  pending: 'exchange.pending',
  /**
   * Left by an earlier build of this feature, which kept one document per statement here and one per row in
   * `pending`. Declared so a book carrying it can be opened and converted; the 2 → 3 migration empties it.
   */
  legacyStatements: 'exchange.statements'
} as const

export const EXCHANGE_COMMANDS = {
  /** File ▸ Import Transactions… Reads the file and files its statements to read. */
  import: 'exchange.import',
  /** Argument: `ImportIntoArgs`. The navigator's account context menu. */
  importInto: 'exchange.importInto',
  /** File ▸ Export ▸ Transactions… */
  export: 'exchange.export',
  /** Argument: `ExportAccountArgs`. */
  exportAccount: 'exchange.exportAccount',
  /** File ▸ Import History… */
  history: 'exchange.history',
  /** Argument (optional): `UndoArgs`; else the most recent batch. */
  undo: 'exchange.undo',
  /** File ▸ Payee Rules… */
  rules: 'exchange.rules',
  /** File ▸ Statement Sources…: the book's linked sources, each with its own matching window. */
  sources: 'exchange.sources',
  /** Reveals the Statements to Read view. */
  statements: 'exchange.statements.open',
  /** Argument: `PendingRowArgs`. Accepts one statement row in the register: writes it, or merges its match. */
  accept: 'exchange.accept',
  /** Argument: `PendingRowArgs`. Opens Change Transaction Matching for one statement row. */
  change: 'exchange.change',
  /** Argument: `PendingRowArgs`. Opens Edit Statement Line for one statement row. */
  rename: 'exchange.rename',
  /**
   * Argument: `PendingRowArgs`. Puts one statement row aside without importing it; with `all`, the whole
   * statement. The rows are counted on the batch as `skipped` rather than forgotten.
   */
  skip: 'exchange.skip'
} as const

export interface ImportIntoArgs { accountId: string }
export interface ExportAccountArgs { accountId: string }
export interface UndoArgs { batchId?: string }

/** Argument of `exchange.accept` and `exchange.change`: the register's `OverlayActionArgs`, by shape. */
export interface PendingRowArgs {
  accountId: string
  /** For `exchange.skip`: put the whole statement aside rather than this one row. */
  all?: boolean
  /** The overlay row's key: `<statementId>:<rowKey>`. */
  key: string
}

export const EXCHANGE_CONTEXT_KEYS = {
  /** How many statement rows are waiting to be read, across the book; unset when none. */
  pendingCount: 'exchange.pending.count',
  /** The most recent batch in this book can still be taken back out. */
  canUndo: 'exchange.canUndo',
  /** How many usable formats are installed; 0 greys the import item with a tooltip saying why. */
  formatCount: 'exchange.formats.count',
  /**
   * How many of them can write. Separate from `formatCount` because the two sets differ: QFX and QBO are read
   * but never written, so a build with only those would offer Import and must not offer Export.
   */
  writableFormatCount: 'exchange.formats.writable.count'
} as const

export const EXCHANGE_VIEWS = {
  /** Statements to read: one line per account with downloaded transactions waiting in its register. */
  statements: 'exchange.statements'
} as const

/** What one row of the review is shown as, by disposition. The view and its tests agree on these words. */
export const DISPOSITION_LABELS: Readonly<Record<Disposition, string>> = {
  new: 'New',
  duplicate: 'Already here',
  merge: 'Matches',
  conflict: 'Changed'
}

export const EXCHANGE_DIALOGS = {
  /** Input `ExportDialogInput`, result `ExportDialogResult` (an `ExportRequest` without its path). */
  export: 'exchange.dialog.export',
  /** Choosing or creating the account a statement belongs to. Input `ChooseAccountInput`, result `ChooseAccountResult`. */
  account: 'exchange.dialog.account',
  /** Change Transaction Matching. Input `MatchingDialogInput`, result `MatchingDialogResult`. */
  matching: 'exchange.dialog.matching',
  /** Input `CsvProfileInput`, result a `CsvProfile` as `Json`. */
  csvProfile: 'exchange.dialog.csvProfile',
  /** Input `RulesDialogInput`, result `RulesDialogResult`. */
  rules: 'exchange.dialog.rules',
  /** Statement Sources. Input `SourcesDialogInput`, result `SourcesDialogResult`. */
  sources: 'exchange.dialog.sources',
  /** Edit Statement Line: the payee and the category. Input `RenameDialogInput`, result `RenameDialogResult`. */
  rename: 'exchange.dialog.rename',
  /** Input `HistoryDialogInput`, result `HistoryDialogResult`. */
  history: 'exchange.dialog.history',
  /** A question a reader raised that nothing saved could answer. Input `QuestionDialogInput`, result `Json`. */
  question: 'exchange.dialog.question'
} as const

/**
 * The book's statement sources — each bank file Tessera has been told belongs to an account — for the dialog
 * that sets each one's matching window and can forget a link.
 */
export interface SourcesDialogInput {
  sources: {
    id: string
    /** As the file named the account: 'RBC chequing'. */
    label: string
    accountName: string
    /** The format's own name: 'OFX statement (*.ofx)'. */
    formatLabel: string
    /** The account number as the link holds it, for the dialog to mask. */
    numberKey: string
    lastImportedAt?: string
    /** This source's own window, when it has one. */
    dateWindow?: number
  }[]
  /** The option every source without its own window uses, shown as the placeholder. */
  defaultWindow: number
  maxWindow: number
}

export interface SourcesDialogResult {
  /** Only the sources whose window changed; `null` goes back to the option. */
  windows: { id: string, dateWindow: number | null }[]
  /** Links to forget. The next statement from such a source asks which account it belongs to again. */
  removed: string[]
}

/** The payee rules, for the dialog that edits them. */
export interface RulesDialogInput {
  rules: PayeeRule[]
  /** The book's categories, so a rule can pick one: `Parent : Child`, by id. */
  categories: { id: string, label: string }[]
  /** The book's accounts, so a rule can be scoped to one. */
  accounts: { id: string, name: string }[]
}

/** The whole list as the user left it, in order. `order` is assigned from the position, so it is not sent. */
export interface RulesDialogResult {
  rules: (NewPayeeRule | PayeeRule)[]
}

/**
 * Edit Statement Line: the bank's own text, the name to use, the category, and what the row would become.
 *
 * The preview is the reason this is a dialog rather than an inline edit. Renaming happens before matching, so
 * changing the name can turn a row from new into a merge — a good thing, and exactly what rules are for, but
 * not something to discover after the fact.
 *
 * The category is here because a statement row that matches nothing arrives with none: most bank formats carry
 * no category at all, so without this a new row could only be categorised after it had been accepted. A row
 * that *merges* keeps the register transaction's own category, which is already the user's.
 */
export interface RenameDialogInput {
  /** Which row this is, so the dialog can ask `renamePreview` as the user types. */
  accountId: string
  statementId: string
  rowKey: string
  /** As the file wrote it, never overwritten, so the user can see what the bank actually sent. */
  original: string
  /** The name as it stands: the user's earlier rename, else whatever the rules made of it. */
  payee: string
  /** Whether `payee` came from the user's own earlier rename rather than a rule or the file. */
  renamed: boolean
  /** The category as it stands, when anything chose one. */
  categoryId?: string
  /** The book's categories to choose among: `Parent : Child`, by id. */
  categories: { id: string, label: string }[]
  /** The row as it stands now, before any change. */
  preview: RenamePreview
  /** Whether to offer *Always rename this payee*: the `import.learnRules` option. */
  offerLearning: boolean
  currency: string
  amount: number
  date: string
}

/**
 * What the user changed. A field is **absent** when they left it alone — not resent as it was shown: a name or
 * category a rule produced, sent back unchanged, would be saved as the user's own and stop following the rules.
 */
export interface RenameDialogResult {
  /** The name to use, or `null` to clear the rename and let the rules decide again. */
  payee?: string | null
  /**
   * The category the user chose. Never `null`: a row is without a category only because it arrived that way,
   * and once the user sets it they choose one.
   */
  categoryId?: string
  /** Write a rule so every future row like this one is renamed the same way. */
  always: boolean
}

/**
 * The import history, as the dialog shows it. The batches are already in the order they are listed — most
 * recent first — and carry account names rather than ids, because the dialog has no way to resolve one.
 */
export interface HistoryDialogInput {
  entries: HistoryEntry[]
}

export interface HistoryEntry {
  batch: ImportBatch
  /** The accounts it touched, by name, in the order the batch lists them. */
  accountNames: string[]
  /**
   * Why this import cannot be taken back out, in the user's words, or undefined when it can. Resolved on the
   * privileged side — the renderer cannot ask the register what has happened since.
   */
  blocked?: string
}

/** What the history dialog closes with: the import to take back out, if the user asked for one. */
export interface HistoryDialogResult {
  undo?: string
}

/** What the export dialog needs to offer: what can be written, and what there is to write. */
export interface ExportDialogInput {
  /**
   * The writable format descriptors, in dialog order, each with whatever that format asked to be able to
   * question the user about. `fields` is usually empty — most formats have nothing of their own to ask — and
   * the dialog shows no section for a format that contributed none. See `exportOptions.ts`.
   */
  formats: {
    id: string
    label: string
    extensions: string[]
    multiAccount: boolean
    fields: ExportOptionField[]
  }[]
  accounts: { id: string, name: string, subBookId: string | null, closed?: boolean }[]
  subBooks: { id: string, name: string }[]
  /** Defaulted from the navigator's selection, so the common case is already chosen. */
  scope?: ExportRequest['scope']
  /** Today, as the dialog's ideas of “this year” and “last year” have to agree with the book's clock. */
  today: string
}

/**
 * What the export dialog closes with: an `ExportRequest` bar its path. The path comes from
 * `shell.files.showSaveDialog`, which only the privileged side can open, so the command asks for it after the
 * dialog settles the rest — and a cancelled save dialog abandons the export without having written anything.
 */
export type ExportDialogResult = Omit<ExportRequest, 'path'>

/** The dialog that asks which account a statement belongs to, when nothing saved or printed on it settles it. */
export interface ChooseAccountInput {
  /** The statement's account in the user's words: '“Scotia - CC” ····4512'. */
  statement: string
  fileName: string
  /** The statement's currency, when it names one: accounts in another currency can't take it. */
  currency?: string
  /** The book's accounts, open ones first. */
  accounts: { id: string, name: string, number?: string, currency: string, closed?: boolean }[]
  /** Whether Create a New Account is offered (the accounts plugin's dialog is available). */
  canCreate: boolean
}

export type ChooseAccountResult =
  | { kind: 'existing', accountId: string, remember: boolean }
  /** Open the New Account dialog, prefilled from the statement. */
  | { kind: 'create', remember: boolean }

/** Change Transaction Matching: keep the row unmatched, or match it to one item in the register. */
export interface MatchingDialogInput {
  /** The bank's entry, pinned at the top, as the file wrote it. */
  entry: { date: string, payee?: string, memo?: string, number?: string, amount: number }
  currency: string
  /** Register transactions the row could match, in date order. */
  candidates: MatchingCandidate[]
  /** The current match, when the row has one: “Match this transaction” starts selected with it ticked. */
  currentId?: string
}

export interface MatchingDialogResult {
  /** The transaction to match to, or `null` to keep the row unmatched. */
  matchTo: string | null
}

const channel = (event: string) => channelFor(EXCHANGE_PLUGIN_ID, event)

/** Requests, renderer → main. Replies that can fail because of the user are `ExchangeResult`s. */
export const EXCHANGE_CHANNELS = {
  /** → `ExchangeFormatDescriptor[]`. */
  formats: channel('formats'),
  /** → `PendingSummary[]`: one line per account with statements to read (or a remembered statement source). */
  pendingSummary: channel('pending.summary'),
  /** `{ accountId }` → `OverlayRow[]` (the accounts plugin's shape): the statement rows waiting in that register. */
  pendingRows: channel('pending.rows'),
  /**
   * `RenamePreviewRequest` → `ExchangeResult<RenamePreview>`: what a row would become under a proposed payee.
   * A channel rather than something handed to the dialog up front, because the answer changes with every
   * keystroke — the match depends on the name.
   */
  renamePreview: channel('rename.preview'),
  /** `{ batchId, confirm? }` → `ExchangeResult<UndoResult>`. */
  undo: channel('undo'),
  /** `HistoryFilter` → `ImportBatch[]`. */
  history: channel('history'),
  // There is deliberately no `export` channel. An export writes a file, and where it goes is chosen in the main
  // process by `shell.files.showSaveDialog` — `File ▸ Export Transactions…` does that. A channel taking a path
  // from the renderer would let any renderer code overwrite any file the app can reach.
  /** → `AccountLink[]`. */
  links: channel('links'),
  /** `{ id }` → `ExchangeResult<void>`. */
  removeLink: channel('links.remove'),
  /** → `PayeeRule[]`. */
  rules: channel('rules.list'),
  /** `{ rules }` → `ExchangeResult<PayeeRule[]>`: replaces the whole list, in the order given. */
  saveRules: channel('rules.save')
} as const

/** Push events, main → renderer. */
export const EXCHANGE_EVENTS = {
  /** `ProgressEvent`. */
  progress: channel('progress'),
  /** `{ accounts: string[] }`: the pending statements of these accounts changed — filed, accepted, re-matched. */
  pending: channel('pending.changed'),
  /** `ImportBatch`: rows were written. The registers reload through the accounts plugin's own event. */
  imported: channel('imported'),
  /** `UndoResult`. */
  undone: channel('undone')
} as const

export type ProgressPhase = 'reading' | 'planning' | 'applying'

export interface ProgressEvent {
  phase: ProgressPhase
  done: number
  /** 0 when the total is not yet known; the view shows an indeterminate bar. */
  total: number
}

export interface UndoRequest {
  batchId: string
  confirm?: ExchangeConfirmation[]
}

export interface RenamePreviewRequest {
  accountId: string
  statementId: string
  rowKey: string
  /** The proposed name, or `null` for “no rename, let the rules decide”. */
  payee: string | null
}

/** A question put to the user, when nothing saved could answer it. */
export interface QuestionDialogInput {
  question: ExchangeQuestion
}

export type QuestionDialogResult = Json
