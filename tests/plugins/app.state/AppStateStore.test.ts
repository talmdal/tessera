// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStorageEngine } from '../../../core/storage/memory/MemoryStorageEngine'
import { APP_DATABASE, AppStateStore, ENTRIES } from '../../../plugins/app.state/src/privileged/AppStateStore'

describe('AppStateStore', () => {
  let engine: MemoryStorageEngine
  let store: AppStateStore

  beforeEach(async () => {
    engine = new MemoryStorageEngine()
    store = new AppStateStore(engine)
    await store.init()
  })

  it('returns undefined, or the default, for a key with no value, and stores nothing', async () => {
    expect(await store.get('window')).toBeUndefined()
    expect(await store.get('window', () => ({ width: 800 }))).toEqual({ width: 800 })
    expect(await store.get('window')).toBeUndefined()
    const db = await engine.open({ name: APP_DATABASE })
    expect(await db.collection(ENTRIES).count()).toBe(0)
  })

  it('sets, gets, overwrites and removes values of any JSON shape', async () => {
    await store.set('theme', 'dark')
    await store.set('window', { x: 1, y: 2, maximized: false })
    await store.set('recent', ['a', 'b'])
    expect(await store.get('theme')).toBe('dark')
    expect(await store.get('window')).toEqual({ x: 1, y: 2, maximized: false })
    expect(await store.get('recent')).toEqual(['a', 'b'])

    await store.set('theme', { theme: 'system', light: 'shell.light', dark: 'shell.dark' })
    expect(await store.get('theme')).toEqual({ theme: 'system', light: 'shell.light', dark: 'shell.dark' })

    await store.remove('theme')
    await store.remove('never-set')
    expect(await store.get('theme')).toBeUndefined()
  })

  it('update merges a patch into the stored object, starting from {} when there is none', async () => {
    await store.update('window', { width: 800 })
    await store.update('window', { height: 600, width: 1024 })
    expect(await store.get('window')).toEqual({ width: 1024, height: 600 })

    await store.set('flag', true)
    await store.update('flag', { on: true })           // a non-object value is replaced, not merged
    expect(await store.get('flag')).toEqual({ on: true })
  })

  it('returns copies, so editing a result does not change the store', async () => {
    await store.set('window', { x: 1 })
    const value = await store.get<{ x: number }>('window')
    value!.x = 99
    expect(await store.get('window')).toEqual({ x: 1 })
  })

  it('rejects values that cannot be stored as JSON', async () => {
    await expect(store.set('bad', () => 1)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })
    await expect(store.set('bad', { when: new Date() })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })
  })

  it('keeps state in the app database, one document per key', async () => {
    await store.set('a', 1)
    await store.set('b', 2)
    const db = await engine.open({ name: APP_DATABASE })
    expect(await db.collection(ENTRIES).find()).toEqual([
      { id: 'a', rev: 1, value: 1 },
      { id: 'b', rev: 1, value: 2 }
    ])
    expect(await engine.list()).toEqual([APP_DATABASE])
  })

  it('survives a flush and the engine reopening the database', async () => {
    await store.set('theme', 'dark')
    await store.flush()
    await engine.closeAll()
    const again = new AppStateStore(engine)
    await again.init()
    expect(await again.get('theme')).toBe('dark')
  })
})
