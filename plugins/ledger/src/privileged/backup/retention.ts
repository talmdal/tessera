// Retention: after a backup in the default backup folder, the expired backups of the same ledger there are removed.
// Only that folder, only that ledger (by `ledger.id`), only after a verified backup, never the one just made, and
// always the newest `keepAtLeast`. Removed means the trash, or deleted where the trash refuses (no trash on that
// volume), as settled in review. See docs/backup-restore-design.md, "Retention: trimming old backups".
import type { Logger, ShellFiles, StorageEngine } from '@tessera/types'
import { LEDGER_BACKUP_META, LEDGER_META } from '@tessera/ledger-api'
import type { LedgerDisk } from '../disk'
import { samePath } from '../paths'
import { isBackupFile } from './naming'

export interface RetentionPolicy {
  trim: boolean
  days: number
  keepAtLeast: number
}

export interface BackupRecord {
  path: string
  /** `backup.takenAt` from the backup's meta: ISO 8601. */
  takenAt: string
}

const DAY_MS = 86_400_000

/**
 * The backups to remove, oldest first. Never `justMade`, never one of the newest `keepAtLeast` (by `takenAt`, the one
 * just made counting), never one younger than `days`. A record whose date can't be read is never removed; a date in
 * the future (a wrong clock) counts as young.
 */
export function backupsToTrim(records: readonly BackupRecord[], policy: RetentionPolicy, now: Date, justMade: string): BackupRecord[] {
  if (!policy.trim) return []
  const dated = records
    .map(record => ({ record, at: Date.parse(record.takenAt) }))
    .filter(entry => Number.isFinite(entry.at))
    .sort((a, b) => b.at - a.at || a.record.path.localeCompare(b.record.path))
  const kept = new Set(dated.slice(0, Math.max(0, policy.keepAtLeast)).map(entry => entry.record))
  return dated
    .filter(({ record, at }) => !kept.has(record) && !samePath(record.path, justMade) && now.getTime() - at > policy.days * DAY_MS)
    .map(entry => entry.record)
    .reverse()
}

export interface TrimDeps {
  disk: Pick<LedgerDisk, 'list' | 'remove'>
  engine: Pick<StorageEngine, 'readMeta'>
  files: Pick<ShellFiles, 'trash'>
  log: Pick<Logger, 'info' | 'warn'>
}

export interface TrimResult {
  /** Moved to the OS trash. */
  trashed: string[]
  /** Deleted, because the trash refused them. */
  deleted: string[]
  /** Left where they were: neither worked. */
  failed: string[]
}

export type Discarded = 'trashed' | 'deleted' | 'failed'

/** Moves a file to the trash; where the trash refuses it, deletes it. */
export async function discard(
  { files, disk, log }: { files: Pick<ShellFiles, 'trash'>, disk: Pick<LedgerDisk, 'remove'>, log: Pick<Logger, 'info' | 'warn'> },
  file: string
): Promise<Discarded> {
  try {
    await files.trash(file)
    return 'trashed'
  } catch (trashError) {
    try {
      await disk.remove(file)
      log.info(`[ledger] ${file} couldn't go to the trash (${describe(trashError)}), so it was deleted`)
      return 'deleted'
    } catch (err) {
      log.warn(`[ledger] Could not remove ${file}: ${describe(err)}`)
      return 'failed'
    }
  }
}

/** The candidates in `folder` (backups of `ledgerId`, read from their meta), and what is removed of them. */
export async function trimFolder(deps: TrimDeps, options: { folder: string, ledgerId: string, justMade: string, policy: RetentionPolicy, now: Date }): Promise<TrimResult> {
  const result: TrimResult = { trashed: [], deleted: [], failed: [] }
  if (!options.policy.trim) return result
  const records: BackupRecord[] = []
  for (const file of await deps.disk.list(options.folder)) {
    if (!isBackupFile(file)) continue
    // A file that can't be read, or isn't a backup of this ledger, is never touched
    const meta = await deps.engine.readMeta({ path: file }).catch(() => undefined)
    if (!meta || typeof meta[LEDGER_META.format] !== 'number' || meta[LEDGER_META.id] !== options.ledgerId) continue
    const takenAt = meta[LEDGER_BACKUP_META.takenAt]
    if (typeof takenAt === 'string') records.push({ path: file, takenAt })
  }
  for (const { path } of backupsToTrim(records, options.policy, options.now, options.justMade)) {
    result[await discard(deps, path)].push(path)
  }
  return result
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)
