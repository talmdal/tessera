// Every name the ledger plugin publishes: ids, commands, context keys, IPC channels, events, views and dialogs.
// Both halves of the plugin, other plugins and the tests use these constants, never the strings.
import { channelFor } from '@tessera/types'
import type { ArchiveOutcome, LedgerInfo, LedgerTree } from './model'
import type { ArchiveDescription } from './service'

export const LEDGER_PLUGIN_ID = 'ledger'

/** The service other plugins require: `LedgerSession`. */
export const LEDGER_SESSION_SERVICE = 'ledger.session'

/** Extension point for `SchemaContribution`s. */
export const LEDGER_SCHEMA_POINT = 'ledger.schema'

/** A ledger file's extension, with its dot. */
export const LEDGER_FILE_EXTENSION = '.tessera'

/** The filter for open and save dialogs. */
export const LEDGER_FILE_FILTER = { name: 'Tessera ledger', extensions: [LEDGER_FILE_EXTENSION.slice(1)] }

/** Version of the ledger's own format (its meta keys, `ledger.subledgers` and `ledger.archives`). */
export const LEDGER_FORMAT_VERSION = 1

/** Keys in the database's `meta`. */
export const LEDGER_META = {
  /** `LEDGER_FORMAT_VERSION`. A file without it is not a ledger. */
  format: 'ledger.format',
  /**
   * The ledger's identity, a ULID: written when it is created, or the first time an older ledger is opened writable.
   * It tells this ledger's backups from another ledger's with the same name.
   */
  id: 'ledger.id',
  /** On a ledger restored as a new one: `{ id, takenAt }` of the backup it came from. It has an id of its own. */
  restoredFrom: 'ledger.restoredFrom',
  createdAt: 'ledger.createdAt',
  /** The application version that created the file. */
  createdWith: 'ledger.createdWith',
  /** The schema version of a `ledger.schema` contributor. */
  schemaVersion: (contributor: string) => `ledger.schema.${contributor}`
} as const

/** A backup's extension, with its dot. A backup is a ledger file in the engine's format, with backup meta. */
export const LEDGER_BACKUP_EXTENSION = '.tesserabkp'

/** The filter for a backup's save and open dialogs. */
export const LEDGER_BACKUP_FILTER = { name: 'Tessera backup', extensions: [LEDGER_BACKUP_EXTENSION.slice(1)] }

/**
 * Keys a snapshot adds to a backup's meta (the ledger's own meta, `ledger.id` included, is copied with it). A file is
 * a backup only when it has both `ledger.format` and `backup.takenAt`.
 */
export const LEDGER_BACKUP_META = {
  /** ISO 8601, UTC. */
  takenAt: 'backup.takenAt',
  /** A `BackupKind`. */
  kind: 'backup.kind',
  /** The ledger's name when it was backed up. */
  ledgerName: 'backup.ledgerName',
  /** The ledger's absolute path when it was backed up. */
  ledgerPath: 'backup.ledgerPath',
  /** `ledger <LEDGER_API_VERSION>`, as `ledger.createdWith`. */
  takenWith: 'backup.takenWith',
  /** On an archive file (`kind: 'archive'`): the archive date, YYYY-MM-DD. What occurred before it was archived. */
  archiveBefore: 'backup.archiveBefore'
} as const

/**
 * `'manual'` (File › Back Up Ledger…), `'auto'` (when the ledger closed), or `'archive'`: the archive file File ›
 * Archive Ledger… keeps before it removes anything. An archive is never trimmed, and opens read-only.
 */
export type BackupKind = 'manual' | 'auto' | 'archive'

/** The filter for opening an archive file: a backup of kind `archive`, with the backup's extension. */
export const LEDGER_ARCHIVE_FILTER = { name: 'Tessera archive', extensions: [LEDGER_BACKUP_EXTENSION.slice(1)] }

/** The folder, inside the default backup folder, where archive files go. Retention never looks inside it. */
export const LEDGER_ARCHIVES_FOLDER = 'Archives'

/** The ledger's backup settings: a namespace of their own. */
export const LEDGER_BACKUP_SETTINGS = 'ledger.backup'

/** The Backups page of the Options dialog (under Ledger): run `shell.settings.open` with it to show it. */
export const LEDGER_BACKUP_SETTINGS_PAGE = 'ledger.backup.settings'

