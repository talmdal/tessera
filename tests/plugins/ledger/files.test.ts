// @vitest-environment node
// The ledger on real files: the SQLite engine and the node disk, as the app runs them.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { KitStorageEngine } from '@tessera/storage-kit'
import { LEDGER_META, isLedgerError } from '@tessera/ledger-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import { classify, nodeDisk } from '../../../plugins/ledger/src/privileged/disk'
import { LedgerSessionImpl } from '../../../plugins/ledger/src/privileged/LedgerSessionImpl'
import { RecentLedgers } from '../../../plugins/ledger/src/privileged/RecentLedgers'
import { SchemaRegistry } from '../../../plugins/ledger/src/privileged/SchemaRegistry'
import { sqliteDriver } from '../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { createTempModulesDir } from '../../helpers/tempModules'
import { fakePrompts, logger, memoryAppState } from './harness'

function setup() {
  const dir = createTempModulesDir()
  const trash = path.join(dir, '.trash')
  const engine = new KitStorageEngine(sqliteDriver({ directory: path.join(dir, 'storage') }))
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  const log = logger()
  const files = {
    showOpenDialog: vi.fn(async () => undefined), showSaveDialog: vi.fn(async () => undefined),
    exists: async (f: string) => fs.existsSync(f),
    // The OS trash, as a folder: the file is moved, never deleted
    trash: vi.fn(async (f: string) => { fs.mkdirSync(trash, { recursive: true }); fs.renameSync(f, path.join(trash, path.basename(f))) }),
    documentsPath: () => dir
  }
  const session = new LedgerSessionImpl({
    engine, files, prompts: fakePrompts().prompts, recent: new RecentLedgers(memoryAppState(), () => new Date('2026-11-04T10:11:12Z')),
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

describe('classify', () => {
  it('tells SQLite, JSON, empty and other files apart from their first bytes', () => {
    expect(classify(Buffer.from('SQLite format 3\0rest', 'latin1'))).toBe('sqlite')
    expect(classify(Buffer.from('\uFEFF  {"a":1}'))).toBe('json')
    expect(classify(Buffer.from('[1,2]'))).toBe('json')
    expect(classify(Buffer.alloc(0))).toBe('empty')
    expect(classify(Buffer.from('PK\u0003\u0004'))).toBe('unknown')
  })
})
