// The contract between the export manager and file-type plugins: the `export.formats` contribution (plain data), the
// `ExportFormat` service a file-type plugin provides, and the neutral data it writes. A format turns data into bytes
// and nothing else: the export manager reads the ledger, asks the user, and writes the file.
// See docs/export-design.md, "The contract".
import type { AccountType, ClearingStatus } from '@tessera/accounts-api'

/**
 * A file type a plugin can write, contributed as plain data:
 * `context.extensions.contribute(pluginId, EXPORT_FORMATS_POINT, contribution.id, contribution)`.
 * Its behaviour is the `ExportFormat` service named by `service`, provided by the same plugin.
 */
export interface ExportFormatContribution {
  /** `<pluginId>.<name>`, e.g. 'format-csv.csv'. */
  id: string
  /** The Export dialog's name for it, and the Save dialog's filter: 'CSV file (spreadsheets)'. */
  label: string
  /** The file's extension: one, lower case, without the dot: 'csv'. */
  extension: string
  /** The service implementing `ExportFormat`, e.g. 'format-csv.export'. */
  service: string
  /** One sentence, shown under the format in the Export dialog. */
  description?: string
  /** Lower first in the Export dialog. Default 0. */
  order?: number
  /** How many accounts one file holds: 'one' (an OFX statement) or 'many'. */
  accounts: 'one' | 'many'
  /** The account types it can write; every type when absent. */
  accountTypes?: AccountType[]
  /** Choices for the whole file, drawn by the Export dialog, with their defaults. */
  options?: ExportOptionField[]
  /**
   * The account fields the format writes (OFX's account number and bank number, say): shown in the Export dialog for
   * each account, filled in from the account, and changeable for one export without changing the account. The format's
   * `check` says what is missing or won't do. (Since export-api 1.2.)
   */
  accountFields?: AccountFieldUse[]
}

/** An account's fields a format can write. */
export const ACCOUNT_FIELDS = ['accountNumber', 'bankId', 'intuitBankId'] as const
export type AccountFieldName = typeof ACCOUNT_FIELDS[number]

/** What each is called where the user sees it: as the Account dialog names them. */
export const ACCOUNT_FIELD_LABELS: Readonly<Record<AccountFieldName, string>> = {
  accountNumber: 'Account number',
  bankId: 'Bank number',
  intuitBankId: 'Intuit bank id'
}

/** A field a format writes, how much it needs it, and for which accounts. */
export interface AccountFieldUse {
  field: AccountFieldName
  /** 'required': the file can't be written without it. 'recommended': it can, but a program may refuse it. */
  need: 'required' | 'recommended'
  /** The account types it is for; every type the format holds when absent (OFX's bank number isn't a card's). */
  accountTypes?: AccountType[]
}

/** Whether a field a format writes is for an account of this type. */
export const fieldApplies = (use: AccountFieldUse, type: AccountType): boolean => !use.accountTypes || use.accountTypes.includes(type)

interface OptionFieldBase {
  /** The option's key in `ExportOptions`: letters, digits and '_', starting with a letter. */
  key: string
  label: string
  /** A line under the field: what choosing it means. */
  description?: string
}

/** One of a few values, shown as a list, with the chosen value's description under it. The default must be one of them. */
export interface ChoiceOptionField extends OptionFieldBase {
  kind: 'choice'
  default: string
  options: { value: string, label: string, description?: string }[]
}

/** A checkbox. */
export interface BooleanOptionField extends OptionFieldBase {
  kind: 'boolean'
  default: boolean
}

/** A line of text. */
export interface TextOptionField extends OptionFieldBase {
  kind: 'text'
  default: string
  /** An empty (or all-blank) value is a problem. */
  required?: boolean
  maxLength?: number
}

/** A choice a format offers, declared as data, so a file-type plugin needs no renderer to offer it. */
export type ExportOptionField = ChoiceOptionField | BooleanOptionField | TextOptionField

/**
 * Option values by key. The export manager gives a format every option it declared, each valid, with the default for
 * any the user didn't set (`resolveOptions`), so a format can read them without checking.
 */
