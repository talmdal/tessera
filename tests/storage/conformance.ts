// The storage.engine contract as tests. Every backend's test file is one call to describeStorageEngine; the
// semantics here are the same on all of them, with the memory engine as the reference.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEvent, Database, Doc, StorageEngine, StorageErrorCode } from '@tessera/types'

export interface Harness {
  engine: StorageEngine
  /** Closes the engine and returns a fresh one over the same storage, as a restart of the application would. */
  restart(): Promise<StorageEngine>
  dispose(): Promise<void>
}

type Tx = { id: string, accountId: string, date: string, amount: number, category?: string, payee?: string, tags?: string[] }

const rejects = async (work: Promise<unknown>, code: StorageErrorCode) => {
  const error = await work.then(() => undefined, (err: unknown) => err as { code?: string })
  expect(error, `expected ${code}`).toBeDefined()
  expect(error?.code).toBe(code)
}

const LEDGER: Tx[] = [
  { id: 't1', accountId: 'a1', date: '2026-01-03', amount: -50, category: 'food', payee: 'Amazon Fresh', tags: ['x', 'y'] },
  { id: 't2', accountId: 'a1', date: '2026-01-15', amount: -1200, category: 'rent', payee: 'Landlord' },
  { id: 't3', accountId: 'a2', date: '2026-01-20', amount: 3000, category: 'pay', payee: 'Employer' },
  { id: 't4', accountId: 'a1', date: '2026-02-02', amount: -75, category: 'food', payee: 'amazon refund', tags: ['y'] },
  { id: 't5', accountId: 'a2', date: '2026-02-10', amount: -10, payee: 'Cafe' }
]

