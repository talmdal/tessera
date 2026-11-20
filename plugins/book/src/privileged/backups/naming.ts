// Backup file names. They are for people: Tessera identifies a backup by its header, never by its name.
// See docs/backup-restore-design.md, "File names".
import { BACKUP_FILE_EXTENSION, type BackupTrigger } from '@tessera/book-api'

/** Characters Windows rejects in a file name (the strictest platform), and control characters everywhere. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g
/** Names Windows reserves for devices, whatever follows them. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** Longest book name kept, in characters: the stamp and suffix still fit any file system's limit. */
const MAX_NAME = 100

const SUFFIX: Record<BackupTrigger, string> = { auto: '', manual: ' (manual)', 'pre-restore': ' (before restore)' }

/** A book name made safe to start a file name with, on every platform. */
export function safeFileName(name: string): string {
  let safe = Array.from(name.replace(UNSAFE, '_').trim()).slice(0, MAX_NAME).join('')
  safe = safe.replace(/[. ]+$/, '')         // Windows drops a trailing dot or space, so a name ending in one would change
  if (safe === '') safe = 'Book'
  if (RESERVED.test(safe)) safe = `${safe}_`
  return safe
}

const two = (n: number) => String(n).padStart(2, '0')

/** `2026-11-19 18.42.10`, in local time: what the user sees in their file manager. No colons, which Windows rejects. */
export function backupStamp(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`
}

/**
 * `Home Finances 2026-11-19 18.42.10 (manual).tessera-backup`. `attempt` 2 and later add ` (2)`…, for a name already
 * taken (two backups of one book in the same second).
 */
export function backupFileName(bookName: string, takenAt: Date, trigger: BackupTrigger, attempt = 1): string {
  const counter = attempt > 1 ? ` (${attempt})` : ''
  return `${safeFileName(bookName)} ${backupStamp(takenAt)}${SUFFIX[trigger]}${counter}${BACKUP_FILE_EXTENSION}`
}

/** A file being written ends with this until it is complete and renamed. Never listed as a backup. */
export const PARTIAL_SUFFIX = '.partial'

/** Whether a file name is a (complete) backup's: by extension, ignoring case, as file managers do. */
export const isBackupFileName = (name: string) => name.toLowerCase().endsWith(BACKUP_FILE_EXTENSION)
