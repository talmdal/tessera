import { describe, it, expect } from 'vitest'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'
import { TransactionManager } from '../../../core/storage/TransactionManager'

describe('TransactionManager', () => {
  const create = () => new LokiStorageEngine('memory://tx.db')

  it('commits changes', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await tm.run(async tx => {
      await tx.insert('tx', { id: 1, value: 'A' })
      await tx.insert('tx', { id: 2, value: 'B' })
    })

    const committed = await engine.get('tx', {})
    expect(committed.length).toBe(2)

    await engine.close()
  })

  it('rolls back on error', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await expect(async () => {
      await tm.run(async tx => {
        await tx.insert('tx', { id: 3, value: 'C' })
        throw new Error('Force rollback')
      })
    }).rejects.toThrow()

    const afterRollback = await engine.get('tx', {})
    expect(afterRollback.length).toBe(0)

    await engine.close()
  })

  it('isolates uncommitted changes', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await tm.run(async tx => {
      await tx.insert('tx', { id: 1, value: 'A' })

      const { $loki, meta, ...inside } = (await tx.getOne('tx', { id: 1 })) as any
      expect(inside).toEqual({ id: 1, value: 'A' })

      const outside = (await engine.getOne('tx', { id: 1 })) as any
      expect(outside).toBeNull()
    })

    const { $loki, meta, ...afterCommit } = (await engine.getOne('tx', { id: 1 })) as any
    expect(afterCommit).toEqual({ id: 1, value: 'A' })

    await engine.close()
  })
})
