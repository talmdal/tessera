// Every name the ledger plugin publishes: ids, commands, context keys, IPC channels, events, views and dialogs.
// Both halves of the plugin, other plugins and the tests use these constants, never the strings.
import { channelFor } from '@tessera/types'
import type { LedgerTree } from './model'

export const LEDGER_PLUGIN_ID = 'ledger'

/** The service other plugins require: `LedgerSession`. */
export const LEDGER_SESSION_SERVICE = 'ledger.session'

/** Extension point for `SchemaContribution`s. */
export const LEDGER_SCHEMA_POINT = 'ledger.schema'

/** A ledger file's extension, with its dot. */
export const LEDGER_FILE_EXTENSION = '.tessera'

/** The filter for open and save dialogs. */
export const LEDGER_FILE_FILTER = { name: 'Tessera ledger', extensions: [LEDGER_FILE_EXTENSION.slice(1)] }

/** Version of the ledger's own format (its meta keys and `ledger.subledgers`). */
export const LEDGER_FORMAT_VERSION = 1

/** Keys in the database's `meta`. */
export const LEDGER_META = {
  /** `LEDGER_FORMAT_VERSION`. A file without it is not a ledger. */
  format: 'ledger.format',
  createdAt: 'ledger.createdAt',
  /** The application version that created the file. */
  createdWith: 'ledger.createdWith',
  /** The schema version of a `ledger.schema` contributor. */
  schemaVersion: (contributor: string) => `ledger.schema.${contributor}`
} as const

/** The ledger's own collections, part of the ledger format rather than a schema contribution. */
export const LEDGER_COLLECTIONS = {
  subLedgers: 'ledger.subledgers'
} as const

export const LEDGER_COMMANDS = {
  /** File › New Ledger…. Argument (optional): `NewLedgerArgs`. */
  new: 'ledger.new',
  /** File › Open Ledger…. */
  open: 'ledger.open',
  /** File › Close Ledger. */
  close: 'ledger.close',
  /** File › Delete Ledger…: sends the open ledger's file to the trash. */
  delete: 'ledger.delete',
  /** Argument: `{ id }`. No menu item of its own; the accounts navigator and menu run it. */
  renameSubLedger: 'ledger.subLedger.rename',
  /** Argument: `{ id }`. Moves the sub-ledger's contents up to its parent, then deletes it. */
  deleteSubLedger: 'ledger.subLedger.delete'
} as const

/** Argument of `ledger.new`. With `parentId` (null = the ledger itself), the dialog starts with that parent chosen. */
export interface NewLedgerArgs {
  parentId?: string | null
}

/** Argument of the sub-ledger commands. */
export interface SubLedgerArgs {
  id: string
}

export const LEDGER_CONTEXT_KEYS = {
  isOpen: 'ledger.isOpen',
  isReadOnly: 'ledger.isReadOnly',
  /** The open ledger's name, for status text such as `Ledger: {ledger.name}`. */
  name: 'ledger.name',
  /** Another plugin's view shows the ledger tree (`registerNavigator`), so the Ledger panel is hidden. */
  hasNavigator: 'ledger.hasNavigator'
} as const

const channel = (event: string) => channelFor(LEDGER_PLUGIN_ID, event)

/** Requests, renderer → main. */
export const LEDGER_CHANNELS = {
  /** → `LedgerState`. */
  state: channel('state'),
  /** → `RecentLedger[]`, with `exists` filled in. */
  recent: channel('recent'),
  /** `{ path }` → void. Removes an entry from the recent list; the file is untouched. */
  recentRemove: channel('recent.remove'),
  /** `{ path }` → `Result<LedgerInfo | undefined, LedgerErrorCode>`. Opens a recent ledger, as the command does. */
  open: channel('open'),
  /** `{ path }` → boolean. Sends a recent ledger's file to the trash, after confirming. */
  delete: channel('delete'),
  /** → `LedgerTree`, or null when no ledger is open. */
  tree: channel('tree'),
  /** `{ name, parentId }` → `Result<SubLedger, LedgerErrorCode>`. Used by the New Ledger dialog. */
  createSubLedger: channel('subLedger.create'),
  /** `{ id, name, expectedRev? }` → `Result<SubLedger, LedgerErrorCode>`. Used by the rename dialog. */
  renameSubLedger: channel('subLedger.rename')
} as const

/** Push events, main → renderer. Each carries the whole new value, so a repeat is harmless. */
export const LEDGER_EVENTS = {
  /** `LedgerState`. */
  state: channel('state.changed'),
  /** `LedgerTree`, or null when the ledger closed. */
  tree: channel('tree.changed'),
  /** `RecentLedger[]`, with `exists` filled in. */
  recent: channel('recent.changed')
} as const

export const LEDGER_VIEWS = {
  /** The main-area page shown while no ledger is open: New, Open, recent ledgers. */
  start: 'ledger.start',
  /** The left-bar tree of the open ledger and its sub-ledgers, hidden while another plugin's navigator shows it. */
  tree: 'ledger.tree'
} as const

/** `shell.dialogs` contributions, shown with `shell.prompts.show`. */
export const LEDGER_DIALOGS = {
  /** Input `NewLedgerDialogInput`, result `NewLedgerDialogResult`. */
  newLedger: 'ledger.dialog.new',
  /** Input `RenameSubLedgerDialogInput`, result `{ id }`. */
  renameSubLedger: 'ledger.dialog.rename'
} as const

export interface NewLedgerDialogInput {
  tree: LedgerTree
  /** The parent chosen when the dialog opens: a sub-ledger id, null for the ledger, or undefined for None. */
  parentId?: string | null
}

/**
 * What the New Ledger dialog closed with. A sub-ledger has already been created by the dialog (so a duplicate name
 * could be shown inline); a file is created by the command afterwards, after asking to close the open ledger.
 */
export type NewLedgerDialogResult =
  | { kind: 'subLedger', id: string }
  | { kind: 'file', name: string }

export interface RenameSubLedgerDialogInput {
  id: string
  name: string
  rev: number
}
