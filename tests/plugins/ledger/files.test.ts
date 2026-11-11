// @vitest-environment node
// The ledger on real files: the SQLite engine and the node disk, as the app runs them.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { KitStorageEngine } from '@tessera/storage-kit'
import { LEDGER_BACKUP_META, LEDGER_META, isLedgerError } from '@tessera/ledger-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import { classify, nodeDisk } from '../../../plugins/ledger/src/privileged/disk'
import { LedgerSessionImpl } from '../../../plugins/ledger/src/privileged/LedgerSessionImpl'
import { RecentLedgers } from '../../../plugins/ledger/src/privileged/RecentLedgers'
import { SchemaRegistry } from '../../../plugins/ledger/src/privileged/SchemaRegistry'
import { BackupService } from '../../../plugins/ledger/src/privileged/backup/BackupService'
import { RestoreService } from '../../../plugins/ledger/src/privileged/backup/restore'
import { sqliteDriver } from '../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { createTempModulesDir } from '../../helpers/tempModules'
import { fakePrompts, logger, memoryAppState, pluginState } from './harness'

function setup() {
  const dir = createTempModulesDir()
  const trash = path.join(dir, '.trash')
  const engine = new KitStorageEngine(sqliteDriver({ directory: path.join(dir, 'storage') }))
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  const log = logger()
  const files = {
    showOpenDialog: vi.fn(async () => undefined), showOpenFilesDialog: vi.fn(async (): Promise<string[]> => []),
    showOpenFolderDialog: vi.fn(async (): Promise<string | undefined> => undefined),
    showSaveDialog: vi.fn(async () => undefined),
    exists: async (f: string) => fs.existsSync(f),
    // The OS trash, as a folder: the file is moved, never deleted
    trash: vi.fn(async (f: string) => { fs.mkdirSync(trash, { recursive: true }); fs.renameSync(f, path.join(trash, path.basename(f))) }),
    documentsPath: () => dir,
    downloadsPath: () => dir
  }
  const session = new LedgerSessionImpl({
    engine, files, prompts: fakePrompts().prompts, recent: new RecentLedgers(pluginState('ledger', memoryAppState()), () => new Date('2026-11-04T10:11:12Z')),
    schema: new SchemaRegistry(extensions, services, log), disk: nodeDisk(), log, trashName: 'Trash',
    now: () => new Date('2026-11-04T10:11:12Z')
  })
  return { dir, trash, engine, extensions, services, session, files, at: (name: string) => path.join(dir, name) }
}

const bytes = (file: string) => fs.readFileSync(file)

