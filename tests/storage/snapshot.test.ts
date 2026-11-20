// @vitest-environment node
// What `Database.load` promises that the conformance suite can't show with a healthy backend: one batch for the
// whole snapshot, and nothing visible if the backend refuses it. The rest of snapshot and load is in conformance.ts.
import { describe, expect, it } from 'vitest'
import { KitDatabase, MemoryBackend, ulid, type StorageChange } from '@tessera/storage-kit'
import type { DatabaseSnapshot } from '@tessera/types'

const SNAPSHOT: DatabaseSnapshot = {
  collections: [
    { name: 'a', indexes: [{ name: 'k', fields: ['k'], unique: true }], docs: [{ id: 'a1', rev: 3, k: 1 }, { id: 'a2', rev: 1, k: 2 }] },
    { name: 'b', indexes: [], docs: [{ id: 'b1', rev: 1 }] }
  ],
  meta: { version: 2 }
}

/** A memory backend that records each batch it is given, and can be told to refuse them. */
class RecordingBackend extends MemoryBackend {
  readonly batches: StorageChange[][] = []
  failing = false
  override async commit(changes: StorageChange[]) {
    this.batches.push(changes)
    if (this.failing) throw new Error('disk full')
    await super.commit(changes)
  }
}

const open = (backend: RecordingBackend) => KitDatabase.open(backend, { name: 'test', newId: ulid })

describe('Database.load', () => {
  it('hands the backend the whole snapshot as one batch', async () => {
    const backend = new RecordingBackend()
    const db = await open(backend)
    await db.load(SNAPSHOT)

    expect(backend.batches).toHaveLength(1)
    expect(backend.batches[0].map(change => change.type)).toEqual(['collection', 'put', 'put', 'collection', 'put', 'meta'])
    expect(await (await open(backend)).snapshot()).toEqual(SNAPSHOT)
  })

  it('leaves the database empty and usable when the backend refuses the batch', async () => {
    const backend = new RecordingBackend()
    const db = await open(backend)
    backend.failing = true

    await expect(db.load(SNAPSHOT)).rejects.toMatchObject({ code: 'IO' })
    expect(await db.snapshot()).toEqual({ collections: [], meta: {} })
    expect(await db.listCollections()).toEqual([])
    expect(backend.files.collections.size).toBe(0)

    // Still empty, so a second attempt is allowed and succeeds
    backend.failing = false
    await db.load(SNAPSHOT)
    expect(await db.snapshot()).toEqual(SNAPSHOT)
  })

  it('checks the whole snapshot before giving the backend anything', async () => {
    const backend = new RecordingBackend()
    const db = await open(backend)
    const bad: DatabaseSnapshot = {
      collections: [SNAPSHOT.collections[0], { name: 'b', indexes: [], docs: [{ id: 'b1', rev: 0 }] }],
      meta: {}
    }
    await expect(db.load(bad)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })
    expect(backend.batches).toEqual([])
  })
})
