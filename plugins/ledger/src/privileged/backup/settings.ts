// The ledger's backup settings: namespace `ledger.backup`, separate from `ledger` so their page can reset them on
// their own. Application settings, not per-ledger: a folder is a place on this computer. Edited on the Backups page
// (Tools › Options… › Ledger › Backups). See docs/backup-restore-design.md, "The Backups page".
import path from 'node:path'
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import { LEDGER_BACKUP_SETTINGS, LEDGER_BACKUP_SETTINGS_PAGE, LEDGER_SETTINGS_PAGE } from '@tessera/ledger-api'

export interface BackupSettings {
  /** The default backup folder, as a full path. '' is Tessera's default: <Documents>/Tessera Backups. */
  folder: string
  /** Back up the ledger when it closes (Close Ledger, opening another, quitting), if it changed since its last backup. */
  onClose: boolean
  /** After each backup in the default folder, remove the expired backups of the same ledger there. */
  trim: boolean
  /** Backups younger than this are always kept. */
  retentionDays: number
  /** The newest this many backups of a ledger are always kept, the one just made included. */
  keepAtLeast: number
}

export const RETENTION_DAYS_MAX = 3650
export const KEEP_AT_LEAST_MAX = 100
/** The default folder's name, in the user's documents folder. */
export const DEFAULT_BACKUP_FOLDER_NAME = 'Tessera Backups'

const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

export const BACKUP_SETTINGS: SettingsDefinition<BackupSettings> = {
  id: LEDGER_BACKUP_SETTINGS,
  defaults: { folder: '', onClose: true, trim: true, retentionDays: 30, keepAtLeast: 5 },
  // Whether the folder exists isn't checked: a drive can be unplugged and plugged back in. It is checked when writing.
  validate: ({ folder, onClose, trim, retentionDays, keepAtLeast }) => [
    ...(typeof folder === 'string' && (folder === '' || path.isAbsolute(folder)) ? [] : ['Choose the backup folder as a full path, or leave it empty for the default.']),
    ...(typeof onClose === 'boolean' ? [] : ['Say whether to back up the ledger when it closes.']),
    ...(typeof trim === 'boolean' ? [] : ['Say whether to remove old backups.']),
    ...(whole(retentionDays, 1, RETENTION_DAYS_MAX) ? [] : [`Keep backups for 1 to ${RETENTION_DAYS_MAX} days.`]),
    ...(whole(keepAtLeast, 1, KEEP_AT_LEAST_MAX) ? [] : [`Always keep from 1 to ${KEEP_AT_LEAST_MAX} backups.`])
  ]
}

/** The default backup folder: the setting, or <Documents>/Tessera Backups. */
export const backupFolder = (settings: BackupSettings, documentsPath: string) =>
  settings.folder !== '' ? path.resolve(settings.folder) : path.join(documentsPath, DEFAULT_BACKUP_FOLDER_NAME)

/** The Backups page, under Ledger. `defaultFolder` is what an empty folder means, shown in the folder field. */
export function backupSettingsPage(defaultFolder: string): SettingsPageContribution {
  return {
    id: LEDGER_BACKUP_SETTINGS_PAGE,
    parent: LEDGER_SETTINGS_PAGE,
    settings: LEDGER_BACKUP_SETTINGS,
    title: 'Backups',
    description: 'Where backups go, and when Tessera makes them.',
    keywords: ['backup', 'back up', 'restore', 'retention', 'archive', 'automatic', 'folder'],
    fields: [
      {
        kind: 'folder', key: 'folder', label: 'Backup folder', placeholder: defaultFolder,
        description: 'Back Up Ledger… starts here, and automatic backups are saved here. A folder on another drive, or one your cloud service syncs, also protects you if this disk fails.'
      },
      {
        kind: 'boolean', key: 'onClose', label: 'Back up the ledger when it closes',
        description: 'When you close it, open another ledger or quit Tessera, if it has changed since its last backup.'
      },
      {
        kind: 'boolean', key: 'trim', label: 'Remove old backups',
        description: 'After each backup in this folder, older backups of the same ledger here go to the trash (or are deleted, where there is no trash). Backups saved anywhere else are never removed: to keep one for good, move it out of this folder.'
      },
      { kind: 'number', key: 'retentionDays', label: 'Keep backups for', min: 1, max: RETENTION_DAYS_MAX, integer: true, unit: 'days' },
      { kind: 'number', key: 'keepAtLeast', label: 'Always keep the newest', min: 1, max: KEEP_AT_LEAST_MAX, integer: true, unit: 'backups' }
    ]
  }
}

/** The page, as a `[point, id, impl]` contribution like the ledger's others. */
export const backupSettingsContribution = (defaultFolder: string): [string, string, unknown] =>
  [SETTINGS_PAGES_EXTENSION_POINT, LEDGER_BACKUP_SETTINGS_PAGE, backupSettingsPage(defaultFolder)]
