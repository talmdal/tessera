// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { StorageEngine } from '@tessera/types'
import { SqliteStorageEngine } from '../../../plugins/storage.sqlite/src/privileged/SqliteStorageEngine'
import { describeStorageEngine } from '../../storage/conformance'
import { removeDir, tempDir as makeTempDir } from '../../helpers/tempDir'

const dirs = new WeakMap<StorageEngine, string>()

function engineIn(dir: string) {
  const engine = new SqliteStorageEngine({ dir })
  dirs.set(engine, dir)
  return engine
}

const tempDir = () => makeTempDir('tessera-sqlite')

describeStorageEngine('sqlite', {
  create: async () => engineIn(tempDir()),
  reopen: async engine => engineIn(dirs.get(engine)!),
  destroy: async engine => removeDir(dirs.get(engine)!),
  tempPath: engine => path.join(dirs.get(engine)!, 'by-path', 'some-vault')
})

describe('SqliteStorageEngine files', () => {
  const made: string[] = []
  const create = () => {
    const dir = tempDir()
    made.push(dir)
    return { dir, engine: engineIn(dir) }
  }

  afterEach(() => {
    for (const dir of made.splice(0)) removeDir(dir)
  })

  it('keeps one file per named database, and a path target where it says', async () => {
    const { dir, engine } = create()
    const app = await engine.open({ name: 'app' })
    const vault = await engine.open({ path: path.join(dir, 'vaults', 'home.tvault') })
    await app.collection('c').insert({ id: '1' })
    await vault.collection('c').insert({ id: '1' })
    await engine.closeAll()

    expect(fs.existsSync(path.join(dir, 'app.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'vaults', 'home.tvault'))).toBe(true)
    expect(await engine.list()).toEqual(['app'])
  })

  it('rejects database names that are not file-safe', async () => {
    const { engine } = create()
    for (const name of ['', '../x', 'a/b', '.hidden']) {
      await expect(engine.open({ name })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  it('is write-through: a second engine sees a write with no flush or close', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    await db.transaction(async tx => { await tx.collection('c').insert({ id: '2' }) })
    await db.meta.set('schema', 1)

    const other = engineIn(dir)
    const seen = await other.open({ name: 'app' })
    expect((await seen.collection('c').find()).map(d => d.id)).toEqual(['1', '2'])
    expect(await seen.meta.get('schema')).toBe(1)
    await other.closeAll()
    await engine.closeAll()
  })

  it('a transaction is one durable commit: a throw leaves nothing on disk', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: 'keep' })
    await db.transaction(async tx => {
      await tx.collection('c').insert({ id: 'a' })
      await tx.collection('d').insert({ id: 'b' })
      throw new Error('abort')
    }).catch(() => {})
    await engine.closeAll()

    const again = await engineIn(dir).open({ name: 'app' })
    expect((await again.collection('c').find()).map(d => d.id)).toEqual(['keep'])
    expect(await again.collection('d').count()).toBe(0)
    expect((await again.listCollections()).map(c => c.name)).toEqual(['c'])
    await again.close()
  })

  it('keeps a document field named meta and stores plain JSON rows', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1', meta: { mine: true }, text: 'naïve “quotes” ✓' })
    await engine.closeAll()

    const again = await engineIn(dir).open({ name: 'app' })
    expect(await again.collection('c').get('1')).toEqual({ id: '1', rev: 1, meta: { mine: true }, text: 'naïve “quotes” ✓' })
    await again.close()
  })

  it('reports IO errors from open instead of swallowing them', async () => {
    const { dir, engine } = create()
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'a file, not a folder')
    await expect(engine.open({ path: path.join(blocker, 'db.sqlite') })).rejects.toMatchObject({ code: 'IO' })
    await expect(engine.open({ path: blocker })).rejects.toMatchObject({ code: 'IO' })   // not a SQLite file
    // The failed open must not leave a connection behind: on Windows an open
    // handle makes the file undeletable, which is how this was first noticed.
    fs.rmSync(blocker)
    expect(fs.existsSync(blocker)).toBe(false)
  })

  it('drop removes the database and its WAL files', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    await engine.drop({ name: 'app' })
    expect(fs.readdirSync(dir)).toEqual([])
    expect(await engine.list()).toEqual([])
  })
})
