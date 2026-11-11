// @vitest-environment node
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

