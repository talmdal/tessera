// @vitest-environment node
// Retention: which backups are removed after a new one, and how. See docs/backup-restore-design.md, "Retention".
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { LEDGER_BACKUP_META, LEDGER_META } from '@tessera/ledger-api'
import { backupsToTrim, discard, trimFolder, type BackupRecord, type RetentionPolicy } from '../../../plugins/ledger/src/privileged/backup/retention'
import { DIR, errno, logger, memoryDisk } from './harness'

const DAY = 86_400_000
const NOW = new Date('2026-11-09T12:00:00Z')
const POLICY: RetentionPolicy = { trim: true, days: 30, keepAtLeast: 5 }
const FOLDER = path.join(DIR, 'Tessera Backups')
const at = (name: string) => path.join(FOLDER, name)
/** A backup taken `days` days before NOW. */
const daysAgo = (days: number, name = `Home ${days}.tesserabkp`): BackupRecord =>
  ({ path: at(name), takenAt: new Date(NOW.getTime() - days * DAY).toISOString() })
const names = (records: BackupRecord[]) => records.map(r => path.basename(r.path))

describe('backupsToTrim', () => {
  const today = daysAgo(0, 'Home today.tesserabkp')

  it('removes the backups older than the period, oldest first: a backup a day for 40 days, then one today', () => {
    const records = [today, ...Array.from({ length: 40 }, (_, i) => daysAgo(i + 1))]
    expect(names(backupsToTrim(records, POLICY, NOW, today.path)))
      .toEqual(['Home 40', 'Home 39', 'Home 38', 'Home 37', 'Home 36', 'Home 35', 'Home 34', 'Home 33', 'Home 32', 'Home 31'].map(n => `${n}.tesserabkp`))
  })

  it('always keeps the newest five, the new one counting: six old backups, then one today', () => {
    const records = [today, ...[40, 50, 60, 70, 80, 90].map(d => daysAgo(d))]
    expect(names(backupsToTrim(records, POLICY, NOW, today.path))).toEqual(['Home 90.tesserabkp', 'Home 80.tesserabkp'])
  })

  it('removes nothing while there are no more than five', () => {
    expect(backupsToTrim([today, daysAgo(400), daysAgo(500), daysAgo(600)], POLICY, NOW, today.path)).toEqual([])
  })

  it('removes nothing when trimming is off', () => {
    expect(backupsToTrim([today, ...Array.from({ length: 40 }, (_, i) => daysAgo(i + 1))], { ...POLICY, trim: false }, NOW, today.path)).toEqual([])
  })

  it('never removes the backup just made, one whose date can\'t be read, or one dated in the future', () => {
    const misdated = { path: at('Home odd.tesserabkp'), takenAt: 'not a date' }
    const future = daysAgo(-3, 'Home future.tesserabkp')
    // The one just made is old by its own clock: it is still kept
    const justMade = daysAgo(100, 'Home just made.tesserabkp')
    const records = [justMade, misdated, future, ...[31, 32, 33, 34, 35, 36, 37].map(d => daysAgo(d))]
    const trimmed = names(backupsToTrim(records, { ...POLICY, keepAtLeast: 1 }, NOW, justMade.path))
    expect(trimmed).not.toContain('Home just made.tesserabkp')
    expect(trimmed).not.toContain('Home odd.tesserabkp')
    expect(trimmed).not.toContain('Home future.tesserabkp')
  })

  it('holds to its rules whatever the backups, the period and the number kept', () => {
    let seed = 7
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let run = 0; run < 300; run++) {
      const policy = { trim: true, days: 1 + Math.floor(random() * 60), keepAtLeast: 1 + Math.floor(random() * 8) }
      const records = Array.from({ length: Math.floor(random() * 25) }, (_, i) => daysAgo(Math.floor(random() * 120), `b${i}.tesserabkp`))
      const justMade = records[0]?.path ?? at('none')
      const trimmed = backupsToTrim(records, policy, NOW, justMade)
      // Ties in date make "the newest five" ambiguous, so the rule is: at least that many kept, none trimmed newer
      const dates = records.map(r => Date.parse(r.takenAt)).sort((a, b) => b - a)
      const kthNewest = dates[Math.min(policy.keepAtLeast, dates.length) - 1]
      expect(trimmed.length).toBeLessThanOrEqual(Math.max(0, records.length - policy.keepAtLeast))
      for (const r of trimmed) {
        expect(r.path).not.toBe(justMade)
        expect(NOW.getTime() - Date.parse(r.takenAt)).toBeGreaterThan(policy.days * DAY)
        expect(Date.parse(r.takenAt)).toBeLessThanOrEqual(kthNewest)
      }
      // Oldest first
      expect(trimmed.map(r => Date.parse(r.takenAt))).toEqual([...trimmed.map(r => Date.parse(r.takenAt))].sort((a, b) => a - b))
    }
  })
})

