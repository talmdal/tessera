// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { StorageEngine } from '@tessera/types'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'
import { describeStorageEngine } from '../../storage/conformance'
import { removeDir, tempDir as makeTempDir } from '../../helpers/tempDir'

const dirs = new WeakMap<StorageEngine, string>()
const log = { info() {}, warn() {}, error() {} }

function engineIn(dir: string) {
  const engine = new LokiStorageEngine({ dir, saveDelay: 20, log })
  dirs.set(engine, dir)
  return engine
}

const tempDir = () => makeTempDir('tessera-loki')

describeStorageEngine('loki', {
  create: async () => engineIn(tempDir()),
  reopen: async engine => engineIn(dirs.get(engine)!),
  destroy: async engine => removeDir(dirs.get(engine)!),
  tempPath: engine => path.join(dirs.get(engine)!, 'by-path', 'some-vault')
})

describe('LokiStorageEngine files', () => {
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

    expect(fs.existsSync(path.join(dir, 'app.loki.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'vaults', 'home.tvault'))).toBe(true)
    expect(await engine.list()).toEqual(['app'])
    expect(fs.readdirSync(dir).filter(f => f.endsWith('~'))).toEqual([])   // no temp file left behind
  })

  it('rejects database names that are not file-safe', async () => {
    const { engine } = create()
    for (const name of ['', '../x', 'a/b', '.hidden']) {
      await expect(engine.open({ name })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  it('writes a short time after a change, and at once on flush', async () => {
    const { dir, engine } = create()
    const file = path.join(dir, 'app.loki.json')
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    expect(fs.existsSync(file)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(fs.existsSync(file)).toBe(true)

    await db.collection('c').insert({ id: '2' })
    await db.flush()
    expect(fs.readFileSync(file, 'utf8')).toContain('"2"')
    await engine.closeAll()
  })

  it('saves on close, so a write just before quitting is kept', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    await db.close()
    const again = await engineIn(dir).open({ name: 'app' })
    expect(await again.collection('c').count()).toBe(1)
    await again.close()
  })

  it('keeps a document field named meta, and never shows Loki fields', async () => {
    const { dir, engine } = create()
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1', meta: { mine: true }, $loki: 'not mine' } as never).catch(() => {})
    await db.collection('c').insert({ id: '1', meta: { mine: true } })
    await db.close()
    const again = await engineIn(dir).open({ name: 'app' })
    expect(await again.collection('c').get('1')).toEqual({ id: '1', rev: 1, meta: { mine: true } })
    await again.close()
  })

  it('reports IO errors from load and save instead of swallowing them', async () => {
    const { dir, engine } = create()
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'a file, not a folder')
    await expect(engine.open({ path: path.join(blocker, 'db.json') })).rejects.toMatchObject({ code: 'IO' })

    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    await db.flush()
    fs.rmSync(path.join(dir, 'app.loki.json'))
    fs.mkdirSync(path.join(dir, 'app.loki.json'))               // a save now fails: the target is a folder
    await db.collection('c').insert({ id: '2' })
    await expect(db.flush()).rejects.toMatchObject({ code: 'IO' })
    expect(await db.collection('c').count()).toBe(2)              // the data is still there in memory
    await expect(engine.closeAll()).rejects.toMatchObject({ code: 'IO' })
  })

  it('reopens with the same handle while a load is in progress', async () => {
    const { engine } = create()
    const [a, b] = await Promise.all([engine.open({ name: 'app' }), engine.open({ name: 'app' })])
    expect(a).toBe(b)
    await engine.closeAll()
  })
})
