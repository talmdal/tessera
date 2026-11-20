// @vitest-environment node
// A book backed up from each storage engine into a real file, and restored into each engine: the backup file is
// engine-neutral, so all nine pairs must give back exactly the book that was backed up, after a restart too.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { StorageEngine } from '@tessera/types'
import { sqliteDriver } from '../../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { lokiDriver } from '../../../../plugins/storage.loki/src/privileged/LokiDriver'
import {
  backupHeader, readBackup, readBackupHeader, verifyBackup, writeBackup
} from '../../../../plugins/book/src/privileged/backups/backupFile'
import { nodeBackupDisk } from '../../../../plugins/book/src/privileged/backups/BackupDisk'
import { backupFileName } from '../../../../plugins/book/src/privileged/backups/naming'
import { bookSnapshot, SOURCE } from './helpers'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-roundtrip-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

/** Each engine, over storage that outlives the engine object, so a fresh one is a restart. */
const ENGINES: Record<string, (directory: string) => () => StorageEngine> = {
  memory: () => { const driver = memoryDriver(); return () => new KitStorageEngine(driver) },
  sqlite: directory => () => new KitStorageEngine(sqliteDriver({ directory })),
  loki: directory => () => new KitStorageEngine(lokiDriver({ directory, saveDelay: 10 }))
}

const disk = nodeBackupDisk()

describe('a backup restores into any engine', () => {
  for (const from of Object.keys(ENGINES)) {
    for (const to of Object.keys(ENGINES)) {
      it(`from ${from} to ${to}`, async () => {
        const folder = tempDir()

        // Back up a book open in `from`
        const source = ENGINES[from](tempDir())()
        const book = await source.open({ path: path.join(tempDir(), 'Home Finances.tessera') })
        const original = await bookSnapshot(book)
        const header = backupHeader({ ...SOURCE, engine: source.id }, original)
        const file = await disk.create(folder, n => backupFileName('Home Finances', SOURCE.takenAt, 'auto', n),
          out => writeBackup(out, header, original).then(() => undefined))
        await source.closeAll()

        // What the restore dialog and the restorer would read
        expect(await readBackupHeader(disk.open(file))).toEqual(header)
        expect(await verifyBackup(disk.open(file))).toEqual(header)
        const { snapshot } = await readBackup(disk.open(file))

        // Restore into a new, empty file in `to`, then restart and look
        const storage = tempDir()
        const target = path.join(storage, 'Restored.tessera')
        const makeTarget = ENGINES[to](storage)
        const restoring = makeTarget()
        await (await restoring.open({ path: target })).load(snapshot)
        await restoring.closeAll()

        const reopened = makeTarget()
        const restored = await reopened.open({ path: target })
        expect(await restored.snapshot()).toEqual(original)
        // Live, not just equal: the unique index holds and edits carry on from the stored revisions
        await expect(restored.collection('accounts.accounts').insert({ code: 'CHQ' })).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' })
        expect((await restored.collection('accounts.accounts').updateOne({ id: 'chq' }, { $set: { name: 'x' } })).modified).toBe(1)
        expect((await restored.collection('accounts.accounts').get('chq'))?.rev).toBe(3)
        await reopened.closeAll()
      })
    }
  }
})