describe('trimFolder', () => {
  function setup() {
    const driver = memoryDriver()
    const engine = new KitStorageEngine(driver)
    const { disk, foreign, hooks } = memoryDisk(driver)
    const trashed: string[] = []
    const files = { trash: vi.fn(async (f: string) => { trashed.push(f); driver.databases.delete(f) }) }
    const log = logger()
    /** A backup file: a database whose meta says what it is. */
    const backup = (file: string, meta: Record<string, unknown>) => {
      driver.databases.set(file, { collections: new Map(), meta: new Map(Object.entries(meta) as [string, never][]) })
    }
    const of = (ledgerId: string, record: BackupRecord) =>
      backup(record.path, { [LEDGER_META.format]: 1, [LEDGER_META.id]: ledgerId, [LEDGER_BACKUP_META.takenAt]: record.takenAt })
    return { driver, engine, disk, foreign, hooks, files, trashed, log, backup, of, deps: { disk, engine, files, log } }
  }
  const options = (justMade: string) => ({ folder: FOLDER, ledgerId: 'L1', justMade, policy: POLICY, now: NOW })

  it('removes only expired backups of the same ledger, directly in the folder', async () => {
    const env = setup()
    const today = daysAgo(0, 'Home today.tesserabkp')
    env.of('L1', today)
    for (const d of [1, 2, 3, 4, 40, 50]) env.of('L1', daysAgo(d))
    env.of('OTHER', daysAgo(60, 'Home other ledger.tesserabkp'))                 // another ledger called Home
    env.of('L1', { path: path.join(FOLDER, 'archive', 'Home 70.tesserabkp'), takenAt: daysAgo(70).takenAt })  // a subfolder
    env.of('L1', daysAgo(80, 'Home 80.tessera'))                                // not a backup's extension
    env.backup(at('Home 90.tesserabkp'), { [LEDGER_META.id]: 'L1', [LEDGER_BACKUP_META.takenAt]: daysAgo(90).takenAt })  // no format: not a ledger
    env.foreign.set(at('Home broken.tesserabkp'), 'unknown')                    // can't be read

    const result = await trimFolder(env.deps, options(today.path))

    expect(result).toEqual({ trashed: [at('Home 50.tesserabkp'), at('Home 40.tesserabkp')], deleted: [], failed: [] })
  })

  it('deletes a backup the trash refuses (no trash there), and leaves one it can\'t delete either', async () => {
    const env = setup()
    const today = daysAgo(0, 'Home today.tesserabkp')
    env.of('L1', today)
    for (const d of [1, 2, 3, 4, 40, 50]) env.of('L1', daysAgo(d))
    env.files.trash.mockRejectedValue(new Error('Trashing on system internal mounts is not supported'))
    env.hooks.remove = file => { if (file.endsWith('Home 50.tesserabkp')) throw errno('EACCES') }

    const result = await trimFolder(env.deps, options(today.path))

    expect(result).toEqual({ trashed: [], deleted: [at('Home 40.tesserabkp')], failed: [at('Home 50.tesserabkp')] })
    expect(env.driver.databases.has(at('Home 40.tesserabkp'))).toBe(false)
    expect(env.driver.databases.has(at('Home 50.tesserabkp'))).toBe(true)
    expect(env.log.info).toHaveBeenCalledWith(expect.stringContaining('couldn\'t go to the trash'))
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not remove'))
  })

  it('does nothing when trimming is off, or the folder is missing', async () => {
    const env = setup()
    for (const d of [1, 2, 3, 4, 5, 40, 50]) env.of('L1', daysAgo(d))
    expect(await trimFolder(env.deps, { ...options(at('x')), policy: { ...POLICY, trim: false } })).toEqual({ trashed: [], deleted: [], failed: [] })
    expect(await trimFolder(env.deps, { ...options(at('x')), folder: path.join(DIR, 'missing') })).toEqual({ trashed: [], deleted: [], failed: [] })
    expect(env.files.trash).not.toHaveBeenCalled()
  })
})

describe('discard', () => {
  it('prefers the trash', async () => {
    const env = { files: { trash: vi.fn(async () => {}) }, disk: { remove: vi.fn(async () => {}) }, log: logger() }
    expect(await discard(env, '/x')).toBe('trashed')
    expect(env.disk.remove).not.toHaveBeenCalled()
  })
})
