// @vitest-environment node
// An archive written from a real book file, in each storage engine, and read back after a restart. An archive is an
// ordinary book written by the active engine (not an engine-neutral backup file), so it round-trips within an
// engine, not across them. See docs/archive-design.md, "The archive file".
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { StorageEngine } from '@tessera/types'
import { BOOK_META, type BookInfo } from '@tessera/book-api'
import { sqliteDriver } from '../../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { lokiDriver } from '../../../../plugins/storage.loki/src/privileged/LokiDriver'
import { nodeDisk } from '../../../../plugins/book/src/privileged/disk'
import { nodeBackupDisk } from '../../../../plugins/book/src/privileged/backups/BackupDisk'
import { ArchiveWriter } from '../../../../plugins/book/src/privileged/archive/ArchiveWriter'
import { fillBook } from '../backups/helpers'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-archive-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

/**
 * Each engine that writes real files, over storage that outlives the engine object, so a fresh one is a restart.
 * The memory engine is not here: it writes no file for `nodeDisk` to rename. It is covered in archiveWriter.test.ts.
 */
const ENGINES: Record<string, (directory: string) => () => StorageEngine> = {
  sqlite: directory => () => new KitStorageEngine(sqliteDriver({ directory })),
  loki: directory => () => new KitStorageEngine(lokiDriver({ directory, saveDelay: 10 }))
}

const TAKEN_AT = '2026-11-20T10:14:02.771Z'
const BEFORE = '2026-01-01'

describe('an archive is a book, written by the active engine', () => {
  for (const engineName of Object.keys(ENGINES)) {
    it(`round-trips through a real file in ${engineName}`, async () => {
      const storage = tempDir()
      const folder = tempDir()
      const makeEngine = ENGINES[engineName](storage)

      // A book with everything in it that a book has: indexes, revisions, awkward text, a plugin that isn't here
      const engine = makeEngine()
      const bookFile = path.join(storage, 'Home Finances.tessera')
      const db = await engine.open({ path: bookFile })
      await fillBook(db)
      const original = await db.snapshot()
      const book: BookInfo = { id: original.meta[BOOK_META.id] as string, path: bookFile, name: 'Home Finances', readOnly: false }

      const writer = new ArchiveWriter({
        engine,
        bookDisk: nodeDisk(),
        folders: nodeBackupDisk(),
        probe: vi.fn(async () => {}),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        now: () => new Date(TAKEN_AT),
        app: 'book 0.1.0'
      })

      const outcome = await writer.write(db, book, { before: BEFORE, folder })

      expect(outcome.file).toBe(path.join(folder, 'Home Finances Archive through 2026-01-01.tessera'))
      expect(outcome.documents).toBe(original.collections.reduce((n, c) => n + c.docs.length, 0))
      await engine.closeAll()

      // The book it was cut from is untouched, and still opens
      const checkSource = ENGINES[engineName](storage)()
      expect(await (await checkSource.open({ path: bookFile })).snapshot()).toEqual(original)
      await checkSource.closeAll()

      // After a restart, the archive holds the book exactly, plus its own identity
      const restarted = ENGINES[engineName](folder)()
      const archive = await restarted.open({ path: outcome.file }, { readOnly: true })
      const written = await archive.snapshot()

      expect(written.collections).toEqual(original.collections)
      expect(written.meta[BOOK_META.readOnly]).toBe(true)
      expect(written.meta[BOOK_META.archive]).toEqual({
        of: book.id, ofName: 'Home Finances', takenAt: TAKEN_AT, through: BEFORE, app: 'book 0.1.0'
      })
      expect(written.meta[BOOK_META.id]).not.toBe(original.meta[BOOK_META.id])
      // Everything else about the book came across, the schema versions included
      expect(written.meta[BOOK_META.format]).toBe(original.meta[BOOK_META.format])
      expect(written.meta[BOOK_META.schemaVersion('accounts')]).toBe(3)

      // It is frozen: nothing can be written to it, even by the engine that made it
      await expect(archive.collection('accounts.accounts').insert({ code: 'NEW' })).rejects.toMatchObject({ code: 'READ_ONLY' })
      await restarted.closeAll()

      // No staging file was left in the archive folder
      expect(fs.readdirSync(folder).filter(f => f.includes('.archiving-'))).toEqual([])
      expect(fs.readdirSync(folder).filter(f => f.endsWith('.tessera')).length).toBe(1)
    })
  }
})
