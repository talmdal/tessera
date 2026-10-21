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

  it('upsert inserts when missing', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await tm.run(async tx => {
      await tx.upsert('settings', { key: 'theme' }, { key: 'theme', value: 'dark' })
    })

    const { $loki, meta, ...result } = await engine.getOne('settings', { key: 'theme' }) as any
    expect(result).toEqual({ key: 'theme', value: 'dark' })

    await engine.close()
  })

  it('upsert updates when present', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('settings', { key: 'theme', value: 'light' })

    const tm = new TransactionManager(engine)

    await tm.run(async tx => {
      await tx.upsert('settings', { key: 'theme' }, { key: 'theme', value: 'dark' })
    })

    const  { $loki, meta, ...result } = await engine.getOne('settings', { key: 'theme' }) as any
    expect(result).toEqual({ key: 'theme', value: 'dark' })

    await engine.close()
  })

  it('rollback discards upsert changes', async () => {
    const engine = create()
    await engine.init()

    const tm = new TransactionManager(engine)

    await expect(async () => {
      await tm.run(async tx => {
        await tx.upsert('settings', { key: 'theme' }, { key: 'theme', value: 'dark' })
        throw new Error('boom')
      })
    }).rejects.toThrow()

    const result = await engine.getOne('settings', { key: 'theme' })
    expect(result).toBeNull()

    await engine.close()
  })
})
