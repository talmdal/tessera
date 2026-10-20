import { describe, it, expect } from 'vitest'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'
import { TransactionManager } from '../../../core/storage/TransactionManager'

describe('Atomicity guarantees', () => {
  const create = () => new LokiStorageEngine('memory://atomic.db')

  it('ensures no partial writes on failure', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await expect(async () => {
      await tm.run(async tx => {
        await tx.insert('items', { id: 1, value: 'A' })
        await tx.insert('items', { id: 2, value: 'B' })
        throw new Error('Abort transaction')
      })
    }).rejects.toThrow()

    const final = await engine.get('items', {})
    expect(final.length).toBe(0)

    await engine.close()
  })

  it('commits all-or-nothing on success', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await tm.run(async tx => {
      await tx.insert('items', { id: 1, value: 'A' })
      await tx.insert('items', { id: 2, value: 'B' })
    })

    const final = await engine.get('items', {})
    expect(final.length).toBe(2)

    await engine.close()
  })
})