/** The ledger's own collections, part of the ledger format rather than a schema contribution. */
export const LEDGER_COLLECTIONS = {
  subLedgers: 'ledger.subledgers',
  /** `ArchiveRecord`s: one per archive, written with it. Declared, so opening a ledger creates it: no migration. */
  archives: 'ledger.archives'
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
  /**
   * File › Back Up Ledger…: asks where, suggesting the default backup folder, then copies the open ledger there.
   * Argument (optional): `BackUpLedgerArgs`. Resolves the backup's path, or undefined if cancelled or it failed.
   */
  backup: 'ledger.backup',
  /**
   * File › Restore Ledger…: the Restore dialog, listing the backups in the default backup folder (Browse… for others).
   * A backup is restored as a new ledger, or in its ledger's place with the current file kept under another name:
   * never replaced. Works with no ledger open. Argument (optional): `RestoreLedgerArgs`. Resolves the restored
   * ledger, or undefined.
   */
  restore: 'ledger.restore',
  /**
   * File › Archive Ledger…: the Archive dialog, which keeps a copy of the ledger as an archive file, then removes the
   * transactions no longer required before the date chosen. Argument (optional): `ArchiveLedgerArgs`, which skips the
   * dialog. Resolves what the archive did (`ArchiveOutcome`), or undefined. See docs/ledger-compaction-design.md.
   */
  archive: 'ledger.archive',
  /** Opens the Options dialog at the Archiving page. */
  archiveSettings: 'ledger.archiveSettings',
  /** Opens the Options dialog at the Backups page (the "Last backup failed" status item runs it). */
  backupSettings: 'ledger.backupSettings',
  /** Argument: `{ id }`. No menu item of its own; the accounts navigator and menu run it. */
  renameSubLedger: 'ledger.subLedger.rename',
  /** Argument: `{ id }`. Moves the sub-ledger's contents up to its parent, then deletes it. */
  deleteSubLedger: 'ledger.subLedger.delete'
} as const

/** Argument of `ledger.new`. With `parentId` (null = the ledger itself), the dialog starts with that parent chosen. */
export interface NewLedgerArgs {
  parentId?: string | null
}

/** Argument of `ledger.backup`. With `path`, no dialog: the backup is written there, replacing a file already there. */
export interface BackUpLedgerArgs {
  path?: string
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
  hasNavigator: 'ledger.hasNavigator',
  /**
   * A long operation is running on the ledger (`LedgerSession.beginOperation`): an import, a backup, a restore. The
   * ledger's file commands, and other operations, wait until it ends.
   */
  isBusy: 'ledger.isBusy',
  /** The running operation's label, for the user: "Importing statements". */
  operation: 'ledger.operation',
  /** What the ledger is doing or has just done, for the status bar: "Backed up “Home” at 10:14". */
  activity: 'ledger.activity',
  /**
   * Set while the last automatic backup of a ledger failed or was skipped, until a backup of it succeeds: what
   * happened, for the "Last backup failed" status item's tooltip. Unset otherwise.
   */
  backupProblem: 'ledger.backupProblem',
  /** An archive file is open, read-only, for viewing (`LedgerInfo.archive`). */
  isArchive: 'ledger.isArchive',
  /** While one is: what it is, for the status bar: "Archive of “Home”, before 2026-01-01 · read-only". */
  archive: 'ledger.archive'
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
  renameSubLedger: channel('subLedger.rename'),
  // The Restore dialog's requests. They answer only while File › Restore Ledger… has the dialog open.
  /** → `{ folder, backups: BackupInfo[] }`: the backups in the default backup folder, newest first. */
  restoreList: channel('restore.list'),
  /** → `Result<BackupInfo | undefined>`: a backup (or a ledger file) chosen in the open dialog; undefined if cancelled. */
  restoreBrowse: channel('restore.browse'),
  /** `{ path }` → `Result<RestorePlan>`: how a listed backup can be restored, with suggested names. */
  restorePlan: channel('restore.plan'),
  /** `{ defaultPath }` → `string | undefined`: a folder, chosen in the folder dialog. */
  restoreFolder: channel('restore.folder'),
  /** `RestoreRequest` → `Result<RestoreOutcome>`: restores, pushing `restoreProgress` meanwhile. */
  restoreRun: channel('restore.run'),
  // The Archive dialog's requests. They answer only while File › Archive Ledger… has the dialog open.
  /** `ArchiveRunRequest` → `Result<ArchivePreview>`: what archiving before the date would do. */
  archivePreview: channel('archive.preview'),
  /** `ArchiveRunRequest` → `Result<ArchiveOutcome>`: archives, pushing `archiveProgress` meanwhile. */
  archiveRun: channel('archive.run')
} as const

/** Push events, main → renderer. Each carries the whole new value, so a repeat is harmless. */
export const LEDGER_EVENTS = {
  /** `LedgerState`. */
  state: channel('state.changed'),
  /** `LedgerTree`, or null when the ledger closed. */
  tree: channel('tree.changed'),
  /** `RecentLedger[]`, with `exists` filled in. */
  recent: channel('recent.changed'),
  /** `RestoreProgress`, while `restoreRun` works. */
  restoreProgress: channel('restore.progress'),
  /** `ArchiveProgress`, while `archiveRun` works. */
  archiveProgress: channel('archive.progress')
} as const

export const LEDGER_VIEWS = {
  /** The main-area page shown while no ledger is open: New, Open, recent ledgers. */
  start: 'ledger.start',
  /** The left-bar tree of the open ledger and its sub-ledgers, hidden while another plugin's navigator shows it. */
  tree: 'ledger.tree'
} as const

/** The ledger's page in the Options dialog: run `shell.settings.open` with it to show the ledger's settings. */
export const LEDGER_SETTINGS_PAGE = 'ledger.settings'

