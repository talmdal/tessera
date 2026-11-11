// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KitStorageEngine } from '@tessera/storage-kit'
import { sqliteDriver } from '../../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { describeStorageEngine } from '../../storage/conformance'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-sqlite-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const engineFor = (directory: string) => new KitStorageEngine(sqliteDriver({ directory }))

describeStorageEngine('sqlite', async () => {
  const directory = tempDir()
  let engine = engineFor(directory)
  return {
    engine,
    pathFor: name => path.join(directory, 'snapshots', `${name}.sqlite`),
    async restart() {
      await engine.closeAll()
      engine = engineFor(directory)
      return engine
    },
    async dispose() { await engine.closeAll().catch(() => {}) }
  }
})

describe('sqlite files', () => {
  it('is durable as soon as a write returns, with no flush or close', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    await (await engine.open({ name: 'app' })).collection('c').insert({ id: 'a', value: 1 })

    // A second connection, as another process (or the next run after a crash) would see it.
    const other = new DatabaseSync(path.join(directory, 'app.sqlite'), { readOnly: true })
    const rows = other.prepare('SELECT collection, id, doc FROM tessera_documents').all()
    other.close()
    expect(rows).toEqual([{ collection: 'c', id: 'a', doc: '{"id":"a","value":1,"rev":1}' }])
    await engine.closeAll()
  })

  it('uses fixed tables, so a collection name is never SQL', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const db = await engine.open({ name: 'app' })
    await db.collection('x"; DROP TABLE tessera_documents; --').insert({ id: 'a' })
    await engine.closeAll()

    const raw = new DatabaseSync(path.join(directory, 'app.sqlite'), { readOnly: true })
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name).sort()
    raw.close()
    expect(tables).toEqual(['tessera_collections', 'tessera_documents', 'tessera_meta'])
  })

  it('opens a database at a path the caller chose', async () => {
    const file = path.join(tempDir(), 'nested', 'Home.tvault')
    const engine = engineFor(tempDir())
    await (await engine.open({ path: file })).collection('c').insert({ id: 'a' })
    await engine.closeAll()

    const again = engineFor(tempDir())
    expect(await (await again.open({ path: file })).collection('c').count()).toBe(1)
    await again.closeAll()
  })

  it('lists databases by name and drops their files', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    await (await engine.open({ name: 'b' })).collection('c').insert({ id: 'a' })
    await (await engine.open({ name: 'a' })).collection('c').insert({ id: 'a' })
    await engine.closeAll()
    expect(await engine.list()).toEqual(['a', 'b'])
    await engine.drop({ name: 'a' })
    expect(fs.readdirSync(directory)).toEqual(['b.sqlite'])
  })

  it('fails to open a file that is not a database', async () => {
    const directory = tempDir()
    fs.writeFileSync(path.join(directory, 'bad.sqlite'), 'this is not sqlite at all, just text padding'.repeat(20))
    await expect(engineFor(directory).open({ name: 'bad' })).rejects.toMatchObject({ code: 'IO' })
  })

  it('reports itself as write-through', () => {
    expect(engineFor(tempDir()).capabilities().durability).toBe('write-through')
  })
})

