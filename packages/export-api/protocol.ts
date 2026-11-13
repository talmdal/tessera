// Every name the export plugin publishes: ids, the extension point, commands, context keys, dialogs, IPC channels and
// state keys, with the payloads that go with them. Both halves of the plugin, file-type plugins and the tests use these
// constants, never the strings. See docs/export-design.md.
import { channelFor } from '@tessera/types'
import type { AccountType } from '@tessera/accounts-api'
import type { AccountFieldName, AccountFieldUse, ExportCheck, ExportOptionField, ExportOptions, ExportRange } from './contract'

export const EXPORT_PLUGIN_ID = 'export'

/** Extension point for `ExportFormatContribution`s. */
export const EXPORT_FORMATS_POINT = 'export.formats'

/**
 * Reserved for the service other plugins would require to export without the dialog. Not built: it waits for a plugin
 * that needs it (docs/export-design.md, "Later").
 */
export const EXPORT_MANAGER_SERVICE = 'export.manager'

export const EXPORT_COMMANDS = {
  /** File › Export…. No argument: the accounts are chosen in the dialog, starting from the one the user is looking at. */
  file: 'export.file',
  /**
   * Accounts › Export Account…: the Export dialog, starting from one account. Argument `ExportAccountArgs`, else the
   * navigator's selected account. (Since export-api 1.3.)
   */
  account: 'export.account'
} as const

/** `EXPORT_COMMANDS.account`'s argument. */
export interface ExportAccountArgs {
  /** The account to start from. */
  id: string
}

export const EXPORT_CONTEXT_KEYS = {
  /** At least one valid `export.formats` contribution is installed. */
  hasFormats: 'export.hasFormats',
  /** An export is in progress. */
  isRunning: 'export.isRunning'
} as const

export const EXPORT_DIALOGS = {
  /** The Export dialog. Input `ExportDialogInput`, result `ExportDialogResult`. */
  export: 'export.dialog.export'
} as const

const channel = (event: string) => channelFor(EXPORT_PLUGIN_ID, event)

/** Requests, renderer → main. */
export const EXPORT_CHANNELS = {
  /** `ExportRequest` → `ExportResult<CheckResponse>`: what the file would hold, for the Export dialog's preview. */
  check: channel('check')
} as const

/**
 * Keys in the export plugin's `context.state` (application state, not ledger data: an export never changes the
 * ledger). The store prefixes them with the plugin id.
 */
export const EXPORT_STATE_KEYS = {
  /** The folder the last export was saved in. */
  lastFolder: 'lastFolder',
  /** The last format used. */
  lastFormat: 'lastFormat',
  /**
   * `RememberedOptions[]`: each format's options, as last used. A list, not an object keyed by format id: the storage
   * engine refuses field names with a '.', and format ids have one.
   */
  options: 'options',
  /** `RangeState`: the dates, as last chosen. */
  range: 'range'
} as const

export const EXPORT_LIMITS = {
  /** How long a format's `write` may take. */
  writeTimeoutMs: 30_000
} as const

/** A format's options, as `EXPORT_STATE_KEYS.options` keeps them. */
export interface RememberedOptions {
  formatId: string
  options: ExportOptions
}

/** The export's label as the ledger's running operation: "Wait for “Exporting transactions” to finish." */
export const EXPORT_OPERATION = 'Exporting transactions'

/** A valid format, as the Export dialog lists it. */
export interface ExportFormatInfo {
  id: string
  label: string
  extension: string
  description?: string
  accounts: 'one' | 'many'
  accountTypes?: AccountType[]
  options: ExportOptionField[]
  /** The account fields it writes; empty for none. */
  accountFields: AccountFieldUse[]
}

/** An account, as the Export dialog offers it. */
export interface ExportAccountChoice {
  id: string
  name: string
  type: AccountType
  /** 'Credit card'. */
  typeLabel: string
  currency: string
  closed: boolean
  /** The sub-ledgers holding it, from the top, joined: 'Household › Joint'; empty for the ledger itself. */
  location: string
  /** The fields a format may write, as the account has them, to start the dialog's fields from. */
  accountNumber?: string
  bankId?: string
  intuitBankId?: string
}

/** Account fields typed in the Export dialog, by account id: used for this export, never saved to the account. */
export type AccountValues = Record<string, Partial<Record<AccountFieldName, string>>>

/** The ready-made date ranges the dialog offers. */
export const RANGE_CHOICES = ['all', 'thisYear', 'lastYear', 'thisMonth', 'lastMonth', 'custom'] as const
export type RangeChoice = typeof RANGE_CHOICES[number]

/** The dates as the user chose them. 'custom' has its own dates; the others are worked out from today. */
export interface RangeState {
  choice: RangeChoice
  from?: string
  to?: string
}

export interface ExportDialogInput {
  ledgerName: string
  /** The valid formats, in the dialog's order. At least one. */
  formats: ExportFormatInfo[]
  /** Every account, closed ones too, in the navigator's order. */
  accounts: ExportAccountChoice[]
  /**
   * The account to start from: the one *Export Account…* was for, else the one the user is looking at (the register's,
   * or the navigator's selection), if any.
   */
  preselectedId?: string
  /** The format to start on: the last one used, or the first; either way, one that can hold the preselected account. */
  formatId: string
  /** Each format's options to start from: as last used, else the defaults. */
  options: Record<string, ExportOptions>
  range: RangeState
  /** YYYY-MM-DD, for working out the ranges. */
  today: string
}

/** What to export. An open end of the range is the accounts' own: from the earliest start, to the latest transaction. */
export interface ExportRequest {
  formatId: string
  /** In any order: the file follows the navigator's. */
  accountIds: string[]
  range: { from?: string, to?: string }
  options: ExportOptions
  /** Account fields typed in the dialog, for this export only (Q10). (Since export-api 1.2.) */
  accountValues?: AccountValues
}

export interface ExportDialogResult extends ExportRequest {
  /** Remembered for next time. */
  rangeState: RangeState
}

/** `export:check`'s answer: the format's check, and what the export manager worked out. */
export interface CheckResponse extends ExportCheck {
  accounts: number
  /** The dates the file covers, once open ends are filled in. */
  range: ExportRange
  /** Accounts whose earlier transactions are in an archive file, and where they start. */
  archived: { account: string, from: string }[]
}