/** `shell.dialogs` contributions, shown with `shell.prompts.show`. */
export const LEDGER_DIALOGS = {
  /** Input `NewLedgerDialogInput`, result `NewLedgerDialogResult`. */
  newLedger: 'ledger.dialog.new',
  /** Input `RenameSubLedgerDialogInput`, result `{ id }`. */
  renameSubLedger: 'ledger.dialog.rename',
  /** Input `RestoreDialogInput`, result `RestoreDialogResult`. */
  restore: 'ledger.dialog.restore',
  /** Input `ArchiveDialogInput`, result `ArchiveOutcome` (undefined if cancelled). */
  archive: 'ledger.dialog.archive'
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

/** Argument of `ledger.restore`: a backup to show chosen in the dialog. */
export interface RestoreLedgerArgs {
  path?: string
}

/** A backup the Restore dialog offers: what is known of it before restoring. */
export interface BackupInfo {
  path: string
  /** The ledger it holds: its name when it was backed up (a ledger file's own name). */
  ledgerName: string
  ledgerId?: string
  /** Where that ledger was when it was backed up (a backup's `backup.ledgerPath`). */
  ledgerPath?: string
  /** ISO 8601: when the backup was taken; for a ledger file rather than a backup, when the file last changed. */
  takenAt: string
  /** `'ledger'`: a ledger file, not a backup (a copy made before an upgrade, or by hand). */
  kind: BackupKind | 'ledger'
  /** An archive file's archive date, YYYY-MM-DD. */
  archiveBefore?: string
  /** Bytes. */
  size: number
  /** Why it can't be restored, when it can't: saved by a newer Tessera, not a ledger, the open ledger itself… */
  problem?: string
}

export interface RestoreDialogInput {
  /** A backup to show chosen: from the command's argument. */
  preselect?: string
}

/** What a restore did: the ledger it opened, and where the current file was kept (restoring in place of it). */
export interface RestoreOutcome {
  ledger: LedgerInfo
  /** The current file's new path, when a restore in place kept it under another name. */
  kept?: string
}

export interface RestoreDialogResult extends RestoreOutcome {
  /** The backup's `takenAt`, for "… as it was on …". */
  takenAt: string
}

/** How one backup can be restored: always as a new ledger; in its ledger's place when that ledger is on this computer. */
export interface RestorePlan {
  backup: BackupInfo
  /** A new ledger: a free name, in the ledger's folder (or the documents folder). */
  asNew: { folder: string, name: string }
  inPlace:
    | {
      /** The ledger file the backup takes the name of. */
      path: string
      name: string
      /** It is the open ledger: it closes, and opens again as it was in the backup. */
      isOpen: boolean
      /** A free name to keep the current file under, when there is a current file. Nothing is ever deleted. */
      keepAs?: string
    }
    | { unavailable: string }
}

export type RestoreRequest =
  | { backup: string, mode: 'new', folder: string, name: string }
  /** `keepAs`: the name the current file is kept under (without the extension); required when there is one. */
  | { backup: string, mode: 'inPlace', keepAs?: string }

/** Argument of `ledger.archive`: archive before `before` without the dialog, with these options (default: theirs). */
export interface ArchiveLedgerArgs {
  before: string
  options?: Record<string, boolean>
}

/** What the Archive dialog opens with. */
export interface ArchiveDialogInput {
  ledgerName: string
  /** YYYY-MM-DD, from the Archiving page (`suggestedArchiveDate`). */
  suggestedBefore: string
  /** YYYY-MM-DD: the archive date can't be later. */
  today: string
  /** The ledger's last archive, if it has one. */
  lastArchive?: { before: string, archivedAt: string }
}

/** What the Archive dialog asks about, and runs. */
export interface ArchiveRunRequest {
  before: string
  /** The value of each option the participants offered; one not given takes its default. */
  options?: Record<string, boolean>
}

/** One participant's part of the preview. */
export interface ArchivePreviewPart extends ArchiveDescription {
  contributor: string
}

/** What archiving before a date would do, for the Archive dialog. */
export interface ArchivePreview {
  before: string
  parts: ArchivePreviewPart[]
  /** Records removed, over every participant: nothing to archive when 0. */
  count: number
  /** The archive file it would make: its name (without the extension) and folder. */
  copy: { name: string, folder: string }
}

/** A step of an archive, and how far the copy has got (0 to 1) when that is known. */
export interface ArchiveProgress {
  step: 'copying' | 'checking' | 'removing' | 'compacting'
  done?: number
}

/** What the Archive dialog closes with: what the archive did. */
export type ArchiveDialogResult = ArchiveOutcome

/** The ledger's archive settings (the Archiving page): a namespace of their own. */
export const LEDGER_ARCHIVE_SETTINGS = 'ledger.archive'

/** The Archiving page of the Options dialog (under Ledger). */
export const LEDGER_ARCHIVE_SETTINGS_PAGE = 'ledger.archive.settings'

/** A step of a restore, and how far a copy has got (0 to 1) when that is known. */
export interface RestoreProgress {
  step: string
  done?: number
}

export interface RenameSubLedgerDialogInput {
  id: string
  name: string
  rev: number
}