describe('sqlite snapshots', () => {
  const SIDE = ['-wal', '-shm', '-journal']
  const sideFilesOf = (file: string) => SIDE.filter(suffix => fs.existsSync(file + suffix))

  /** A database big enough to be copied in several steps (100 pages of 4 KB each). */
  async function bigDatabase(directory: string) {
    const engine = engineFor(directory)
    const db = await engine.open({ path: path.join(directory, 'Home.tessera') })
    await db.collection('c').insertMany(Array.from({ length: 2000 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(500) })))
    return { engine, db }
  }

  it('writes one self-contained file: no WAL, checked, and reading it leaves nothing beside it', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: 'a' })
    const copy = path.join(directory, 'backups', 'app copy.tesserabkp')

    await db.snapshot({ path: copy }, { meta: { 'backup.kind': 'auto' } })

    expect(fs.readdirSync(path.dirname(copy))).toEqual(['app copy.tesserabkp'])
    const raw = new DatabaseSync(copy, { readOnly: true })
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect(raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    expect(raw.prepare("SELECT value FROM tessera_meta WHERE key = 'backup.kind'").get()).toEqual({ value: '"auto"' })
    raw.close()
    await engine.readMeta({ path: copy })
    expect(sideFilesOf(copy)).toEqual([])
    await engine.closeAll()
  })

  it('is why a backup is a snapshot: a plain copy of an open database\'s file can lose what was written', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const file = path.join(directory, 'Home.tessera')
    const db = await engine.open({ path: file })
    await db.collection('c').insert({ id: 'kept' })

    // What a file copy would take: the main file alone (the writes are in Home.tessera-wal)
    const naive = path.join(directory, 'naive.tessera')
    fs.copyFileSync(file, naive)
    const raw = new DatabaseSync(naive, { readOnly: true })
    const found = (() => { try { return raw.prepare("SELECT count(*) AS n FROM tessera_documents WHERE id = 'kept'").get() } catch { return { n: 0 } } })()
    raw.close()
    expect(found).toEqual({ n: 0 })

    const snapshot = path.join(directory, 'snapshot.tessera')
    await db.snapshot({ path: snapshot })
    const copy = await engine.open({ path: snapshot }, { readOnly: true })
    expect(await copy.collection('c').get('kept')).toMatchObject({ id: 'kept' })
    await engine.closeAll()
  })

  it('leaves nothing when abandoned half-way, and the database carries on', async () => {
    const directory = tempDir()
    const { engine, db } = await bigDatabase(directory)
    const copy = path.join(directory, 'half.tesserabkp')
    const controller = new AbortController()
    const seen: number[] = []

    const err = await db.snapshot({ path: copy }, {
      signal: controller.signal,
      onProgress: done => { seen.push(done); if (done > 0) controller.abort() }
    }).catch(e => e)

    expect(err).toMatchObject({ code: 'ABORTED' })
    expect(seen.some(done => done > 0 && done < 0.9)).toBe(true)
    expect([copy, ...SIDE.map(s => copy + s)].filter(f => fs.existsSync(f))).toEqual([])
    await db.collection('c').insert({ id: 'after' })
    expect(await db.collection('c').count()).toBe(2001)
    await engine.closeAll()
  })

  it('closes only once a snapshot copied in several steps has finished', async () => {
    const directory = tempDir()
    const { engine, db } = await bigDatabase(directory)
    const copy = path.join(directory, 'while-closing.tesserabkp')
    let steps = 0

    let finished = false
    const snapshot = db.snapshot({ path: copy }, { onProgress: () => { steps++ } })
    void snapshot.then(() => { finished = true })
    await db.close()

    // What quitting relies on: once the database has closed, its snapshot is complete
    expect(finished).toBe(true)
    await snapshot
    expect(steps).toBeGreaterThan(2)
    const opened = await engine.open({ path: copy }, { readOnly: true })
    expect(await opened.collection('c').count()).toBe(2000)
    await engine.closeAll()
  })

  it('never replaces a file, even one that isn\'t a database', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const db = await engine.open({ name: 'app' })
    const target = path.join(directory, 'notes.txt')
    fs.writeFileSync(target, 'keep me')
    await expect(db.snapshot({ path: target })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
    await engine.closeAll()
  })

  it('reads meta without writing: {} for a SQLite file no Tessera database wrote, IO for a file that isn\'t one', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const photos = path.join(directory, 'photos.db')
    const other = new DatabaseSync(photos)
    other.exec("CREATE TABLE photo (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO photo (name) VALUES ('cat')")
    other.close()
    const before = fs.readFileSync(photos)
    const notes = path.join(directory, 'notes.txt')
    fs.writeFileSync(notes, 'hello, this is not a database at all')

    expect(await engine.readMeta({ path: photos })).toEqual({})
    expect(fs.readFileSync(photos).equals(before)).toBe(true)
    expect(fs.readdirSync(directory).sort()).toEqual(['notes.txt', 'photos.db'])
    await expect(engine.readMeta({ path: notes })).rejects.toMatchObject({ code: 'IO' })
    await engine.closeAll()
  })
})

