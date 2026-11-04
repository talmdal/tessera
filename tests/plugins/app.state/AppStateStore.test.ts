// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { StorageEngine } from '@tessera/types'
import { AppStateStore } from '../../../plugins/app.state/src/privileged/AppStateStore'
import { lokiDriver } from '../../../plugins/storage.loki/src/privileged/LokiDriver'
import { sqliteDriver } from '../../../plugins/storage.sqlite/src/privileged/SqliteDriver'

const dirs: string[] = []
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-state-')); dirs.push(d); return d }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const backends: [string, () => (() => StorageEngine)][] = [
  ['memory', () => { const driver = memoryDriver(); return () => new KitStorageEngine(driver) }],
  ['loki', () => { const directory = tempDir(); return () => new KitStorageEngine(lokiDriver({ directory, saveDelay: 10 })) }],
  ['sqlite', () => { const directory = tempDir(); return () => new KitStorageEngine(sqliteDriver({ directory })) }]
]

describe.each(backends)('AppStateStore on the %s engine', (_name, setup) => {
  const open = async (newEngine: () => StorageEngine) => {
    const engine = newEngine()
    const store = new AppStateStore(engine)
    await store.init()
    return { engine, store }
  }

  it('sets, gets, updates and removes values', async () => {
    const { engine, store } = await open(setup())
    expect(await store.get('k')).toBeUndefined()

    await store.set('k', { a: 1, b: { c: 2 } })
    expect(await store.get('k')).toEqual({ a: 1, b: { c: 2 } })

    await store.update('k', { a: 5, d: 'x' })
    expect(await store.get('k')).toEqual({ a: 5, b: { c: 2 }, d: 'x' })

    await store.remove('k')
    expect(await store.get('k')).toBeUndefined()
    await engine.closeAll()
  })

  it('stores primitives and arrays, and update creates a missing key', async () => {
    const { engine, store } = await open(setup())
    await store.set('n', 3)
    await store.set('list', [1, 2])
    await store.update('fresh', { x: 1 })
    expect([await store.get('n'), await store.get('list'), await store.get('fresh')]).toEqual([3, [1, 2], { x: 1 }])
    await engine.closeAll()
  })

  it('returns the default for a missing key without storing it', async () => {
    const { engine, store } = await open(setup())
    expect(await store.get('k', () => 'fallback')).toBe('fallback')
    expect(await store.get('k')).toBeUndefined()
    expect(await (await engine.open({ name: 'app' })).collection('app-state.entries').count()).toBe(0)
    await engine.closeAll()
  })

  it('does not lose concurrent updates to one key', async () => {
    const { engine, store } = await open(setup())
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update('k', { [`f${i}`]: i })))
    expect(Object.keys((await store.get<object>('k'))!)).toHaveLength(20)
    await engine.closeAll()
  })

  it('keeps its values across a restart', async () => {
    const newEngine = setup()
    const first = await open(newEngine)
    await first.store.set('theme', { mode: 'dark' })
    await first.store.update('window', { x: 10 })
    await first.store.flush()
    await first.engine.closeAll()

    const second = await open(newEngine)
    expect(await second.store.get('theme')).toEqual({ mode: 'dark' })
    expect(await second.store.get('window')).toEqual({ x: 10 })
    await second.engine.closeAll()
  })

  it('keeps its data in the app database, apart from any other', async () => {
    const { engine, store } = await open(setup())
    await store.set('k', 1)
    expect(await engine.list()).toEqual(['app'])
    await engine.closeAll()
  })
})
