// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { describeStorageEngine } from './conformance'

// The reference backend: what every other backend is measured against.
describeStorageEngine('memory', async () => {
  const driver = memoryDriver()
  let engine = new KitStorageEngine(driver)
  return {
    engine,
    pathFor: name => `/snapshots/${name}.db`,
    async restart() {
      await engine.closeAll()
      engine = new KitStorageEngine(driver)
      return engine
    },
    async dispose() { await engine.closeAll().catch(() => {}) }
  }
})


// The kit's part in compaction, with a backend whose compaction and snapshots the test holds open: how it orders them
describe('compaction in the kit', () => {
  async function gated() {
    const driver = memoryDriver()
    const events: string[] = []
    const gate = () => { let open!: () => void; const shut = new Promise<void>(resolve => { open = resolve }); return { shut, open } }
    const compacting = gate(), snapshotting = gate()
    const openBackend = driver.open.bind(driver)
    driver.open = async (target, options) => {
      const backend = await openBackend(target, options)
      const snapshot = backend.snapshot.bind(backend)
      return Object.assign(backend, {
        compact: async () => { events.push('compact'); await compacting.shut; events.push('compacted') },
        snapshot: async (...args: Parameters<typeof snapshot>) => { events.push('snapshot'); await snapshotting.shut; await snapshot(...args); events.push('snapshotted') }
      })
    }
    const db = await new KitStorageEngine(driver).open({ name: 'test' })
    await db.collection('c').insert({ id: 'a' })
    const turns = () => new Promise(resolve => setTimeout(resolve, 10))
    return { db, events, compacting, snapshotting, turns }
  }

  it('waits for a snapshot already running, so the file isn\'t rewritten under it', async () => {
    const { db, events, compacting, snapshotting, turns } = await gated()
    const copy = db.snapshot({ path: '/copy' })
    await turns()
    const compacted = db.compact()
    await turns()
    expect(events).toEqual(['snapshot'])
    snapshotting.open()
    compacting.open()
    await Promise.all([copy, compacted])
    expect(events).toEqual(['snapshot', 'snapshotted', 'compact', 'compacted'])
  })

  it('makes a snapshot started meanwhile wait for it, then copy the compacted file', async () => {
    const { db, events, compacting, snapshotting, turns } = await gated()
    const compacted = db.compact()
    await turns()
    const copy = db.snapshot({ path: '/copy' })
    await turns()
    expect(events).toEqual(['compact'])
    compacting.open()
    snapshotting.open()
    await Promise.all([copy, compacted])
    expect(events).toEqual(['compact', 'compacted', 'snapshot', 'snapshotted'])
  })

  it('makes a commit wait, and a close', async () => {
    const { db, events, compacting, turns } = await gated()
    const compacted = db.compact()
    await turns()
    const written = db.collection('c').insert({ id: 'b' }).then(() => events.push('written'))
    const closed = db.close().then(() => events.push('closed'))
    await turns()
    expect(events).toEqual(['compact'])
    compacting.open()
    await Promise.all([compacted, written, closed])
    expect(events).toEqual(['compact', 'compacted', 'written', 'closed'])
  })
})
