// The contract between the import manager and format plugins: the `import.formats` contribution (plain data), the
// `ImportFormat` service a format plugin provides, and the neutral statement it produces. A format plugin turns bytes
// into statements and nothing else: the import manager finds the account, drops duplicates, matches and applies.
// See docs/import-manager-design.md, "The import.formats extension point".
import type { Logger } from '@tessera/types'
import type { AccountType } from '@tessera/accounts-api'

/**
 * A file type a plugin can read, contributed as plain data:
 * `context.extensions.contribute(pluginId, IMPORT_FORMATS_POINT, contribution.id, contribution)`.
 * Its behaviour is the `ImportFormat` service named by `service`, provided by the same plugin.
 */
export interface ImportFormatContribution {
  /** `<pluginId>.<name>`, e.g. 'import-ofx.ofx'. */
  id: string
  /** The file dialog's filter name: 'OFX / QFX statement (Microsoft Money, Quicken)'. */
  label: string
  /** Without dots, lower case: ['ofx', 'qfx']. At least one. */
  extensions: string[]
  /** The service implementing `ImportFormat`, e.g. 'import-ofx.format'. */
  service: string
  /** One sentence for the Choose Format dialog. */
  description?: string
  /**
   * Whether the bank ids this format reports (`StatementLine.externalId`) stay the same when the same transaction is
   * downloaded again. Default true. Set false for sources known to reissue them; lines are then recognised by
   * fingerprint instead.
   */
  stableIds?: boolean
  /** Lower first in the file dialog's filters. Default 0. */
  order?: number
}

/** The service behind an `ImportFormatContribution`. */
export interface ImportFormat {
  /**
   * Optional: a cheap check that the file is in this format (a header, a magic string), given its first bytes
   * (`IMPORT_LIMITS.sniffBytes`). Used only when the file's extension alone doesn't decide.
   */
  sniff?(sample: ImportSample): boolean | Promise<boolean>
  /**
   * Reads the file into statements. It may ask the user (through its own `shell.dialogs` contribution); resolve
   * undefined if the user cancels, and the file is skipped quietly. Throw `ImportError('UNREADABLE', …)` for a file it
   * can't read: the message is shown to the user.
   */
  parse(file: ImportFile, context: ParseContext): Promise<ParseResult | undefined>
  /**
   * Optional: the user corrected a statement this format read (the sign cross-check found its amounts the wrong way
   * round, and the user chose to reverse them and remember it). Update what the format remembers for the statement's
   * `key`, so its next file is read the right way round (a CSV layout's "amounts are reversed", say), and resolve true.
   * Resolve false, or leave this out, when the format can't: the import manager then keeps the correction itself and
   * applies it to the next file. A correction has one owner, so a file is never reversed twice. (Since import-api 1.5.)
   */
  correct?(correction: FormatCorrection, context: { memory: FormatMemory }): Promise<boolean>
  /**
   * Optional: how one of the values this format keeps in `context.memory` reads to the user, for *File › Saved Import
   * Choices…*, where each can be forgotten: `{ what: 'CSV columns', source: 'Date, Description, Amount', detail:
   * 'Dates month first' }`. Return undefined for values that aren't choices the user made (an index the format keeps
   * for itself): they aren't listed. Without this method, none of the format's values are listed. Forgetting one
   * deletes it, so the format must read a missing value as "nothing remembered". (Since import-api 1.7.)
   */
  describeMemory?(key: string, value: unknown): RememberedDescription | undefined
}

/** A remembered value, as *Saved Import Choices* lists it. */
export interface RememberedDescription {
  /** What it is: 'CSV columns', 'QIF options'. */
  what: string
  /** What it is for: the columns, the account's name, the file. */
  source: string
  /** What it says, in a few words: 'Dates day first · amounts reversed'. */
  detail?: string
}

/** A correction the user made to what a format read. */
export interface FormatCorrection {
  /** Every amount (and the balance) the other way round. */
  kind: 'signsReversed'
  /** The statement's `StatementAccount.key` (or the key the import manager made from the file's name). */
  key: string
}

/** The start of a file, for `sniff`. */
export interface ImportSample {
  /** 'October.ofx'. */
  name: string
  /** Lower case, without the dot: 'ofx'. Empty when the name has none. */
  extension: string
  /** The first bytes of the file. */
  head: Uint8Array
}

/** A whole file, read by the import manager: format plugins never open files themselves. */
export interface ImportFile extends ImportSample {
  path: string
  /** In bytes. */
  size: number
  bytes: Uint8Array
  /**
   * The bytes as text. A byte-order mark wins; otherwise `encoding` (default 'utf-8'; 'windows-1252' for OFX 1.x
   * files that say CHARSET:1252). Windows-1252 is decoded as the Encoding Standard says, with € and curly quotes,
   * which Node's own `TextDecoder` gets wrong. 'auto', for files that don't say (CSV, QIF): UTF-8 when the bytes are
   * valid UTF-8, otherwise windows-1252.
   */
  text(encoding?: string | 'auto'): string
}

/** A small key/value store for one format, kept in the open ledger (a CSV column layout, say). */
export interface FormatMemory {
  get<T>(key: string): Promise<T | undefined>
  /** `value` must be JSON-serialisable. */
  set(key: string, value: unknown): Promise<void>
}