export function describeStorageEngine(name: string, create: () => Promise<Harness>) {
  describe(`storage engine: ${name}`, () => {
    let harness: Harness
    let engine: StorageEngine
    let db: Database

    beforeEach(async () => {
      harness = await create()
      engine = harness.engine
      db = await engine.open({ name: 'test' })
    })
    afterEach(async () => { await harness.dispose() })

    const ledger = async () => {
      const tx = db.collection<Omit<Tx, 'id'>>('ledger')
      await tx.insertMany(LEDGER.map(t => ({ ...t })))
      return tx
    }

    describe('documents', () => {
      it('inserts with a generated id and rev 1, returning a copy', async () => {
        const c = db.collection<{ n: number }>('c')
        const doc = await c.insert({ n: 1 })
        expect(doc.id).toMatch(/^[0-9A-Z]{26}$/)
        expect(doc.rev).toBe(1)
        doc.n = 99
        expect((await c.get(doc.id))?.n).toBe(1)
      })

      it('keeps a supplied id and does not touch the caller\'s object', async () => {
        const c = db.collection<{ n: number }>('c')
        const input = { id: 'mine', n: 1 }
        await c.insert(input)
        expect(input).toEqual({ id: 'mine', n: 1 })
        expect(await c.get('mine')).toEqual({ id: 'mine', rev: 1, n: 1 })
      })

      it('shows no backend fields', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a', v: { deep: [1, 2] } })
        expect(Object.keys((await c.get('a'))!).sort()).toEqual(['id', 'rev', 'v'])
        expect(Object.keys((await c.find())[0]).sort()).toEqual(['id', 'rev', 'v'])
      })

      it('rejects a duplicate id', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a' })
        await rejects(c.insert({ id: 'a' }), 'DUPLICATE_ID')
        await rejects(c.insertMany([{ id: 'b' }, { id: 'b' }]), 'DUPLICATE_ID')
        expect(await c.count()).toBe(1)
      })

      it('rejects documents that are not JSON', async () => {
        const c = db.collection('c')
        await rejects(c.insert({ n: NaN } as never), 'INVALID_DOCUMENT')
        await rejects(c.insert({ d: new Date() } as never), 'INVALID_DOCUMENT')
        await rejects(c.insert({ f: () => 1 } as never), 'INVALID_DOCUMENT')
        await rejects(c.insert({ '$bad': 1 } as never), 'INVALID_DOCUMENT')
        await rejects(c.insert({ 'a.b': 1 } as never), 'INVALID_DOCUMENT')
        await rejects(c.insert({ id: 5 } as never), 'INVALID_DOCUMENT')
      })

      it('drops undefined properties as JSON would', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a', x: undefined, y: 1 } as never)
        expect(await c.get('a')).toEqual({ id: 'a', rev: 1, y: 1 })
      })

      it('replaces a whole document, bumping rev only when the content changes', async () => {
        const c = db.collection<{ a?: number, b?: number }>('c')
        await c.insert({ id: 'x', a: 1 })
        expect((await c.replace({ id: 'x', b: 2 })).rev).toBe(2)
        expect(await c.get('x')).toEqual({ id: 'x', rev: 2, b: 2 })
        expect((await c.replace({ id: 'x', b: 2 })).rev).toBe(2)
      })

      it('ignores a rev on the way in', async () => {
        const c = db.collection<{ a: number }>('c')
        const first = await c.insert({ id: 'x', a: 1, rev: 40 } as never)
        expect(first.rev).toBe(1)
      })

      it('needs upsert to replace a missing document', async () => {
        const c = db.collection('c')
        await rejects(c.replace({ id: 'nope', a: 1 }), 'NOT_FOUND')
        expect((await c.replace({ id: 'nope', a: 1 }, { upsert: true })).rev).toBe(1)
      })

      it('checks expectedRev', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'x', a: 1 })
        await rejects(c.replace({ id: 'x', a: 2 }, { expectedRev: 5 }), 'CONFLICT')
        await rejects(c.updateOne({ id: 'x' }, { $set: { a: 3 } }, { expectedRev: 5 }), 'CONFLICT')
        await rejects(c.deleteOne({ id: 'x' }, { expectedRev: 5 }), 'CONFLICT')
        await c.updateOne({ id: 'x' }, { $set: { a: 3 } }, { expectedRev: 1 })
        expect((await c.get('x'))?.a).toBe(3)
      })

      it('getMany skips missing ids', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 'a' }, { id: 'b' }])
        expect((await c.getMany(['b', 'zz', 'a'])).map(d => d.id)).toEqual(['b', 'a'])
      })
    })

    describe('queries', () => {
      it('finds in id order, then by sort with id as the tie-break', async () => {
        const c = await ledger()
        expect((await c.find()).map(d => d.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
        expect((await c.find({}, { sort: { accountId: -1 } })).map(d => d.id)).toEqual(['t3', 't5', 't1', 't2', 't4'])
        expect((await c.find({}, { sort: { amount: 1 }, skip: 1, limit: 2 })).map(d => d.id)).toEqual(['t4', 't1'])
      })

      it('compares by type: $lt never matches strings, null or missing', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 'n', v: 5 }, { id: 's', v: 'abc' }, { id: 'z', v: null }, { id: 'm' }])
        expect((await c.find({ v: { $lt: 100 } })).map(d => d.id)).toEqual(['n'])
        expect((await c.find({ v: { $gt: 'a' } })).map(d => d.id)).toEqual(['s'])
      })

      it('sorts across types: missing < null < boolean < number < string < array < object', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: '1', v: { a: 1 } }, { id: '2', v: [1] }, { id: '3', v: 'x' }, { id: '4', v: 7 },
          { id: '5', v: true }, { id: '6', v: null }, { id: '7' }])
        expect((await c.find({}, { sort: { v: 1 } })).map(d => d.id)).toEqual(['7', '6', '5', '4', '3', '2', '1'])
      })

      it('supports every comparison and set operator', async () => {
        const c = await ledger()
        const ids = async (f: object) => (await c.find(f as never)).map(d => d.id)
        expect(await ids({ amount: -50 })).toEqual(['t1'])
        expect(await ids({ amount: { $eq: -50 } })).toEqual(['t1'])
        expect(await ids({ category: { $ne: 'food' } })).toEqual(['t2', 't3', 't5'])
        expect(await ids({ amount: { $gt: 0 } })).toEqual(['t3'])
        expect(await ids({ amount: { $gte: -50, $lte: -10 } })).toEqual(['t1', 't5'])
        expect(await ids({ date: { $gte: '2026-01-15', $lt: '2026-02-01' } })).toEqual(['t2', 't3'])
        expect(await ids({ category: { $in: ['rent', 'pay'] } })).toEqual(['t2', 't3'])
        expect(await ids({ category: { $nin: ['rent', 'pay', 'food'] } })).toEqual(['t5'])
        expect(await ids({ category: { $exists: false } })).toEqual(['t5'])
        expect(await ids({ category: { $exists: true }, amount: { $lt: 0 } })).toEqual(['t1', 't2', 't4'])
      })

      it('supports $regex with options and $contains', async () => {
        const c = await ledger()
        expect((await c.find({ payee: { $regex: '^amazon', $options: 'i' } })).map(d => d.id)).toEqual(['t1', 't4'])
        expect((await c.find({ payee: { $regex: '^amazon' } })).map(d => d.id)).toEqual(['t4'])
        expect((await c.find({ tags: { $contains: 'y' } })).map(d => d.id)).toEqual(['t1', 't4'])
        expect((await c.find({ tags: { $contains: 'x' } })).map(d => d.id)).toEqual(['t1'])
      })

      it('supports $and, $or, $not', async () => {
        const c = await ledger()
        expect((await c.find({ $or: [{ category: 'rent' }, { amount: { $in: [-10, 3000] } }] })).map(d => d.id)).toEqual(['t2', 't3', 't5'])
        expect((await c.find({ $and: [{ accountId: 'a1' }, { amount: { $lt: -60 } }] })).map(d => d.id)).toEqual(['t2', 't4'])
        expect((await c.find({ $not: { accountId: 'a1' } })).map(d => d.id)).toEqual(['t3', 't5'])
      })

      it('supports $text as case-insensitive whole-word matching', async () => {
        const c = await ledger()
        const search = async ($search: string) => (await c.find({ $text: { $search, $fields: ['payee', 'category'] } })).map(d => d.id)
        expect(await search('amazon')).toEqual(['t1', 't4'])
        expect(await search('AMAZON refund')).toEqual(['t4'])
        expect(await search('amaz')).toEqual([])
        expect(await search('fresh food')).toEqual(['t1'])
      })

      it('matches whole values: an array needs $contains, an object needs a dotted path', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 'a', tags: ['k'], address: { city: 'Oslo', zip: '1' } }])
        expect(await c.count({ tags: 'k' })).toBe(0)
        expect(await c.count({ tags: ['k'] })).toBe(1)
        expect(await c.count({ address: { city: 'Oslo' } })).toBe(0)
        expect(await c.count({ 'address.city': 'Oslo' })).toBe(1)
      })

      it('rejects what it can\'t evaluate instead of ignoring it', async () => {
        const c = await ledger()
        await rejects(c.find({ amount: { $near: 5 } } as never), 'UNSUPPORTED_QUERY')
        await rejects(c.find({ $nor: [] } as never), 'UNSUPPORTED_QUERY')
        await rejects(c.find({ amount: { $gt: 1, other: 2 } } as never), 'INVALID_ARGUMENT')
        await rejects(c.find({}, { sort: { amount: 2 } } as never), 'INVALID_ARGUMENT')
        await rejects(c.find({}, { limit: -1 }), 'INVALID_ARGUMENT')
        await rejects(db.collection('empty').find({ x: { $near: 1 } } as never), 'UNSUPPORTED_QUERY')
      })

      it('findOne and count', async () => {
        const c = await ledger()
        expect((await c.findOne({ accountId: 'a2' }, { sort: { amount: 1 } }))?.id).toBe('t5')
        expect(await c.findOne({ accountId: 'zz' })).toBeUndefined()
        expect(await c.count({ accountId: 'a1' })).toBe(3)
        expect(await c.count()).toBe(5)
      })

      it('pages with cursors that survive inserts before the cursor', async () => {
        const c = await ledger()
        const sort = { date: 1 } as const
        const first = await c.findPage({}, { sort, limit: 2 })
        expect(first.items.map(d => d.id)).toEqual(['t1', 't2'])
        await c.insert({ id: 't0', accountId: 'a1', date: '2025-12-31', amount: 1 })
        const second = await c.findPage({}, { sort, limit: 2, cursor: first.nextCursor })
        expect(second.items.map(d => d.id)).toEqual(['t3', 't4'])
        const third = await c.findPage({}, { sort, limit: 2, cursor: second.nextCursor })
        expect(third.items.map(d => d.id)).toEqual(['t5'])
        expect(third.nextCursor).toBeUndefined()
        await rejects(c.findPage({}, { sort: { amount: 1 }, limit: 2, cursor: first.nextCursor }), 'INVALID_ARGUMENT')
        await rejects(c.findPage({}, { limit: 2, cursor: 'junk' }), 'INVALID_ARGUMENT')
      })

      it('scans in batches', async () => {
        const c = await ledger()
        const sizes: number[] = []
        const ids: string[] = []
        for await (const batch of c.scan({}, { batchSize: 2 })) { sizes.push(batch.length); ids.push(...batch.map(d => d.id)) }
        expect(sizes).toEqual([2, 2, 1])
        expect(ids).toEqual(['t1', 't2', 't3', 't4', 't5'])
      })

      it('reads a collection that does not exist as empty, without creating it', async () => {
        const c = db.collection('ghost')
        expect(await c.find()).toEqual([])
        expect(await c.get('x')).toBeUndefined()
        expect(await db.listCollections()).toEqual([])
        expect(await c.deleteMany()).toEqual({ deleted: 0 })
        expect(await db.listCollections()).toEqual([])
      })
    })

    describe('updates', () => {
      it('applies $set, $unset, $inc, $push, $pull with dotted paths', async () => {
        const c = db.collection<any>('c')
        await c.insert({ id: 'a', n: 1, tags: ['x', 'y'], o: { p: 1 }, gone: true })
        const result = await c.updateOne({ id: 'a' }, {
          $set: { 'o.q': 2, 'deep.er.v': 'z' }, $unset: { gone: true }, $inc: { n: 4, fresh: 2 }, $push: { tags: 'w', list: 1 }, $pull: { tags: 'x' }
        })
        expect(result).toEqual({ matched: 1, modified: 1 })
        expect(await c.get('a')).toEqual({
          id: 'a', rev: 2, n: 5, fresh: 2, tags: ['y', 'w'], list: [1], o: { p: 1, q: 2 }, deep: { er: { v: 'z' } }
        })
      })

      it('reports modified 0 and keeps rev when nothing changes', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a', n: 1 })
        const events: ChangeEvent[] = []
        db.onDidChange(e => events.push(e))
        expect(await c.updateOne({ id: 'a' }, { $set: { n: 1 } })).toEqual({ matched: 1, modified: 0 })
        expect((await c.get('a'))?.rev).toBe(1)
        expect(events).toEqual([])
      })

      it('updates the first match by id, or every match', async () => {
        const c = await ledger()
        expect(await c.updateOne({ accountId: 'a1' }, { $set: { flag: true } })).toEqual({ matched: 1, modified: 1 })
        expect((await c.find({ flag: true })).map(d => d.id)).toEqual(['t1'])
        expect(await c.updateMany({ accountId: 'a1' }, { $inc: { amount: 1 } })).toEqual({ matched: 3, modified: 3 })
        expect((await c.get('t1'))?.amount).toBe(-49)
      })

      it('upserts a document built from the filter equalities', async () => {
        const c = db.collection<any>('c')
        const result = await c.updateOne({ key: 'k', 'meta.v': 1, n: { $gt: 0 } }, { $inc: { n: 1 } }, { upsert: true })
        expect(result.matched).toBe(0)
        expect(await c.get(result.upsertedId!)).toMatchObject({ key: 'k', meta: { v: 1 }, n: 1, rev: 1 })
        expect(await c.updateOne({ key: 'zz' }, { $set: { a: 1 } })).toEqual({ matched: 0, modified: 0 })
      })

      it('rejects bad updates', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a', n: 'text', list: 1 })
        await rejects(c.updateOne({ id: 'a' }, { n: 5 } as never), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, {} as never), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, { $rename: { n: 'm' } } as never), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, { $set: { id: 'b' } }), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, { $set: { rev: 9 } }), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, { $inc: { n: 1 } }), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'a' }, { $push: { list: 1 } }), 'INVALID_UPDATE')
        await rejects(c.updateOne({ id: 'nothing' }, { $bad: 1 } as never), 'INVALID_UPDATE')
        expect(await c.get('a')).toEqual({ id: 'a', rev: 1, n: 'text', list: 1 })
      })

      it('deletes one or many', async () => {
        const c = await ledger()
        expect(await c.deleteOne({ accountId: 'a1' })).toEqual({ deleted: 1 })
        expect(await c.deleteMany({ accountId: 'a1' })).toEqual({ deleted: 2 })
        expect((await c.find()).map(d => d.id)).toEqual(['t3', 't5'])
        expect(await c.deleteMany()).toEqual({ deleted: 2 })
      })
    })

    describe('indexes', () => {
      it('enforces unique indexes, sparsely', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ fields: ['ext'], unique: true })
        await c.insertMany([{ id: 'a', ext: 'one' }, { id: 'b' }, { id: 'c' }, { id: 'd', ext: null }])
        await rejects(c.insert({ id: 'e', ext: 'one' }), 'UNIQUE_VIOLATION')
        await rejects(c.insert({ id: 'e', ext: null }), 'UNIQUE_VIOLATION')
        await rejects(c.updateOne({ id: 'b' }, { $set: { ext: 'one' } }), 'UNIQUE_VIOLATION')
        await c.updateOne({ id: 'a' }, { $set: { ext: 'two' } })
        await c.insert({ id: 'e', ext: 'one' })
        expect(await c.count()).toBe(5)
      })

      it('applies a batch atomically: a violation leaves nothing behind', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ fields: ['k'], unique: true })
        await rejects(c.insertMany([{ id: 'a', k: 1 }, { id: 'b', k: 1 }]), 'UNIQUE_VIOLATION')
        expect(await c.count()).toBe(0)
      })

      it('lets a batch swap unique values', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ fields: ['k'], unique: true })
        await c.insertMany([{ id: 'a', k: 1 }, { id: 'b', k: 2 }])
        await c.deleteOne({ id: 'a' })
        await c.updateOne({ id: 'b' }, { $set: { k: 1 } })
        expect((await c.get('b'))?.k).toBe(1)
      })

      it('refuses a unique index that existing data breaks, and reports indexes', async () => {
        const c = db.collection<any>('c')
        await c.insertMany([{ id: 'a', k: 1 }, { id: 'b', k: 1 }])
        await rejects(c.ensureIndex({ fields: ['k'], unique: true }), 'UNIQUE_VIOLATION')
        expect(await c.indexes()).toEqual([])
        expect(await c.ensureIndex({ fields: ['k', 'j'] })).toBe('k+j')
        expect(await c.indexes()).toEqual([{ name: 'k+j', fields: ['k', 'j'], unique: false }])
        await c.dropIndex('k+j')
        expect(await c.indexes()).toEqual([])
        await rejects(c.dropIndex('k+j'), 'INVALID_ARGUMENT')
      })

      it('explains the plan', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ name: 'by-ext', fields: ['ext'], unique: true })
        await c.insert({ id: 'a', ext: 'one' })
        expect(await c.explain({ id: 'a' })).toEqual({ strategy: 'id' })
        expect(await c.explain({ ext: 'one' })).toEqual({ strategy: 'index', index: 'by-ext' })
        expect(await c.explain({ other: 1 })).toEqual({ strategy: 'scan' })
        expect((await c.find({ ext: 'one' })).map(d => d.id)).toEqual(['a'])
        expect(await c.find({ ext: 'nope' })).toEqual([])
      })
    })

    describe('aggregation', () => {
      it('groups, sums and sorts', async () => {
        const c = await ledger()
        const rows = await c.aggregate([
          { $match: { date: { $gte: '2026-01-01', $lt: '2026-03-01' }, amount: { $lt: 0 } } },
          { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $count: {} } } },
          { $sort: { total: 1 } }
        ])
        expect(rows).toEqual([
          { _id: 'rent', total: -1200, count: 1 },
          { _id: 'food', total: -125, count: 2 },
          { _id: null, total: -10, count: 1 }
        ])
      })

      it('computes every accumulator', async () => {
        const c = await ledger()
        const [row] = await c.aggregate([{ $sort: { date: 1 } }, {
          $group: {
            _id: null, sum: { $sum: '$amount' }, avg: { $avg: '$amount' }, min: { $min: '$amount' }, max: { $max: '$amount' },
            first: { $first: '$id' }, last: { $last: '$id' }, cats: { $push: '$category' }, n: { $count: {} }
          }
        }])
        expect(row).toEqual({
          _id: null, sum: 1665, avg: 333, min: -1200, max: 3000, first: 't1', last: 't5', cats: ['food', 'rent', 'pay', 'food'], n: 5
        })
      })

      it('buckets by month and joins another collection', async () => {
        const c = await ledger()
        await db.collection('accounts').insertMany([{ id: 'a1', name: 'Checking' }, { id: 'a2', name: 'Savings' }])
        const rows = await c.aggregate([
          { $project: { accountId: 1, amount: 1, month: { $substr: ['$date', 0, 7] } } },
          { $group: { _id: { account: '$accountId', month: '$month' }, net: { $sum: '$amount' } } },
          { $lookup: { from: 'accounts', localField: '_id.account', foreignField: 'id', as: 'account' } },
          { $unwind: '$account' },
          { $sort: { '_id.month': 1, 'account.name': 1 } },
          { $project: { month: '$_id.month', name: '$account.name', net: 1, _id: 0 } }
        ])
        expect(rows).toEqual([
          { month: '2026-01', name: 'Checking', net: -1250 },
          { month: '2026-01', name: 'Savings', net: 3000 },
          { month: '2026-02', name: 'Checking', net: -75 },
          { month: '2026-02', name: 'Savings', net: -10 }
        ])
      })

      it('supports the expression operators', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a', x: 6, y: 4, d: '2026-03-09', s: 'ab', n: null })
        const [row] = await c.aggregate([{
          $project: {
            add: { $add: ['$x', '$y', 1] }, sub: { $subtract: ['$x', '$y'] }, mul: { $multiply: ['$x', '$y'] },
            div: { $divide: ['$x', '$y'] }, abs: { $abs: { $subtract: ['$y', '$x'] } }, cat: { $concat: ['$s', '-', '$s'] },
            ifn: { $ifNull: ['$n', 'fallback'] }, cond: { $cond: [{ x: { $gt: 5 } }, 'big', 'small'] },
            year: { $year: '$d' }, month: { $month: '$d' }, lit: 'text', nested: { k: '$x' }, id: 0
          }
        }])
        expect(row).toEqual({
          add: 11, sub: 2, mul: 24, div: 1.5, abs: 2, cat: 'ab-ab', ifn: 'fallback', cond: 'big', year: 2026, month: 3,
          lit: 'text', nested: { k: 6 }
        })
      })

      it('supports $skip, $limit, $count and $project exclusion', async () => {
        const c = await ledger()
        expect((await c.aggregate([{ $sort: { id: 1 } }, { $skip: 1 }, { $limit: 2 }, { $project: { id: 1 } }]))
          .map(r => r.id)).toEqual(['t2', 't3'])
        expect(await c.aggregate([{ $match: { accountId: 'a1' } }, { $count: 'n' }])).toEqual([{ n: 3 }])
        const [row] = await c.aggregate([{ $limit: 1 }, { $project: { rev: 0, tags: 0, payee: 0, category: 0 } }])
        expect(row).toEqual({ id: 't1', accountId: 'a1', date: '2026-01-03', amount: -50 })
      })

      it('rejects unknown stages and operators, and mixed projections', async () => {
        const c = await ledger()
        await rejects(c.aggregate([{ $bucket: {} } as never]), 'UNSUPPORTED_QUERY')
        await rejects(c.aggregate([{ $project: { x: { $pow: [1, 2] } } as never }]), 'UNSUPPORTED_QUERY')
        await rejects(c.aggregate([{ $group: { _id: null, x: { $median: '$amount' } } as never }]), 'UNSUPPORTED_QUERY')
        await rejects(c.aggregate([{ $project: { amount: 1, date: 0 } }]), 'INVALID_ARGUMENT')
      })

      it('returns copies', async () => {
        const c = await ledger()
        const [row] = await c.aggregate([{ $match: { id: 't1' } }]) as any[]
        row.amount = 0
        expect((await c.get('t1'))?.amount).toBe(-50)
      })
    })

    describe('transactions', () => {
      it('commits several collections together', async () => {
        await db.transaction(async tx => {
          await tx.collection('a').insert({ id: '1' })
          await tx.collection('b').insert({ id: '2' })
        })
        expect(await db.collection('a').count()).toBe(1)
        expect(await db.collection('b').count()).toBe(1)
      })

      it('shows a transaction its own writes, and nobody else until commit', async () => {
        const c = db.collection('c')
        await db.transaction(async tx => {
          await tx.collection('c').insert({ id: 'a' })
          expect(await tx.collection('c').count()).toBe(1)
          expect(await c.count()).toBe(0)
        })
        expect(await c.count()).toBe(1)
      })

      it('rolls everything back when the work throws', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'keep', v: 1 })
        await expect(db.transaction(async tx => {
          await tx.collection('c').updateOne({ id: 'keep' }, { $set: { v: 2 } })
          await tx.collection('c').insert({ id: 'new' })
          await tx.collection('other').insert({ id: 'x' })
          throw new Error('abort')
        })).rejects.toThrow('abort')
        expect(await c.find()).toEqual([{ id: 'keep', rev: 1, v: 1 }])
        expect(await db.listCollections()).toEqual(['c'])
      })

      it('lets a failed operation inside a transaction be caught without losing the rest', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'a' })
        await db.transaction(async tx => {
          await tx.collection('c').insert({ id: 'b' })
          await rejects(tx.collection('c').insert({ id: 'a' }), 'DUPLICATE_ID')
        })
        expect(await c.count()).toBe(2)
      })

      it('serialises concurrent transactions so no update is lost', async () => {
        const c = db.collection<{ n: number }>('c')
        await c.insert({ id: 'counter', n: 0 })
        await Promise.all(Array.from({ length: 10 }, () => db.transaction(async tx => {
          const col = tx.collection<{ n: number }>('c')
          const current = (await col.get('counter'))!
          await new Promise(r => setTimeout(r, 1))
          await col.replace({ id: 'counter', n: current.n + 1 })
        })))
        expect((await c.get('counter'))?.n).toBe(10)
      })

      it('fails with CONFLICT if a direct write changed a collection the transaction wrote', async () => {
        const c = db.collection<{ n: number }>('c')
        await c.insert({ id: 'a', n: 1 })
        await rejects(db.transaction(async tx => {
          await tx.collection<{ n: number }>('c').updateOne({ id: 'a' }, { $inc: { n: 1 } })
          await c.insert({ id: 'b', n: 5 })
        }), 'CONFLICT')
        expect((await c.find()).map(d => d.id)).toEqual(['a', 'b'])
        expect((await c.get('a'))?.n).toBe(1)
      })

      it('does not check collections the transaction only read', async () => {
        await db.collection('r').insert({ id: 'x' })
        await db.transaction(async tx => {
          await tx.collection('r').find()
          await db.collection('r').insert({ id: 'y' })
          await tx.collection('w').insert({ id: 'z' })
        })
        expect(await db.collection('w').count()).toBe(1)
      })

      it('refuses index changes and use after the transaction ends', async () => {
        let leaked: ReturnType<typeof db.collection> | undefined
        await db.transaction(async tx => {
          await rejects(tx.collection('c').ensureIndex({ fields: ['a'] }), 'INVALID_ARGUMENT')
          leaked = tx.collection('c')
        })
        await rejects(leaked!.insert({ id: 'late' }), 'INVALID_ARGUMENT')
      })

      it('enforces unique indexes inside a transaction', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ fields: ['k'], unique: true })
        await c.insert({ id: 'a', k: 1 })
        await rejects(db.transaction(async tx => { await tx.collection('c').insert({ id: 'b', k: 1 }) }), 'UNIQUE_VIOLATION')
      })

      it('emits one change event per transaction, after commit, and none on rollback', async () => {
        const events: ChangeEvent[] = []
        db.onDidChange(e => events.push(e))
        await db.transaction(async tx => {
          await tx.collection('c').insertMany([{ id: 'a' }, { id: 'b' }])
          await tx.collection('c').updateOne({ id: 'a' }, { $set: { v: 1 } })
          expect(events).toEqual([])
        })
        expect(events).toHaveLength(1)
        expect(events[0].changes).toEqual([
          { collection: 'c', id: 'a', type: 'insert' }, { collection: 'c', id: 'b', type: 'insert' }, { collection: 'c', id: 'a', type: 'update' }
        ])
        await db.transaction(async () => { throw new Error('x') }).catch(() => {})
        expect(events).toHaveLength(1)
      })
    })

    describe('collections and databases', () => {
      it('emits events for direct writes and structure changes, and stops after dispose', async () => {
        const events: ChangeEvent[] = []
        const sub = db.onDidChange(e => events.push(e))
        const c = db.collection('c')
        await c.insert({ id: 'a' })
        await c.updateOne({ id: 'a' }, { $set: { v: 1 } })
        await c.deleteOne({ id: 'a' })
        await db.renameCollection('c', 'd')
        await db.dropCollection('d')
        expect(events.flatMap(e => e.changes.map(c => c.type))).toEqual(['insert', 'update', 'delete'])
        expect(events.flatMap(e => e.structure.map(s => s.type))).toEqual(['create', 'rename', 'drop'])
        sub.dispose()
        await c.insert({ id: 'b' })
        expect(events).toHaveLength(5)
      })

      it('creates, lists, renames and drops collections', async () => {
        await db.createCollection({ name: 'a', indexes: [{ fields: ['k'], unique: true }] })
        await db.collection('b').insert({ id: 'x' })
        expect(await db.listCollections()).toEqual(['a', 'b'])
        expect(await db.collection('a').indexes()).toHaveLength(1)
        await db.renameCollection('b', 'c')
        expect(await db.collection('c').get('x')).toBeDefined()
        await rejects(db.renameCollection('nope', 'z'), 'UNKNOWN_COLLECTION')
        await rejects(db.renameCollection('a', 'c'), 'INVALID_ARGUMENT')
        await db.dropCollection('a')
        await db.dropCollection('a')
        expect(await db.listCollections()).toEqual(['c'])
      })

      it('rejects reserved or malformed collection names', async () => {
        expect(() => db.collection('')).toThrow()
        expect(() => db.collection('__tessera.x')).toThrow()
      })

      it('keeps databases independent', async () => {
        const other = await engine.open({ name: 'other' })
        await db.collection('c').insert({ id: 'a' })
        expect(await other.collection('c').count()).toBe(0)
        const order: string[] = []
        await Promise.all([
          db.transaction(async tx => { await tx.collection('c').insert({ id: 'b' }); await new Promise(r => setTimeout(r, 20)); order.push('db') }),
          other.transaction(async tx => { await tx.collection('c').insert({ id: 'z' }); order.push('other') })
        ])
        expect(order).toEqual(['other', 'db'])
        expect((await engine.list()).sort()).toEqual(['other', 'test'])
      })

      it('returns the open database when opened twice', async () => {
        expect(await engine.open({ name: 'test' })).toBe(db)
      })

      it('rejects bad database names', async () => {
        await rejects(engine.open({ name: '../evil' }), 'INVALID_ARGUMENT')
        await rejects(engine.open({ name: '' }), 'INVALID_ARGUMENT')
      })

      it('stores meta values', async () => {
        expect(await db.meta.get('v')).toBeUndefined()
        await db.meta.set('v', { schema: 3 })
        expect(await db.meta.get('v')).toEqual({ schema: 3 })
        await db.meta.delete('v')
        expect(await db.meta.get('v')).toBeUndefined()
      })

      it('creates ids that increase', async () => {
        const ids = Array.from({ length: 50 }, () => engine.newId())
        expect([...ids].sort()).toEqual(ids)
        expect(new Set(ids).size).toBe(50)
      })

      it('describes itself', async () => {
        expect(engine.id).toBeTruthy()
        expect(engine.capabilities().transactions).toBe(true)
      })
    })

    describe('schema', () => {
      it('creates the declared collections and rejects any other', async () => {
        const vault = await engine.open({ name: 'vault' }, { schema: [{ name: 'accounts', indexes: [{ fields: ['number'], unique: true }] }, { name: 'notes' }] })
        expect(await vault.listCollections()).toEqual(['accounts', 'notes'])
        await vault.collection('accounts').insert({ id: 'a', number: '1' })
        await rejects(vault.collection('accounts').insert({ id: 'b', number: '1' }), 'UNIQUE_VIOLATION')
        await rejects(vault.collection('acounts').insert({ id: 'x' }), 'UNKNOWN_COLLECTION')
        await rejects(vault.collection('acounts').find(), 'UNKNOWN_COLLECTION')
        await rejects(vault.transaction(async tx => { await tx.collection('acounts').insert({ id: 'x' }) }), 'UNKNOWN_COLLECTION')
      })

      it('keeps the declared indexes across a restart', async () => {
        const schema = [{ name: 'accounts', indexes: [{ fields: ['number'], unique: true }] }]
        const first = await engine.open({ name: 'vault' }, { schema })
        await first.collection('accounts').insert({ id: 'a', number: '1' })
        const next = await harness.restart()
        const second = await next.open({ name: 'vault' }, { schema })
        await rejects(second.collection('accounts').insert({ id: 'b', number: '1' }), 'UNIQUE_VIOLATION')
      })
    })

    describe('lifecycle and persistence', () => {
      it('keeps committed data across a restart', async () => {
        const c = db.collection<any>('c')
        await c.ensureIndex({ fields: ['k'], unique: true })
        await c.insertMany([{ id: 'a', k: 1, nested: { v: [1, 2] } }, { id: 'b', k: 2 }])
        await c.updateOne({ id: 'b' }, { $set: { k: 3 } })
        await c.deleteOne({ id: 'a' })
        await db.transaction(async tx => { await tx.collection('t').insert({ id: 'x' }) })
        await db.renameCollection('t', 'u')
        await db.dropCollection('nothing')
        await db.meta.set('version', 7)

        const next = await harness.restart()
        const reopened = await next.open({ name: 'test' })
        expect(await reopened.listCollections()).toEqual(['c', 'u'])
        expect(await reopened.collection('c').find()).toEqual([{ id: 'b', rev: 2, k: 3 }])
        expect(await reopened.collection('c').indexes()).toEqual([{ name: 'k', fields: ['k'], unique: true }])
        expect(await reopened.collection('u').get('x')).toBeDefined()
        expect(await reopened.meta.get('version')).toBe(7)
        await rejects(reopened.collection('c').insert({ id: 'z', k: 3 }), 'UNIQUE_VIOLATION')
      })

      it('keeps data after flush without a clean close', async () => {
        await db.collection('c').insert({ id: 'a' })
        await db.flush()
        const next = await harness.restart()
        expect(await (await next.open({ name: 'test' })).collection('c').count()).toBe(1)
      })

      it('drops a database', async () => {
        await db.collection('c').insert({ id: 'a' })
        await engine.drop({ name: 'test' })
        expect(await engine.list()).toEqual([])
        const fresh = await engine.open({ name: 'test' })
        expect(await fresh.listCollections()).toEqual([])
      })

      it('refuses use after close', async () => {
        const c = db.collection('c')
        await db.close()
        await rejects(c.find(), 'NOT_OPEN')
        await rejects(c.insert({ id: 'a' }), 'NOT_OPEN')
        await rejects(db.transaction(async () => {}), 'NOT_OPEN')
        await db.close()
      })

      it('waits for a running transaction before closing', async () => {
        const running = db.transaction(async tx => {
          await new Promise(r => setTimeout(r, 10))
          await tx.collection('c').insert({ id: 'a' })
        })
        await db.close()
        await running
        const reopened = await engine.open({ name: 'test' })
        expect(await reopened.collection('c').count()).toBe(1)
      })

      it('opens read-only: reads work, writes are refused', async () => {
        await db.collection('c').insert({ id: 'a' })
        await db.close()
        const ro = await engine.open({ name: 'test' }, { readOnly: true })
        expect(ro.readOnly).toBe(true)
        expect(await ro.collection('c').count()).toBe(1)
        await rejects(ro.collection('c').insert({ id: 'b' }), 'READ_ONLY')
        await rejects(ro.transaction(async tx => { await tx.collection('c').insert({ id: 'b' }) }), 'READ_ONLY')
        await rejects(ro.meta.set('k', 1), 'READ_ONLY')
      })

      it('closeAll closes every database', async () => {
        const other = await engine.open({ name: 'other' })
        await engine.closeAll()
        await rejects(db.collection('c').find(), 'NOT_OPEN')
        await rejects(other.collection('c').find(), 'NOT_OPEN')
      })

      it('returns Docs usable as the type they were stored as', async () => {
        const c = db.collection<{ n: number }>('c')
        const doc: Doc<{ n: number }> = await c.insert({ n: 1 })
        expect(doc.n + doc.rev).toBe(2)
      })
    })
  })
}
