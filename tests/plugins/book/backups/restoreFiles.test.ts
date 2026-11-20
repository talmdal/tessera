// @vitest-environment node
// Restore on real files: SQLite books, the node disks and a trash folder, as the app runs them. What the memory
// tests can't show: side files, the staged file renamed into place, the old file moved (never deleted).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine } from '@tessera/storage-kit'
import { BOOK_OPTIONS_DEFAULTS } from '@tessera/book-api'
import { ExtensionRegistryImpl } from '../../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../../core/services/ServiceRegistry'
import { nodeDisk } from '../../../../plugins/book/src/privileged/disk'
import { BookSessionImpl } from '../../../../plugins/book/src/privileged/BookSessionImpl'
import { RecentBooks } from '../../../../plugins/book/src/privileged/RecentBooks'
import { SchemaRegistry } from '../../../../plugins/book/src/privileged/SchemaRegistry'
import { nodeBackupDisk } from '../../../../plugins/book/src/privileged/backups/BackupDisk'
import { BackupLedger } from '../../../../plugins/book/src/privileged/backups/BackupLedger'
import { Backups } from '../../../../plugins/book/src/privileged/backups/Backups'
import { Restorer } from '../../../../plugins/book/src/privileged/backups/Restorer'
import { sqliteDriver } from '../../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { createTempModulesDir } from '../../../helpers/tempModules'
import { fakePrompts, logger, memoryAppState } from '../harness'

function setup() {
  const dir = createTempModulesDir()
  const trash = path.join(dir, '.trash')
  const engine = new KitStorageEngine(sqliteDriver({ directory: path.join(dir, 'storage') }))
  const log = logger()
  const files = {
    showOpenDialog: vi.fn(async () => undefined), showFolderDialog: vi.fn(async () => undefined), showSaveDialog: vi.fn(async () => undefined),
    exists: async (f: string) => fs.existsSync(f),
    // The OS trash, as a folder: the file is moved, never deleted
    trash: vi.fn(async (f: string) => { fs.mkdirSync(trash, { recursive: true }); fs.renameSync(f, path.join(trash, path.basename(f))) }),
    documentsPath: () => dir
  }
  const schema = new SchemaRegistry(new ExtensionRegistryImpl(), new ServiceRegistryImpl(), log)
  const session = new BookSessionImpl({
    engine, files, prompts: fakePrompts().prompts, recent: new RecentBooks(memoryAppState()), schema, disk: nodeDisk(), log, trashName: 'Trash'
  })
  const backupDisk = nodeBackupDisk()
  const backups = new Backups({
    disk: backupDisk, ledger: new BackupLedger(memoryAppState()), files, engineId: engine.id, log,
    options: () => BOOK_OPTIONS_DEFAULTS.backups
  })
  backups.attach(session)
  const restorer = new Restorer({ session, engine, backupDisk, bookDisk: nodeDisk(), backups, contributions: () => schema.contributions(), log, trashName: 'Trash' })
  const at = (name: string) => path.join(dir, name)
  const names = async () => (await session.tree()).subBooks.map(s => s.name).sort()
  /** Everything in a folder except the backups folder, so leftovers (staging, side files) show. */
  const listing = (folder: string) => fs.readdirSync(folder).filter(f => f !== 'Tessera Backups' && f !== 'storage').sort()
  return { dir, trash, session, backups, restorer, at, names, listing }
}

describe('restoring on real SQLite files', () => {
  it('replaces the open book: the old file is in the trash, the restored one in its place, nothing left over', async () => {
    const { session, backups, restorer, at, names, listing, trash } = setup()
    await session.create(at('Home.tessera'))
    await session.createSubBook({ name: 'Before', parentId: null })
    const backup = await backups.backUpNow(session.unscopedDatabase(), session.current!)
    await session.createSubBook({ name: 'After', parentId: null })

    const outcome = await restorer.restore(backup, { kind: 'replace' })

    expect(outcome.book.path).toBe(at('Home.tessera'))
    expect(await names()).toEqual(['Before'])
    expect(fs.existsSync(path.join(trash, 'Home.tessera'))).toBe(true)
    expect(fs.existsSync(outcome.safetyBackup!)).toBe(true)
    // While open, SQLite keeps its write-ahead log beside the book; no staging file or its side files remain
    expect(listing(path.dirname(at('Home.tessera'))).filter(f => f.includes('.restoring-'))).toEqual([])

    // And it really is the book on disk: closed and reopened, the restored content is still there
    await session.close()
    await session.open(at('Home.tessera'))
    expect(await names()).toEqual(['Before'])
  })

  it('restores as a new book beside the open one, which is left exactly as it was', async () => {
    const { session, backups, restorer, at, names } = setup()
    await session.create(at('Home.tessera'))
    await session.createSubBook({ name: 'Before', parentId: null })
    const backup = await backups.backUpNow(session.unscopedDatabase(), session.current!)
    await session.createSubBook({ name: 'Only in Home', parentId: null })

    await restorer.restore(backup, { kind: 'new', path: at('Restored.tessera') })
    expect(session.current?.path).toBe(at('Restored.tessera'))
    expect(await names()).toEqual(['Before'])

    await session.open(at('Home.tessera'))
    expect(await names()).toEqual(['Before', 'Only in Home'])
  })

  it('leaves no staging file behind when the backup turns out to be damaged', async () => {
    const { session, backups, restorer, at, names, listing } = setup()
    await session.create(at('Home.tessera'))
    await session.createSubBook({ name: 'Mine', parentId: null })
    const backup = await backups.backUpNow(session.unscopedDatabase(), session.current!)
    const bytes = fs.readFileSync(backup)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    fs.writeFileSync(backup, bytes)
    const before = listing(path.dirname(at('Home.tessera')))

    await expect(restorer.restore(backup, { kind: 'replace' })).rejects.toMatchObject({ code: 'DAMAGED' })
    expect(listing(path.dirname(at('Home.tessera')))).toEqual(before)
    expect(await names()).toEqual(['Mine'])
  })
})

describe('renaming a closed book with its side files', () => {
  it('moves every side file with it, and deletes nothing', async () => {
    const dir = createTempModulesDir()
    const from = path.join(dir, '.Home.restoring-x.tessera')
    for (const [suffix, text] of [['', 'db'], ['-wal', 'log'], ['-shm', 'shm']]) fs.writeFileSync(from + suffix, text)
    await nodeDisk().renameWithSideFiles(from, path.join(dir, 'Home.tessera'))
    expect(fs.readdirSync(dir).sort()).toEqual(['Home.tessera', 'Home.tessera-shm', 'Home.tessera-wal'])
    expect(fs.readFileSync(path.join(dir, 'Home.tessera-wal'), 'utf8')).toBe('log')
  })
})