export interface ParseContext {
  /** Aborted if the ledger closes, the user cancels the import, or parsing takes too long. */
  signal: AbortSignal
  memory: FormatMemory
  /** The window the import was started from. `prompt` uses it; a format needn't. */
  windowId?: number
  log: Logger
  /**
   * Opens a dialog this format contributed to `shell.dialogs`, in the window the import was started from, and
   * resolves with what it closed with, or undefined if the user cancelled it. `parse`'s time limit
   * (`IMPORT_LIMITS.parseTimeoutMs`) is paused while the dialog is open, so the user can take as long as they like:
   * only the format's own work counts. Resolves undefined without opening anything once `signal` is aborted, and
   * ignores the answer of a dialog that closes after it was.
   *
   * For the dialog's answers: resolve `parse` with undefined for "Skip This File", and throw
   * `ImportError('CANCELLED', …)` for "Cancel Import", which stops this file and every file after it.
   * (Since import-api 1.3.)
   */
  prompt<TResult = unknown, TInput = unknown>(dialogId: string, input: TInput, options?: { title?: string }): Promise<TResult | undefined>
}

/** Something the format left out or guessed, shown in the import summary. */
export interface ParseWarning {
  message: string
  /** The line (or record) of the file it is about, from 1. */
  line?: number
}

export interface ParseResult {
  /** Usually one; an OFX file can hold several accounts' statements. */
  statements: ParsedStatement[]
  warnings?: ParseWarning[]
}

/** One account's lines for a period, as the file gives them. */
export interface ParsedStatement {
  account: StatementAccount
  /** ISO 4217, when the file states it (OFX CURDEF). Otherwise the account's currency is assumed. */
  currency?: string
  /** The period the statement covers (YYYY-MM-DD), when the file states it. */
  period?: { from?: string, to?: string }
  /** The ledger balance the bank reports (OFX LEDGERBAL), as a canonical decimal string, and its date. */
  balance?: { amount: string, asOf: string }
  /**
   * False when this statement's bank ids (`StatementLine.externalId`) can't be trusted to name the same transaction in
   * another file (ids a conversion tool numbered 1, 2, 3…): its lines are then known by fingerprint. Overrides the
   * contribution's `stableIds`, for this statement only. (Since import-api 1.3.)
   */
  stableIds?: boolean
  lines: StatementLine[]
}

/**
 * How a statement's account key identifies it. 'strong': it names one account (an account number). 'weak': it only
 * suggests one (a CSV column layout, a file name), so the import manager asks before using a saved match.
 */
export type KeyStrength = 'strong' | 'weak'

/** What the file says about its account. Everything is optional: a CSV file says nothing. */
export interface StatementAccount {
  /**
   * The account's identity in this kind of source, stable from one file to the next, and namespaced:
   * 'ofx:bank:004:12345678' for an OFX bank account, 'csv:layout:9f2c…' for a CSV column layout. Saved account
   * matches are keyed on it.
   */
  key?: string
  /** Default 'strong' when `key` is given. */
  keyStrength?: KeyStrength
  /** How the file names the account, for the dialogs: 'TD Canada Trust •••• 5678'. */
  label?: string
  /** OFX <ORG> or bank id; the bank's name when the file gives it. */
  institution?: string
  /** As the file gives it. When it is masked ('XXXX5678'), set `numberIsPartial`. */
  accountNumber?: string
  numberIsPartial?: boolean
  /** A hint for a new account (OFX ACCTTYPE, a credit card statement). */
  type?: AccountType
  /** The account's name in the file (QIF `!Account`). */
  name?: string
}

/** What kind of line the bank says it is. Informational; it suggests a category (a fee goes to Bank fees). */
export const STATEMENT_LINE_KINDS = [
  'debit', 'credit', 'cheque', 'deposit', 'payment', 'transfer', 'fee', 'serviceCharge',
  'interest', 'dividend', 'atm', 'pos', 'directDebit', 'other'
] as const

export type StatementLineKind = typeof STATEMENT_LINE_KINDS[number]

/** One transaction in a statement. */
export interface StatementLine {
  /** YYYY-MM-DD: the date the bank posted it. */
  date: string
  /** YYYY-MM-DD: the date the user made it, when the file gives one (OFX DTUSER). Used by matching only. */
  userDate?: string
  /**
   * A canonical decimal string ('-84.12': '.' as the separator, no grouping, see `canonicalDecimal`), signed from the
   * account's point of view: positive raises its balance. Money out of a chequing account and a charge on a credit
   * card are both negative. Never a JavaScript number: the import manager converts it once it knows the currency.
   */
  amount: string
  /** The bank's description: 'POS PURCHASE COSTCO WHSE #0123 OTTAWA ON'. */
  payee?: string
  memo?: string
  /** A cheque number. */
  number?: string
  /** The bank's own id for the line (OFX FITID). Absent for CSV. */
  externalId?: string
  kind?: StatementLineKind
  /**
   * The category the file gives the line, as a path from the top, parts separated by ':' ('Food:Groceries'), as QIF
   * and some CSV exports write them. A hint, never applied on its own: it is used only when it names a category the
   * ledger already has, and only for sources whose files the user has said to take categories from. Never a transfer
   * (QIF's '[Savings]'). (Since import-api 1.3.)
   */
  category?: string
}
