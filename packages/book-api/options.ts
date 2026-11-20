// The book plugin's options (namespace `book`): how automatic backups are taken. Shared by the privileged side,
// which registers and validates them, and the Backups options page. See docs/backup-restore-design.md, "Options".

export type BackupFrequency = 'everyClose' | 'daily' | 'weekly' | 'monthly'

export const BACKUP_FREQUENCIES: readonly BackupFrequency[] = ['everyClose', 'daily', 'weekly', 'monthly']

export interface BookBackupOptions {
  /** Back up automatically when a book closes. Off is "never": the other settings are kept for when it is on again. */
  automatic: boolean
  /** The least time between automatic backups. A minimum gap, not a quota: missed periods are never made up. */
  frequency: BackupFrequency
  /** An absolute folder path; null for the default, `<Documents>/Tessera Backups`. */
  folder: string | null
  /** Automatic backups kept per book; older ones go to the Trash (or are deleted where there is none). */
  keep: number
}

export interface BookOptions {
  backups: BookBackupOptions
}

/** The default backup folder's name, inside the user's documents folder. */
export const DEFAULT_BACKUP_FOLDER_NAME = 'Tessera Backups'

export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 999

export const BOOK_OPTIONS_DEFAULTS: BookOptions = {
  backups: { automatic: true, frequency: 'daily', folder: null, keep: 10 }
}

/** Absolute on any platform: `/…`, `C:\…` or `C:/…`, or a UNC share `\\server\…`. No `node:path` here: the page uses it too. */
export const isAbsoluteFolder = (folder: string) => /^(\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(folder)

/**
 * Problems with a value, as messages; empty when it is valid. Whether the folder exists is deliberately not checked:
 * a drive may be unplugged when the user applies and plugged in by the time a backup runs.
 */
export function validateBookOptions(value: BookOptions): string[] {
  const problems: string[] = []
  const backups = value?.backups
  if (typeof backups !== 'object' || backups === null) return ['The backup settings are missing.']
  if (typeof backups.automatic !== 'boolean') problems.push('Choose whether to back up automatically.')
  if (!BACKUP_FREQUENCIES.includes(backups.frequency)) problems.push('Choose how often to back up.')
  if (!Number.isInteger(backups.keep) || backups.keep < BACKUP_KEEP_MIN || backups.keep > BACKUP_KEEP_MAX) {
    problems.push(`Keep between ${BACKUP_KEEP_MIN} and ${BACKUP_KEEP_MAX} automatic backups.`)
  }
  if (backups.folder !== null && (typeof backups.folder !== 'string' || !isAbsoluteFolder(backups.folder))) {
    problems.push('The backup folder must be a full path, such as one chosen with Browse….')
  }
  return problems
}
