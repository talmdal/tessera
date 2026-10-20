import { describe, it, expect } from 'vitest'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'

type Result = { id: string }

describe('Query predicate support', () => {
  const create = () => new LokiStorageEngine('memory://predicates.db')

  it('filters using predicate functions', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('items', { id: 1, value: 10 })
    await engine.insert('items', { id: 2, value: 20 })
    await engine.insert('items', { id: 3, value: 30 })

    const results: Result[] = await engine.get('items', doc => doc.value > 15)
    expect(results.length).toBe(2)
    expect(results.map(r => r.id)).toEqual([2, 3])

    await engine.close()
  })

  it('findOne works with predicate', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('items', { id: 1, value: 10 })
    await engine.insert('items', { id: 2, value: 20 })

    const {$loki, meta, ...result} = (await engine.getOne('items', doc => doc.value === 20)) as any
    expect(result).toEqual({ id: 2, value: 20 })

    await engine.close()
  })
})
