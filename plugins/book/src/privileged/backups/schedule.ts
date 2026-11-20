// Whether an automatic backup is due when a book closes. Pure: the caller passes the time.
// See docs/backup-restore-design.md, "When one is due".
import type { BookBackupOptions } from '@tessera/book-api'

/** What the schedule needs to know about a book's backups. */
export interface BackupHistory {
  /** ISO time of the last successful backup on this machine, automatic or manual. */
  lastBackupAt?: string
  lastResult?: 'ok' | 'failed' | 'interrupted'
  /** Something was written to the book since `lastBackupAt`. */
  changed: boolean
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** A local calendar date as a whole day count, so a daylight-saving change never makes a day 23 or 25 hours. */
const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY

/** The local calendar date one month after `date`'s, clamped to the month's length: 31 January → 28 (or 29) February. */
function monthAfter(date: Date): number {
  const year = date.getFullYear() + (date.getMonth() === 11 ? 1 : 0)
  const month = (date.getMonth() + 1) % 12
  const lastDay = new Date(year, month + 1, 0).getDate()
  return Date.UTC(year, month, Math.min(date.getDate(), lastDay)) / MS_PER_DAY
}

/**
 * Whether closing a book now should take an automatic backup. The frequency is the least time between backups, in
 * local calendar days: a close after a week away takes one backup, never one per missed period. A book that hasn't
 * changed since its last backup is never backed up again, unless it has never been backed up at all.
 */
export function isBackupDue(history: BackupHistory | undefined, options: Pick<BookBackupOptions, 'automatic' | 'frequency'>, now: Date): boolean {
  if (!options.automatic) return false
  const last = history?.lastBackupAt === undefined ? undefined : new Date(history.lastBackupAt)
  if (last === undefined || Number.isNaN(last.getTime())) return true
  if (!history!.changed) return false
  // A failed or interrupted attempt is retried at the next close, however soon
  if (history!.lastResult !== undefined && history!.lastResult !== 'ok') return true

  // A clock set back makes "now" earlier than the last backup; that is not a reason to stop backing up
  if (now.getTime() < last.getTime()) return true
  switch (options.frequency) {
    case 'everyClose': return true
    case 'daily': return dayNumber(now) > dayNumber(last)
    case 'weekly': return dayNumber(now) - dayNumber(last) >= 7
    case 'monthly': return dayNumber(now) >= monthAfter(last)
  }
}