describe('ledgers on disk (SQLite)', () => {
  it('creates a SQLite file that survives closing and reopening, sub-ledgers included', async () => {
    const { session, at } = setup()
    await session.create(at('Home.tessera'))
    await session.createSubLedger({ name: 'Personal', parentId: null })
    await session.close()

    expect(classify(bytes(at('Home.tessera')).subarray(0, 16))).toBe('sqlite')
    await session.open(at('Home.tessera'))
    expect((await session.tree()).subLedgers.map(s => s.name)).toEqual(['Personal'])
    await session.close()
  })

  it('never creates a file it was asked to open', async () => {
    const { session, at } = setup()
    const err = await session.open(at('Missing.tessera')).catch(e => e)
    expect(err).toMatchObject({ code: 'FILE_NOT_FOUND' })
    expect(fs.existsSync(at('Missing.tessera'))).toBe(false)
  })

  it('leaves a SQLite file that is not a ledger exactly as it was', async () => {
    const { session, at } = setup()
    const other = new DatabaseSync(at('photos.db'))
    other.exec('CREATE TABLE photo (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO photo (name) VALUES (\'cat\')')
    other.close()
    const before = bytes(at('photos.db'))

    const err = await session.open(at('photos.db')).catch(e => e)

    expect(isLedgerError(err) && err.code).toBe('UNSUPPORTED_FILE')
    expect(bytes(at('photos.db')).equals(before)).toBe(true)
    expect(fs.readdirSync(path.dirname(at('photos.db'))).filter(f => f.startsWith('photos.db'))).toEqual(['photos.db'])
  })

  it('refuses a ledger whose meta is fine but whose data is damaged, before closing the open ledger', async () => {
    const { session, at } = setup()
    await session.create(at('Damaged.tessera'))
    await session.close()
    const raw = new DatabaseSync(at('Damaged.tessera'))
    raw.exec(`INSERT INTO tessera_documents (collection, id, doc) VALUES ('ledger.subledgers', 'broken', '{not json')`)
    raw.close()
    await session.create(at('Home.tessera'))

    const err = await session.open(at('Damaged.tessera')).catch(e => e)

    expect(err).toMatchObject({ code: 'UNSUPPORTED_FILE', message: '“Damaged.tessera” is not a Tessera ledger, or it is damaged.' })
    expect(session.current?.name).toBe('Home')
    expect((await session.createSubLedger({ name: 'Still works', parentId: null })).name).toBe('Still works')
  })

  it('explains a JSON file (say, a LokiJS ledger) rather than failing to read it', async () => {
    const { session, at } = setup()
    fs.writeFileSync(at('Loki.tessera'), '{"filename":"x","collections":[]}')
    const err = await session.open(at('Loki.tessera')).catch(e => e)
    expect(err).toMatchObject({ code: 'UNSUPPORTED_FILE', message: expect.stringContaining('active storage engine (SQLite)') })
  })

  it('calls any other file not a ledger', async () => {
    const { session, at } = setup()
    fs.writeFileSync(at('notes.txt'), 'hello')
    fs.writeFileSync(at('empty.tessera'), '')
    expect(await session.open(at('notes.txt')).catch(e => e.message)).toBe('“notes.txt” is not a Tessera ledger.')
    expect(await session.open(at('empty.tessera')).catch(e => e.message)).toBe('“empty.tessera” is not a Tessera ledger.')
  })

  it('backs up a ledger before upgrading it, next to it, without overwriting an earlier backup', async () => {
    const env = setup()
    env.extensions.contribute('accounts', 'ledger.schema', 'accounts', { id: 'accounts', version: 1, migrator: 'accounts.migrator', collections: [] })
    env.services.provide('accounts', 'accounts.migrator', { migrate: async () => {} })
    await env.session.create(env.at('Home.tessera'))
    await env.session.close()
    env.extensions.getContributions('ledger.schema')[0].impl = { id: 'accounts', version: 2, migrator: 'accounts.migrator', collections: [] }

    await env.session.open(env.at('Home.tessera'))
    await env.session.close()

    const backup = env.at('Home.backup-2026-11-04_10-11-12.tessera')
    expect(classify(bytes(backup).subarray(0, 16))).toBe('sqlite')
    const db = await env.engine.open({ path: backup }, { readOnly: true })
    expect(await db.meta.get(LEDGER_META.schemaVersion('accounts'))).toBe(1)
    await db.close()
  })

  it('sends a deleted ledger to the trash, with any side files', async () => {
    const { session, at, trash } = setup()
    await session.create(at('Home.tessera'))
    await session.close()
    fs.writeFileSync(at('Home.tessera-wal'), '')    // as left by a crash

    expect(await session.delete(at('Home.tessera'))).toBe(true)

    expect(fs.existsSync(at('Home.tessera'))).toBe(false)
    expect(fs.readdirSync(trash).sort()).toEqual(['Home.tessera', 'Home.tessera-wal'])
  })
})

