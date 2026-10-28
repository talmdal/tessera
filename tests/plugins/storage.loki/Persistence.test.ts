import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TransactionManager } from '../../../core/storage/TransactionManager'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'
import { AppStateStore } from '../../../plugins/app.state/src/privileged/AppStateStore'

// Real files: these are about what survives a restart.
describe('LokiStorageEngine persistence', () => {
  const dirs: string[] = []
  const newFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-loki-'))
    dirs.push(dir)
    return path.join(dir, 'tessera.json')
  }
  const open = async (file: string) => {
    const engine = new LokiStorageEngine(file)
    await engine.init()
    return engine
  }

  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes a committed transaction to disk at once', async () => {
    const file = newFile()
    const engine = await open(file)

    await new TransactionManager(engine).run(async tx => { await tx.insert('c', { key: 'a', value: 1 }) })

    expect(fs.readFileSync(file, 'utf8')).toContain('"key":"a"')
    await engine.close()
  })

  it('keeps what was committed across a restart', async () => {
    const file = newFile()
    const first = await open(file)
    await new TransactionManager(first).run(async tx => { await tx.insert('c', { key: 'a', value: 1 }) })
    await first.close()

    const second = await open(file)

    expect(await second.getOne('c', { key: 'a' })).toMatchObject({ value: 1 })
    await second.close()
  })

  it('keeps writing after the first transaction: later ones, and what changed outside a transaction, reach the disk', async () => {
    const file = newFile()
    const engine = await open(file)
    const tm = new TransactionManager(engine)

    await tm.run(async tx => { await tx.insert('c', { key: 'one' }) })
    await tm.run(async tx => { await tx.insert('c', { key: 'two' }) })
    await engine.insert('c', { key: 'three' })       // autosave, not a commit
    await engine.close()                              // writes what autosave has not yet

    const reopened = await open(file)
    expect((await reopened.get<{ key: string }>('c', {})).map(d => d.key).sort()).toEqual(['one', 'three', 'two'])
    await reopened.close()
  })

  it('keeps app state across a restart', async () => {
    const file = newFile()
    const first = await open(file)
    const state = new AppStateStore(first)
    await state.init()
    await state.set('shell.window.main', { width: 900, height: 700, maximized: false })
    await first.close()

    const second = await open(file)

    expect(await new AppStateStore(second).get('shell.window.main')).toEqual({ width: 900, height: 700, maximized: false })
    await second.close()
  })

  it('keeps every write when several are started at once', async () => {
    const file = newFile()
    const engine = await open(file)
    const state = new AppStateStore(engine)
    await state.init()

    await Promise.all([
      state.set('shell.layout.main', { a: 1 }),
      state.set('shell.window.main', { b: 2 }),
      state.set('theme', 'dark')
    ])
    await engine.close()

    const reopened = new AppStateStore(await open(file))
    expect(await reopened.get('shell.layout.main')).toEqual({ a: 1 })
    expect(await reopened.get('shell.window.main')).toEqual({ b: 2 })
    expect(await reopened.get('theme')).toBe('dark')
  })

  it('runs transactions one at a time, and a failed one does not stop the next', async () => {
    const engine = await open(newFile())
    const tm = new TransactionManager(engine)
    const order: string[] = []

    const failing = tm.run(async () => { order.push('start-a'); await Promise.resolve(); order.push('end-a'); throw new Error('boom') })
    const next = tm.run(async tx => { order.push('start-b'); await tx.insert('c', { key: 'b' }); order.push('end-b') })

    await expect(failing).rejects.toThrow('boom')
    await next
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
    expect(await engine.getOne('c', { key: 'b' })).toBeTruthy()
    await engine.close()
  })
})
