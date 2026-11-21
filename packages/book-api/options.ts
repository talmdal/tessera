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

export interface BookArchiveOptions {
  /** Which date the Archive dialog offers. The dialog always lets the user change it. */
  suggest: ArchiveSuggestion
  /** An absolute folder path; null for the default, `<Documents>/Tessera Archives`. */
  folder: string | null
  /** Remove reconciled transactions before the cut-off. */
  removeReconciled: boolean
  /** Remove voided transactions before the cut-off. */
  removeVoided: boolean
}

export interface BookOptions {
  backups: BookBackupOptions
  archive: BookArchiveOptions
}

/** The default backup folder's name, inside the user's documents folder. */
export const DEFAULT_BACKUP_FOLDER_NAME = 'Tessera Backups'

/** The default archive folder's name, inside the user's documents folder. */
export const DEFAULT_ARCHIVE_FOLDER_NAME = 'Tessera Archives'

/**
 * Which cut-off the Archive dialog offers. A rule, never a stored date, so the suggestion stays right as years
 * pass. See docs/archive-design.md, "Options".
 */
export type ArchiveSuggestion = 'startOfThisYear' | 'startOfLastYear' | 'oneYearAgo' | 'twoYearsAgo'

export const ARCHIVE_SUGGESTIONS: readonly ArchiveSuggestion[] = ['startOfThisYear', 'startOfLastYear', 'oneYearAgo', 'twoYearsAgo']

export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 999

export const BOOK_OPTIONS_DEFAULTS: BookOptions = {
  backups: { automatic: true, frequency: 'daily', folder: null, keep: 10 },
  archive: { suggest: 'startOfThisYear', folder: null, removeReconciled: true, removeVoided: true }
}

const two = (n: number) => String(n).padStart(2, '0')
const isoDay = (date: Date) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`

/** The cut-off a rule gives today, as `YYYY-MM-DD`; rolling dates clamp to the target month's final day. */
export function suggestedCutoff(rule: ArchiveSuggestion, today: Date): string {
  switch (rule) {
    case 'startOfThisYear': return `${today.getFullYear()}-01-01`
    case 'startOfLastYear': return `${today.getFullYear() - 1}-01-01`
    case 'oneYearAgo':
    case 'twoYearsAgo': {
      const years = rule === 'oneYearAgo' ? 1 : 2
      const year = today.getFullYear() - years
      const lastDay = new Date(year, today.getMonth() + 1, 0).getDate()
      return isoDay(new Date(year, today.getMonth(), Math.min(today.getDate(), lastDay)))
    }
  }
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
  if (typeof backups !== 'object' || backups === null) {
    problems.push('The backup settings are missing.')
  } else {
    if (typeof backups.automatic !== 'boolean') problems.push('Choose whether to back up automatically.')
    if (!BACKUP_FREQUENCIES.includes(backups.frequency)) problems.push('Choose how often to back up.')
    if (!Number.isInteger(backups.keep) || backups.keep < BACKUP_KEEP_MIN || backups.keep > BACKUP_KEEP_MAX) {
      problems.push(`Keep between ${BACKUP_KEEP_MIN} and ${BACKUP_KEEP_MAX} automatic backups.`)
    }
    if (backups.folder !== null && (typeof backups.folder !== 'string' || !isAbsoluteFolder(backups.folder))) {
      problems.push('The backup folder must be a full path, such as one chosen with Browse….')
    }
  }
  const archive = value?.archive
  if (typeof archive !== 'object' || archive === null) {
    problems.push('The archive settings are missing.')
  } else {
    if (!ARCHIVE_SUGGESTIONS.includes(archive.suggest)) problems.push('Choose when the Archive dialog should suggest archiving.')
    if (archive.folder !== null && (typeof archive.folder !== 'string' || !isAbsoluteFolder(archive.folder))) {
      problems.push('The archive folder must be a full path, such as one chosen with Browse….')
    }
    if (typeof archive.removeReconciled !== 'boolean') problems.push('Choose whether to remove reconciled transactions.')
    if (typeof archive.removeVoided !== 'boolean') problems.push('Choose whether to remove voided transactions.')
  }
  return problems
}