describe('backups on real files', () => {
  it('backs up to a real folder as one checked SQLite file, names a second one (2), and trims with real files', async () => {
    const env = setup()
    const ledger = (await env.session.create(env.at('Home.tessera')))!
    await env.session.createSubLedger({ name: 'Personal', parentId: null })
    const folder = env.at('Tessera Backups')
    const now = new Date(2026, 10, 9, 10, 14, 5)
    const backups = new BackupService({
      session: env.session, engine: env.engine, files: env.files, disk: nodeDisk(), state: pluginState('ledger', memoryAppState()),
      settings: () => ({ folder, onClose: true, trim: true, retentionDays: 30, keepAtLeast: 1 }), log: logger(), now: () => now
    })
    // An expired backup of this ledger, made by hand: a copy of a real backup, dated 40 days back
    const old = await backups.backUp(path.join(folder, 'Home old'), { kind: 'auto' })
    const raw = new DatabaseSync(old.path)
    raw.prepare('UPDATE tessera_meta SET value = ? WHERE key = ?').run(JSON.stringify(new Date(now.getTime() - 40 * 86_400_000).toISOString()), 'backup.takenAt')
    raw.close()

    const suggested = await backups.suggestedPath('Home')
    const first = await backups.backUp(suggested, { kind: 'manual' })
    const second = await backups.backUp(await backups.suggestedPath('Home'), { kind: 'manual' })

    expect(path.basename(first.path)).toBe('Home 2026-11-09 10-14-05.tesserabkp')
    expect(path.basename(second.path)).toBe('Home 2026-11-09 10-14-05 (2).tesserabkp')
    expect(classify(bytes(first.path).subarray(0, 16))).toBe('sqlite')
    const copy = new DatabaseSync(first.path, { readOnly: true })
    expect(copy.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect((copy.prepare("SELECT doc FROM tessera_documents WHERE collection = 'ledger.subledgers'").all() as { doc: string }[]).map(r => JSON.parse(r.doc).name)).toEqual(['Personal'])
    copy.close()
    expect(first.ledgerId).toBe(ledger.id)

    const trimmed = await backups.trim(second)
    expect(trimmed).toEqual({ trashed: [old.path], deleted: [], failed: [] })
    expect(fs.readdirSync(folder).sort()).toEqual(['Home 2026-11-09 10-14-05 (2).tesserabkp', 'Home 2026-11-09 10-14-05.tesserabkp'])
    expect(fs.readdirSync(env.trash)).toEqual(['Home old.tesserabkp'])
    expect(env.session.current?.name).toBe('Home')
  })
})

describe('restoring on real files', () => {
  it('restores in place of a crashed ledger: its -wal goes with the kept file, never into the restored one', async () => {
    const env = setup()
    const now = new Date(2026, 10, 9, 10, 14, 5)
    const folder = env.at('Tessera Backups')
    const log = logger()
    const disk = nodeDisk()
    const backups = new BackupService({
      session: env.session, engine: env.engine, files: env.files, disk, state: pluginState('ledger', memoryAppState()),
      settings: () => ({ folder, onClose: true, trim: true, retentionDays: 30, keepAtLeast: 5 }), log, now: () => now
    })
    const restore = new RestoreService({
      session: env.session, engine: env.engine, files: env.files, disk, recent: { list: async () => [] },
      backupFolder: () => folder, log, now: () => now
    })
    const home = env.at('Home.tessera')
    const ledger = (await env.session.create(home))!
    await env.session.createSubLedger({ name: 'Before', parentId: null })
    const backup = await backups.backUp(await backups.suggestedPath('Home'), { kind: 'manual' })
    await env.session.createSubLedger({ name: 'After', parentId: null })
    await env.session.close()

    // Home as a crash leaves it: a write that is only in its -wal
    const before = fs.readFileSync(home)
    const raw = new DatabaseSync(home)
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
    raw.prepare('INSERT INTO tessera_documents (collection, id, doc) VALUES (?, ?, ?)').run('ledger.subledgers', 'late', JSON.stringify({ id: 'late', rev: 1, name: 'Only in the WAL', parentId: null, order: 9 }))
    const wal = fs.readFileSync(`${home}-wal`)
    raw.close()
    fs.writeFileSync(home, before)
    fs.writeFileSync(`${home}-wal`, wal)

    restore.begin()
    await restore.preselect(backup.path)
    const restored = await restore.run({ backup: backup.path, mode: 'inPlace', keepAs: 'Home (before restore)' })
    restore.end()

    const names = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return (db.prepare("SELECT doc FROM tessera_documents WHERE collection = 'ledger.subledgers'").all() as { doc: string }[]).map(r => JSON.parse(r.doc).name).sort()
      } finally { db.close() }
    }
    expect(restored).toMatchObject({ ledger: { path: home, id: ledger.id }, kept: env.at('Home (before restore).tessera') })
    await env.session.close()
    expect(names(home)).toEqual(['Before'])
    const kept = env.at('Home (before restore).tessera')
    expect(names(kept)).toEqual(['After', 'Before', 'Only in the WAL'])
    expect(fs.readdirSync(env.dir).filter(f => f.includes('.restoring-'))).toEqual([])
    expect(fs.existsSync(env.trash)).toBe(false)
  })
})

describe('archive files on real files', () => {
  it('opens one read-only and leaves it byte for byte as it was, with nothing beside it', async () => {
    const { session, at } = setup()
    await session.create(at('Home.tessera'))
    await session.createSubLedger({ name: 'Personal', parentId: null })
    const archive = at('Archives/Home (archive before 2026-01-01).tesserabkp')
    await session.withOpenLedger(db => db.snapshot({ path: archive }, { meta: {
      [LEDGER_BACKUP_META.takenAt]: '2026-11-04T10:11:12.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: at('Home.tessera'), [LEDGER_BACKUP_META.takenWith]: 'ledger test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
    } }))
    const before = { bytes: bytes(archive), modified: fs.statSync(archive).mtimeMs }
    const sideFiles = () => fs.readdirSync(path.dirname(archive)).filter(f => f !== path.basename(archive))

    const opened = await session.open(archive)
    expect(opened).toMatchObject({ readOnly: true, archive: { before: '2026-01-01' } })
    expect((await session.tree()).subLedgers.map(s => s.name)).toEqual(['Personal'])
    await expect(session.createSubLedger({ name: 'Nope', parentId: null })).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(sideFiles()).toEqual([])
    await session.close()

    expect(bytes(archive).equals(before.bytes)).toBe(true)
    expect(fs.statSync(archive).mtimeMs).toBe(before.modified)
    expect(sideFiles()).toEqual([])
    // The header says a rollback journal, not WAL; the live ledger's says WAL
    expect(await nodeDisk().walMode(archive)).toBe(false)
    expect(await nodeDisk().walMode(at('Home.tessera'))).toBe(true)
  })
})

describe('classify', () => {
  it('tells SQLite, JSON, empty and other files apart from their first bytes', () => {
    expect(classify(Buffer.from('SQLite format 3\0rest', 'latin1'))).toBe('sqlite')
    expect(classify(Buffer.from('\uFEFF  {"a":1}'))).toBe('json')
    expect(classify(Buffer.from('[1,2]'))).toBe('json')
    expect(classify(Buffer.alloc(0))).toBe('empty')
    expect(classify(Buffer.from('PK\u0003\u0004'))).toBe('unknown')
  })
})