export type ExportOptions = Record<string, string | boolean>

/** The service behind an `ExportFormatContribution`. Pure: no ledger, no files, no user. */
export interface ExportFormat {
  /**
   * What writing `data` would do: how many transactions the file will hold, the problems that stop it (an account
   * type the format can't write), and warnings about what will be cut, changed or left out. The Export dialog calls
   * it as the user changes things, so it must be quick. `formatId` says which contribution, for a service behind
   * several.
   */
  check(data: ExportData, options: ExportOptions, formatId: string): ExportCheck | Promise<ExportCheck>
  /** The file's bytes. Called only when `check` found no problems. */
  write(data: ExportData, options: ExportOptions, formatId: string): ExportOutput | Promise<ExportOutput>
}

export interface ExportCheck {
  /** How many transactions the file will hold. */
  transactions: number
  /**
   * The accounts (their ids) the file won't hold, when the format leaves some out: an account with no transactions in
   * the range, say. The export manager counts and names only the others. (Since export-api 1.1.)
   */
  accountsLeftOut?: string[]
  /** Why the file can't be written as asked, in words. Any problem stops the export. */
  problems: string[]
  /** What will be cut, changed or left out, in words. */
  warnings: string[]
}

export interface ExportOutput {
  bytes: Uint8Array
  warnings: string[]
}

/** Dates, inclusive, YYYY-MM-DD. */
export interface ExportRange {
  from: string
  to: string
}

/** What a format is given: resolved and in order, names rather than ids. Structured-cloneable. */
export interface ExportData {
  ledger: { name: string }
  /** When the export was made: an ISO date and time. */
  exportedAt: string
  /** The dates covered: the earliest account's start to the end. */
  range: ExportRange
  /** In the navigator's order. */
  accounts: ExportAccount[]
  /** Every category, as its path from the top (['Food', 'Groceries']), for formats that write a category list. */
  categories: { path: string[], kind: 'income' | 'expense' }[]
}

export interface ExportAccount {
  id: string
  name: string
  type: AccountType
  /** ISO 4217. */
  currency: string
  /** The currency's decimals: 2 for CAD, 0 for JPY, 3 for BHD. */
  digits: number
  institution?: string
  accountNumber?: string
  /** OFX's `BANKID`, as the account has it or as typed in the Export dialog for this export. (Since export-api 1.2.) */
  bankId?: string
  /** `INTU.BID`, likewise. (Since export-api 1.2.) */
  intuitBankId?: string
  closed: boolean
  /** The sub-ledgers holding it, from the top: ['Household', 'Joint']; empty for the ledger itself. */
  location: string[]
  /**
   * The balance at the start of `opening.date`, before that day's transactions: the register's balance at the end of
   * the day before. `opening.date` is the range's start, or the account's own start when that is later.
   */
  opening: { date: string, balance: string }
  /** The balance at the end of `closing.date`, the range's end. */
  closing: { date: string, balance: string }
  /** The account's earlier transactions are in an archive file: the export starts where its current period does. */
  startsAtArchive?: boolean
  transactions: ExportTransaction[]
}

export interface ExportTransaction {
  /** Tessera's id (a ULID): stable and unique. */
  id: string
  date: string
  /** A canonical decimal with the currency's digits, signed from this account's side: '-84.12'. */
  amount: string
  /** A cheque number, or a code such as 'ATM'. */
  number?: string
  payee?: string
  /** The category's path from the top: ['Food', 'Groceries']. Absent for transfers and uncategorised ones. */
  category?: string[]
  /** The other side of a transfer: the other account's name, and which way the money went. */
  transfer?: { account: string, direction: 'to' | 'from' }
  memo?: string
  status: ClearingStatus
  /** Kept, with its amount, but in no balance. Each format decides whether to write it. */
  voided: boolean
  /** The bank's own id for the line, when it was imported with one (never an import's fingerprint). */
  bankId?: string
  /** The running balance after it, as the register shows it; a voided transaction leaves it as it was. */
  balance: string
}
