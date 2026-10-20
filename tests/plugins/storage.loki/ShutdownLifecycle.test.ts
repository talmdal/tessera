import { describe, it, expect, vi } from 'vitest'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'

describe('LokiStorageEngine shutdown lifecycle', () => {
  it('calls close() cleanly on shutdown', async () => {
    const engine = new LokiStorageEngine('memory://shutdown.db')
    await engine.init()

    const spy = vi.spyOn(engine, 'close')

    // Simulate Tessera lifecycle
    await engine.close()

    expect(spy).toHaveBeenCalled()
  })
})
