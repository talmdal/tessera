// Backup file names: `Home 2026-11-09 10-14-05.tesserabkp`, the ledger's name and the local date and time.
import path from 'node:path'
import { LEDGER_BACKUP_EXTENSION } from '@tessera/ledger-api'

/** What a backup is written as until it has been checked, so a half-written one never has a backup's name. */
export const PARTIAL_SUFFIX = '.partial'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The suggested name: the ledger's name, then the local date and time, which sort by date and are valid on every
 * platform (no colons). People read the name, so it is local time; the meta holds UTC.
 */
export function backupFileName(ledgerName: string, at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  return `${ledgerName} ${date} ${time}${LEDGER_BACKUP_EXTENSION}`
}

/** Whether a file has a backup's extension (any case). */
export const isBackupFile = (file: string) => path.extname(file).toLowerCase() === LEDGER_BACKUP_EXTENSION

/** A path with the backup extension, added when the user typed a name without it. */
export const withBackupExtension = (file: string) => isBackupFile(file) ? file : file + LEDGER_BACKUP_EXTENSION

/** `file`, or `name (2).tesserabkp`, `name (3)…`: the first that doesn't exist. */
export async function unusedPath(file: string, exists: (file: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(file))) return file
  const extension = path.extname(file)
  const stem = file.slice(0, file.length - extension.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`
    if (!(await exists(candidate))) return candidate
  }
}

const day = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/** A restored ledger's suggested name: `Home (restored 2026-11-09)`. */
export const restoredName = (ledgerName: string, at: Date) => `${ledgerName} (restored ${day(at)})`

/** The suggested name to keep the current file under when a backup takes its place: `Home (before restore 2026-11-09 10-14)`. */
export const keptName = (ledgerName: string, at: Date) => `${ledgerName} (before restore ${day(at)} ${pad(at.getHours())}-${pad(at.getMinutes())})`

/** "10:14", as the user's clock shows it, for "Backed up “Home” at 10:14". */
export const clockTime = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "9 Nov 2026, 10:14", as the user's locale shows it, for a problem seen at the next start. */
export const dateTime = (at: Date) => at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