describe('sqlite compaction', () => {
  const PAYLOAD = 'x'.repeat(1000)
  /** A database of 3,000 documents of about 1 KB, then 90% of them deleted: most of the file is free pages. */
  async function mostlyDeleted(engine: KitStorageEngine) {
    const db = await engine.open({ name: 'big' })
    const docs = db.collection('docs')
    await db.transaction(async tx => {
      await tx.collection('docs').insertMany(Array.from({ length: 3000 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, i, payload: PAYLOAD })))
    })
    await db.transaction(async tx => {
      for (let i = 0; i < 3000; i++) if (i % 10 !== 0) await tx.collection('docs').deleteOne({ id: `d${String(i).padStart(4, '0')}` })
    })
    return { db, docs }
  }
  const size = (file: string) => fs.existsSync(file) ? fs.statSync(file).size : 0

  it('shrinks the file to the size of a fresh copy of what is left, and empties the -wal', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const { db, docs } = await mostlyDeleted(engine)
    const file = path.join(directory, 'big.sqlite')
    const before = size(file) + size(file + '-wal')
    // What a new database holding only what is left takes
    const ideal = path.join(directory, 'ideal.sqlite')
    const reader = new DatabaseSync(file, { readOnly: true })
    reader.exec(`VACUUM INTO '${ideal}'`)
    reader.close()

    await db.compact()

    expect(size(file)).toBe(size(ideal))
    expect(size(file + '-wal')).toBe(0)
    expect(size(file)).toBeLessThan(before / 4)
    // The kit's own connection carries on, and what it writes is there for the next reader
    await docs.insert({ id: 'after', payload: 'new' })
    await engine.closeAll()
    const check = new DatabaseSync(file, { readOnly: true })
    expect((check.prepare('SELECT COUNT(*) AS n FROM tessera_documents').get() as { n: number }).n).toBe(301)
    expect((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    check.close()
  })

  it('needs room for twice what is left: is skipped with less, saying how much, and leaves the file as it was', async () => {
    const directory = tempDir()
    const asked: string[] = []
    let free = 0
    const engine = new KitStorageEngine(sqliteDriver({ directory, freeSpace: async folder => { asked.push(folder); return free } }))
    const { db, docs } = await mostlyDeleted(engine)
    const file = path.join(directory, 'big.sqlite')
    // What is left, in pages in use, as another connection sees it
    const reader = new DatabaseSync(file, { readOnly: true })
    const pragma = (name: string) => Number((reader.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name])
    const live = pragma('page_size') * (pragma('page_count') - pragma('freelist_count'))
    reader.close()
    const before = size(file)

    free = 2 * live - 1
    const err = await db.compact().then(() => undefined, e => e as { code: string, message: string })

    expect(err).toMatchObject({ code: 'IO', message: expect.stringMatching(/^there isn’t enough free space on the disk to compact it \(about \d+ MB is needed, and \d+ MB is free\)$/) })
    expect(asked).toEqual([directory])
    expect(size(file)).toBe(before)
    expect(await docs.count()).toBe(300)
    await docs.insert({ id: 'still', payload: 'writable' })

    free = 2 * live + 64 * 1024       // room enough, with the page the insert may have added
    await db.compact()
    expect(size(file)).toBeLessThan(before)
    await engine.closeAll()
  })

  it('goes ahead when the free space can\'t be known', async () => {
    const directory = tempDir()
    const engine = new KitStorageEngine(sqliteDriver({ directory, freeSpace: async () => undefined }))
    const { db } = await mostlyDeleted(engine)
    await expect(db.compact()).resolves.toBeUndefined()
    await engine.closeAll()
  })
})
