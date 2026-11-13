// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import { lokiDriver, LokiAdapter, LokiDriverOptions } from '../../../plugins/storage.loki/src/privileged/LokiDriver'
import { describeStorageEngine } from '../../storage/conformance'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-loki-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const engineFor = (directory: string, extra: Partial<LokiDriverOptions> = {}) =>
  new KitStorageEngine(lokiDriver({ directory, saveDelay: 20, ...extra }))

describeStorageEngine('loki', async () => {
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

describe('loki files', () => {
  it('writes the database to <name>.loki.json, saving after a short delay', async () => {
    const directory = tempDir()
    const engine = engineFor(directory)
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: 'a', value: 1 })

    const file = path.join(directory, 'app.loki.json')
    expect(fs.existsSync(file)).toBe(false)   // buffered
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(fs.readFileSync(file, 'utf8')).toContain('"value":1')
    expect(fs.existsSync(`${file}~`)).toBe(false)
    await engine.closeAll()
  })

  it('writes at once on flush, and keeps Loki\'s own fields off the document', async () => {
    const directory = tempDir()
    const engine = engineFor(directory, { saveDelay: 60_000 })
    const db = await engine.open({ name: 'app' })
    const stored = await db.collection('c').insert({ id: 'a', value: 1 })
    await db.flush()

    const file = JSON.parse(fs.readFileSync(path.join(directory, 'app.loki.json'), 'utf8'))
    const envelope = file.collections.find((c: any) => c.name === 'c').data[0]
    expect(envelope.doc).toEqual({ id: 'a', value: 1, rev: 1 })
    expect(stored).toEqual({ id: 'a', value: 1, rev: 1 })
    await engine.closeAll()
  })

  it('writes on close even before the timer fires', async () => {
    const directory = tempDir()
    const engine = engineFor(directory, { saveDelay: 60_000 })
    await (await engine.open({ name: 'app' })).collection('c').insert({ id: 'a' })
    await engine.closeAll()
    expect(fs.readFileSync(path.join(directory, 'app.loki.json'), 'utf8')).toContain('"id":"a"')
  })

  it('opens a database at a path the caller chose', async () => {
    const directory = tempDir()
    const file = path.join(directory, 'nested', 'Home.tvault')
    const engine = engineFor(tempDir())
    await (await engine.open({ path: file })).collection('c').insert({ id: 'a' })
    await engine.closeAll()
    expect(fs.existsSync(file)).toBe(true)

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
    expect(fs.readdirSync(directory)).toEqual(['b.loki.json'])
  })

  it('fails to open a file that is not a Loki database', async () => {
    const directory = tempDir()
    fs.writeFileSync(path.join(directory, 'bad.loki.json'), '{ not json')
    await expect(engineFor(directory).open({ name: 'bad' })).rejects.toMatchObject({ code: 'IO' })
  })

  describe('when saving fails', () => {
    /** The real adapter's behaviour, with writes that can be made to fail. */
    const flaky = () => {
      const files = new Map<string, string>()
      const state = { failing: false }
      const adapter: LokiAdapter = {
        loadDatabase: (name, callback) => callback(files.get(name) ?? null),
        saveDatabase: (name, data, callback) => {
          if (state.failing) callback(new Error('disk full'))
          else { files.set(name, data); callback() }
        }
      }
      return { files, state, adapter }
    }

    it('reports the failure from flush, keeps the data and the previous file, and saves once it works', async () => {
      const { files, state, adapter } = flaky()
      const errors: unknown[] = []
      const directory = tempDir()
      const engine = engineFor(directory, { adapter, saveDelay: 60_000, log: { error: (...args) => { errors.push(args) } } })
      const db = await engine.open({ path: path.join(directory, 'x.loki.json') })
      const c = db.collection('c')

      await c.insert({ id: 'a' })
      await db.flush()
      const before = files.get(path.join(directory, 'x.loki.json'))!

      state.failing = true
      await c.insert({ id: 'b' })
      await expect(db.flush()).rejects.toMatchObject({ code: 'IO' })
      expect(files.get(path.join(directory, 'x.loki.json'))).toBe(before)
      expect(await c.count()).toBe(2)

      state.failing = false
      await db.flush()
      expect(files.get(path.join(directory, 'x.loki.json'))).toContain('"id":"b"')
      await engine.closeAll()
      expect(errors).toEqual([])
    })

    it('logs a failure of the timed save instead of throwing', async () => {
      const { state, adapter } = flaky()
      const errors: unknown[][] = []
      const directory = tempDir()
      const engine = engineFor(directory, { adapter, saveDelay: 5, log: { error: (...args) => { errors.push(args) } } })
      const db = await engine.open({ path: path.join(directory, 'x.loki.json') })
      state.failing = true
      await db.collection('c').insert({ id: 'a' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(errors).toHaveLength(1)
      state.failing = false
      await engine.closeAll()
    })
  })
})
