import { describe, it, expect } from 'vitest'
import { LokiStorageEngine } from '../../../plugins/storage.loki/src/privileged/LokiStorageEngine'

describe('LokiStorageEngine', () => {
  const create = () => new LokiStorageEngine('memory://test.db')

  it('inserts and retrieves documents', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('items', { id: 1, name: 'A' })
    await engine.insert('items', { id: 2, name: 'B' })

    const all = (await engine.get('items', {})) as any[]
    expect(all.length).toBe(2)

    const { $loki, meta, ...one } = (await engine.getOne('items', { id: 1 })) as any
    expect(one).toEqual({ id: 1, name: 'A' })

    await engine.close()
  })

  it('updates documents', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('items', { id: 1, name: 'A' })
    await engine.update('items', { id: 1 }, { name: 'Z' })

    const {$loki, meta, ...updated} = (await engine.getOne('items', { id: 1 })) as any
    expect(updated).toEqual({ id: 1, name: 'Z' })

    await engine.close()
  })

  it('deletes documents', async () => {
    const engine = create()
    await engine.init()

    await engine.insert('items', { id: 1, name: 'A' })
    await engine.insert('items', { id: 2, name: 'B' })

    await engine.delete('items', { id: 2 })
    const actual = (await engine.get('items', {})) as any[]

    expect(actual.length).toBe(1)
    const {$loki, meta, ...remaining} = actual[0]
    expect(remaining).toEqual({ id: 1, name: 'A' })

    await engine.close()
  })
})
