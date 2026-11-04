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
