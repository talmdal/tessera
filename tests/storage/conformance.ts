// tests/storage/conformance.ts
//
// The conformance suite every storage backend must pass: it is the contract
// in tessera-types/storage.ts, as tests. A backend's test file is one call:
//
//   describeStorageEngine('memory', { create: async () => new MemoryStorageEngine() })
//
// The memory engine in core/storage/ is the reference: the expected rows
// here are what it returns, and a backend that disagrees is wrong, whether
// it evaluates natively or through the shared kit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ChangeEvent, Database, Document, StorageEngine, Stored } from '@tessera/types'

export interface EngineHarness {
  /** A fresh engine over empty storage. */
  create(): Promise<StorageEngine>
  /**
   * A new engine over the same storage as `engine` (on which `closeAll` has
   * been called), for persistence tests. Omit if the backend keeps nothing.
   */
  reopen?(engine: StorageEngine): Promise<StorageEngine>
  /** Removes whatever `create` made on disk. Called after each test, after closeAll. */
  destroy?(engine: StorageEngine): Promise<void>
  /** A path (outside the engine's storage folder) for the open-by-path test. File backends create a file there. */
  tempPath?(engine: StorageEngine): string
}

interface Tx extends Document {
  accountId: string
  date: string
  amount: number
  category?: string
  payee?: string
  memo?: string
  tags?: string[]
  splits?: { category: string, amount: number }[]
}

const TRANSACTIONS: Tx[] = [
  { id: 't1', accountId: 'a1', date: '2026-01-05', amount: -1200, category: 'rent', payee: 'Acme Lettings', memo: 'January rent', tags: ['fixed'] },
  { id: 't2', accountId: 'a1', date: '2026-01-09', amount: -45, category: 'food', payee: 'Corner Shop', memo: 'groceries' },
  { id: 't3', accountId: 'a2', date: '2026-01-12', amount: 3000, category: 'salary', payee: 'Employer Inc', memo: 'January salary', tags: ['income'] },
  { id: 't4', accountId: 'a1', date: '2026-02-03', amount: -1200, category: 'rent', payee: 'Acme Lettings', memo: 'February rent', tags: ['fixed'] },
  { id: 't5', accountId: 'a2', date: '2026-02-14', amount: -80, category: 'food', payee: 'Amazon Fresh', memo: 'Valentine dinner, groceries',
    splits: [{ category: 'food', amount: -60 }, { category: 'gifts', amount: -20 }] },
  { id: 't6', accountId: 'a1', date: '2026-02-20', amount: -30, category: 'food', payee: 'amazon', memo: 'refund pending' }
]

const ACCOUNTS = [
  { id: 'a1', name: 'Current', currency: 'GBP' },
  { id: 'a2', name: 'Savings', currency: 'GBP' }
]

const ids = (docs: { id: string }[]) => docs.map(d => d.id)

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (err) {
    expect((err as { code?: string }).code, `expected ${code}, got: ${(err as Error).message}`).toBe(code)
    return err
  }
  throw new Error(`expected a ${code} error`)
}

export function describeStorageEngine(name: string, harness: EngineHarness) {
  describe(`storage engine conformance: ${name}`, () => {
    let engine: StorageEngine
    let db: Database

    beforeEach(async () => {
      engine = await harness.create()
      db = await engine.open({ name: 'test' })
    })

    afterEach(async () => {
      await engine.closeAll()
      await harness.destroy?.(engine)
    })

    async function seed() {
      const tx = db.collection<Tx>('accounts.transactions')
      await tx.insertMany(TRANSACTIONS)
      await db.collection('accounts.accounts').insertMany(ACCOUNTS)
      return tx
    }

    // -----------------------------------------------------------------------
    describe('engine', () => {
      it('has an id and capabilities', () => {
        expect(engine.id).toBeTruthy()
        const caps = engine.capabilities()
        expect(['native', 'emulated']).toContain(caps.aggregate)
        expect(['native', 'emulated']).toContain(caps.regex)
        expect(['native', 'emulated']).toContain(caps.textSearch)
        expect(typeof caps.writeThrough).toBe('boolean')
      })

      it('makes unique, sortable ids', () => {
        const a = engine.newId()
        const b = engine.newId()
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(a).not.toBe(b)
        expect(a < b).toBe(true)
      })

      it('returns the same handle for a database that is already open', async () => {
        const again = await engine.open({ name: 'test' })
        expect(again).toBe(db)
        expect(db.name).toBe('test')
        expect(db.engine).toBe(engine.id)
      })

      it('lists named databases and drops them', async () => {
        await engine.open({ name: 'other' })
        expect(await engine.list()).toEqual(['other', 'test'])
        await engine.drop({ name: 'other' })
        expect(await engine.list()).toEqual(['test'])
      })

      it('drops a database with its data', async () => {
        await db.collection('c').insert({ id: 'x' })
        await engine.drop({ name: 'test' })
        expect(db.isOpen).toBe(false)
        db = await engine.open({ name: 'test' })
        expect(await db.collection('c').count()).toBe(0)
      })

      it('opens by path as well as by name', async () => {
        const where = harness.tempPath?.(engine) ?? '/virtual/some-vault'
        const byPath = await engine.open({ path: where })
        expect(byPath.name).toBe(where)
        await byPath.collection('c').insert({ id: '1' })
        expect(await engine.list()).toEqual(['test'])          // paths are not named databases
        await byPath.close()
        await engine.drop({ path: where })
      })

      it('closes every database on closeAll', async () => {
        const other = await engine.open({ name: 'other' })
        await engine.closeAll()
        expect(db.isOpen).toBe(false)
        expect(other.isOpen).toBe(false)
      })
    })

    // -----------------------------------------------------------------------
    describe('database', () => {
      it('rejects every operation once closed', async () => {
        const c = db.collection('c')
        await db.close()
        expect(db.isOpen).toBe(false)
        await expectCode(c.insert({ id: 'x' }), 'NOT_OPEN')
        await expectCode(c.find(), 'NOT_OPEN')
        await expectCode(db.listCollections(), 'NOT_OPEN')
        await expectCode(db.transaction(async () => {}), 'NOT_OPEN')
        await expectCode(db.meta.get('x'), 'NOT_OPEN')
        await db.close()   // idempotent
      })

      it('refuses writes when opened read-only', async () => {
        await db.collection('c').insert({ id: 'x' })
        await db.close()
        const ro = await engine.open({ name: 'test' }, { readOnly: true })
        expect(ro.readOnly).toBe(true)
        expect(await ro.collection('c').count()).toBe(1)
        await expectCode(ro.collection('c').insert({ id: 'y' }), 'READ_ONLY')
        await expectCode(ro.collection('c').deleteMany({}), 'READ_ONLY')
        await expectCode(ro.transaction(async tx => { await tx.collection('c').insert({ id: 'y' }) }), 'READ_ONLY')
        await expectCode(ro.meta.set('k', 1), 'READ_ONLY')
        await expectCode(ro.dropCollection('c'), 'READ_ONLY')
      })

      it('creates collections on first write by default, and lists them', async () => {
        expect(await db.listCollections()).toEqual([])
        expect(await db.collection('later').find()).toEqual([])          // reading an absent collection is empty, not an error
        await db.collection('b').insert({ id: '1' })
        await db.collection('a').insert({ id: '1' })
        expect(await db.listCollections()).toEqual([
          { name: 'a', indexes: [], count: 1 },
          { name: 'b', indexes: [], count: 1 }
        ])
      })

      it('applies a schema on open and then rejects unknown collections', async () => {
        await db.close()
        db = await engine.open({ name: 'test' }, {
          schema: [{ name: 'accounts.accounts', indexes: [{ name: 'byName', fields: ['name'], unique: true }] }]
        })
        expect(await db.listCollections()).toEqual([{ name: 'accounts.accounts', indexes: [{ name: 'byName', fields: ['name'], unique: true }], count: 0 }])
        await expectCode(db.collection('accounts.acounts').insert({ id: 'x' }), 'UNKNOWN_COLLECTION')
        await expectCode(db.collection('accounts.acounts').find(), 'UNKNOWN_COLLECTION')
        await expectCode(db.transaction(async tx => { await tx.collection('nope').insert({ id: 'x' }) }), 'UNKNOWN_COLLECTION')
        await db.collection('accounts.accounts').insert({ id: 'a1', name: 'Current' })
      })

      it('creates, drops and renames collections', async () => {
        await db.createCollection({ name: 'c', indexes: [{ name: 'byKey', fields: ['key'] }] })
        await db.collection('c').insert({ id: '1', key: 'k' })
        await db.renameCollection('c', 'd')
        expect(ids(await db.collection('d').find())).toEqual(['1'])
        expect(await db.collection('d').indexes()).toEqual([{ name: 'byKey', fields: ['key'] }])
        await expectCode(db.renameCollection('missing', 'e'), 'UNKNOWN_COLLECTION')
        await db.collection('e').insert({ id: '1' })
        await expectCode(db.renameCollection('d', 'e'), 'INVALID_ARGUMENT')
        expect(await db.dropCollection('d')).toBe(true)
        expect(await db.dropCollection('d')).toBe(false)
        expect((await db.listCollections()).map(c => c.name)).toEqual(['e'])
      })

      it('validates collection names', async () => {
        await expectCode(Promise.resolve().then(() => db.collection('')), 'INVALID_ARGUMENT')
        await expectCode(Promise.resolve().then(() => db.collection('$system')), 'INVALID_ARGUMENT')
      })

      it('keeps per-database meta values', async () => {
        expect(await db.meta.get('schema.accounts')).toBeUndefined()
        await db.meta.set('schema.accounts', { version: 2 })
        expect(await db.meta.get('schema.accounts')).toEqual({ version: 2 })
        await db.meta.delete('schema.accounts')
        expect(await db.meta.get('schema.accounts')).toBeUndefined()
      })

      it('keeps two databases apart', async () => {
        const other = await engine.open({ name: 'other' })
        await db.collection('c').insert({ id: '1', from: 'test' })
        await other.collection('c').insert({ id: '1', from: 'other' })
        await other.meta.set('k', 'other')
        expect((await db.collection('c').get('1'))?.from).toBe('test')
        expect((await other.collection('c').get('1'))?.from).toBe('other')
        expect(await db.meta.get('k')).toBeUndefined()
        await db.transaction(async tx => {
          await tx.collection('c').insert({ id: '2' })
          expect(await other.collection('c').count()).toBe(1)
        })
        expect(await other.collection('c').count()).toBe(1)
        expect(await db.collection('c').count()).toBe(2)
      })
    })

    // -----------------------------------------------------------------------
    describe('documents', () => {
      it('inserts with a generated id and rev 1, and returns a copy', async () => {
        const c = db.collection<{ name: string } & Document>('c')
        const input = { name: 'A', nested: { list: [1, 2] } }
        const stored = await c.insert(input)
        expect(stored.id).toMatch(/^[0-9A-Z]{26}$/)
        expect(stored.rev).toBe(1)
        expect(Object.keys(stored).sort()).toEqual(['id', 'name', 'nested', 'rev'])
        expect(input).toEqual({ name: 'A', nested: { list: [1, 2] } })         // the input is untouched

        stored.name = 'changed'
        ;(stored.nested as { list: number[] }).list.push(3)
        expect(await c.get(stored.id)).toEqual({ id: stored.id, rev: 1, name: 'A', nested: { list: [1, 2] } })
      })

      it('keeps a caller-supplied id and ignores a supplied rev', async () => {
        const stored = await db.collection('c').insert({ id: 'mine', rev: 42, v: 1 })
        expect(stored).toEqual({ id: 'mine', rev: 1, v: 1 })
      })

      it('rejects a duplicate id', async () => {
        await db.collection('c').insert({ id: 'x' })
        await expectCode(db.collection('c').insert({ id: 'x' }), 'DUPLICATE_ID')
      })

      it('rejects documents that are not JSON or have reserved field names', async () => {
        const c = db.collection('c')
        await expectCode(c.insert({ id: '', v: 1 }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ id: 7 as unknown as string }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ $set: 1 }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ 'a.b': 1 }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ nested: { $op: 1 } }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ fn: (() => 1) as unknown as string }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ when: new Date() as unknown as string }), 'INVALID_DOCUMENT')
        await expectCode(c.insert({ n: NaN }), 'INVALID_DOCUMENT')
        await expectCode(c.insert([] as unknown as Document), 'INVALID_DOCUMENT')
        expect(await c.count()).toBe(0)
      })

      it('drops undefined properties on the way in', async () => {
        const stored = await db.collection('c').insert({ id: 'x', a: undefined, b: 1 })
        expect(stored).toEqual({ id: 'x', rev: 1, b: 1 })
      })

      it('inserts many atomically', async () => {
        const c = db.collection('c')
        await expectCode(c.insertMany([{ id: '1' }, { id: '2' }, { id: '1' }]), 'DUPLICATE_ID')
        expect(await c.count()).toBe(0)
        const stored = await c.insertMany([{ id: '1' }, { v: 2 }])
        expect(stored.length).toBe(2)
        expect(await c.count()).toBe(2)
      })
    })

    // -----------------------------------------------------------------------
    describe('reads', () => {
      it('get and getMany', async () => {
        const tx = await seed()
        expect((await tx.get('t1'))?.payee).toBe('Acme Lettings')
        expect(await tx.get('nope')).toBeUndefined()
        const many = await tx.getMany(['t2', 'nope', 't1'])
        expect(many.map(d => d?.id)).toEqual(['t2', undefined, 't1'])
      })

      it('find orders by id by default, and by sort then id', async () => {
        const tx = await seed()
        expect(ids(await tx.find())).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
        expect(ids(await tx.find({}, { sort: { amount: 1 } }))).toEqual(['t1', 't4', 't5', 't2', 't6', 't3'])
        expect(ids(await tx.find({}, { sort: { category: 1, date: -1 } }))).toEqual(['t6', 't5', 't2', 't4', 't1', 't3'])
        expect(ids(await tx.find({}, { sort: { accountId: -1 } }))).toEqual(['t3', 't5', 't1', 't2', 't4', 't6'])
      })

      it('sorts missing values first, and mixed types in a fixed order', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 'str', v: 'a' }, { id: 'num', v: 5 }, { id: 'none' }, { id: 'null', v: null }, { id: 'bool', v: true }])
        expect(ids(await c.find({}, { sort: { v: 1 } }))).toEqual(['none', 'null', 'bool', 'num', 'str'])
        expect(ids(await c.find({}, { sort: { v: -1 } }))).toEqual(['str', 'num', 'bool', 'null', 'none'])
      })

      it('skip, limit and projection', async () => {
        const tx = await seed()
        expect(ids(await tx.find({}, { skip: 2, limit: 2 }))).toEqual(['t3', 't4'])
        expect(await tx.find({ id: 't1' }, { projection: { payee: 1, amount: 1 } })).toEqual([{ id: 't1', payee: 'Acme Lettings', amount: -1200 }])
        expect(await tx.find({ id: 't1' }, { projection: { id: 0, payee: 1 } })).toEqual([{ payee: 'Acme Lettings' }])
        const excluded = await tx.findOne({ id: 't1' }, { projection: { memo: 0, tags: 0, category: 0 } })
        expect(excluded).toEqual({ id: 't1', rev: 1, accountId: 'a1', date: '2026-01-05', amount: -1200, payee: 'Acme Lettings' })
        await expectCode(tx.find({}, { projection: { a: 1, b: 0 } }), 'INVALID_ARGUMENT')
        await expectCode(tx.find({}, { limit: -1 }), 'INVALID_ARGUMENT')
        await expectCode(tx.find({}, { sort: { amount: 2 as 1 } }), 'INVALID_ARGUMENT')
      })

      it('findOne takes the first in order, or undefined', async () => {
        const tx = await seed()
        expect((await tx.findOne({ category: 'food' }, { sort: { amount: 1 } }))?.id).toBe('t5')
        expect((await tx.findOne({ category: 'food' }, { sort: { amount: 1 }, skip: 1 }))?.id).toBe('t2')
        expect(await tx.findOne({ category: 'travel' })).toBeUndefined()
      })

      it('count', async () => {
        const tx = await seed()
        expect(await tx.count()).toBe(6)
        expect(await tx.count({ accountId: 'a1' })).toBe(4)
      })

      it('scan yields every document in id order, in batches', async () => {
        const tx = await seed()
        const seen: string[] = []
        for await (const doc of tx.scan({ batchSize: 4 })) seen.push(doc.id)
        expect(seen).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
      })

      it('explain returns a plan', async () => {
        const tx = await seed()
        const plan = await tx.explain({ accountId: 'a1' }, { sort: { date: -1 } })
        expect(plan).toBeTypeOf('object')
      })
    })

    // -----------------------------------------------------------------------
    describe('filters', () => {
      it('equality, including whole-object and dotted paths', async () => {
        const c = db.collection('c')
        await c.insertMany([
          { id: '1', address: { city: 'Leeds', post: 'LS1' }, tags: ['a', 'b'], n: 1 },
          { id: '2', address: { city: 'York' }, tags: [], n: null },
          { id: '3' }
        ])
        expect(ids(await c.find({ 'address.city': 'Leeds' }))).toEqual(['1'])
        expect(ids(await c.find({ address: { city: 'York' } }))).toEqual(['2'])
        expect(ids(await c.find({ address: { city: 'Leeds' } }))).toEqual([])    // whole-object equality
        expect(ids(await c.find({ tags: ['a', 'b'] }))).toEqual(['1'])
        expect(ids(await c.find({ tags: 'a' }))).toEqual([])                     // no implicit array membership; use $contains
        expect(ids(await c.find({ tags: { $contains: 'a' } }))).toEqual(['1'])
        expect(ids(await c.find({ n: null }))).toEqual(['2'])
        expect(ids(await c.find({ n: { $exists: false } }))).toEqual(['3'])
        expect(ids(await c.find({ n: { $exists: true } }))).toEqual(['1', '2'])
        expect(ids(await c.find({ n: { $ne: 1 } }))).toEqual(['2', '3'])
        expect(ids(await c.find({ 'address.post': { $eq: 'LS1' } }))).toEqual(['1'])
      })

      it('comparisons and sets', async () => {
        const tx = await seed()
        expect(ids(await tx.find({ amount: { $lt: -100 } }))).toEqual(['t1', 't4'])
        expect(ids(await tx.find({ amount: { $gte: -45, $lte: 0 } }))).toEqual(['t2', 't6'])
        expect(ids(await tx.find({ date: { $gte: '2026-02-01', $lt: '2026-03-01' } }))).toEqual(['t4', 't5', 't6'])
        expect(ids(await tx.find({ accountId: 'a1', date: { $gt: '2026-01-09' } }))).toEqual(['t4', 't6'])
        expect(ids(await tx.find({ category: { $in: ['rent', 'salary'] } }))).toEqual(['t1', 't3', 't4'])
        expect(ids(await tx.find({ category: { $nin: ['rent', 'salary', 'food'] } }))).toEqual([])
        expect(ids(await tx.find({ tags: { $in: [['fixed']] } }))).toEqual(['t1', 't4'])
      })

      it('compares only within a type', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 's', v: '10' }, { id: 'n', v: 9 }, { id: 'x' }, { id: 'z', v: null }])
        expect(ids(await c.find({ v: { $gt: 5 } }))).toEqual(['n'])
        expect(ids(await c.find({ v: { $gt: '1' } }))).toEqual(['s'])
        expect(ids(await c.find({ v: { $lt: 100 } }))).toEqual(['n'])        // missing and null never compare
        await expectCode(c.find({ v: { $gt: null } }), 'INVALID_ARGUMENT')
      })

      it('logical operators', async () => {
        const tx = await seed()
        expect(ids(await tx.find({ $or: [{ category: 'salary' }, { amount: { $lt: -1000 } }] }))).toEqual(['t1', 't3', 't4'])
        expect(ids(await tx.find({ $and: [{ accountId: 'a1' }, { category: 'food' }] }))).toEqual(['t2', 't6'])
        expect(ids(await tx.find({ $not: { category: 'food' } }))).toEqual(['t1', 't3', 't4'])
        expect(ids(await tx.find({ accountId: 'a2', $or: [{ category: 'food' }, { category: 'rent' }] }))).toEqual(['t5'])
        await expectCode(tx.find({ $or: [] }), 'INVALID_ARGUMENT')
      })

      it('$regex', async () => {
        const tx = await seed()
        expect(ids(await tx.find({ payee: { $regex: '^amazon' } }))).toEqual(['t6'])
        expect(ids(await tx.find({ payee: { $regex: '^amazon', $options: 'i' } }))).toEqual(['t5', 't6'])
        expect(ids(await tx.find({ amount: { $regex: '12' } }))).toEqual([])    // non-strings never match
        await expectCode(tx.find({ payee: { $regex: '(' } }), 'INVALID_ARGUMENT')
        await expectCode(tx.find({ payee: { $options: 'i' } }), 'INVALID_ARGUMENT')
      })

      it('$text matches whole words in any of the fields, case-insensitively', async () => {
        const tx = await seed()
        const search = ($search: string, $fields = ['payee', 'memo']) => tx.find({ $text: { $search, $fields } })
        expect(ids(await search('groceries'))).toEqual(['t2', 't5'])
        expect(ids(await search('AMAZON'))).toEqual(['t5', 't6'])
        expect(ids(await search('amazon refund'))).toEqual(['t6'])            // every term must occur
        expect(ids(await search('rent', ['memo']))).toEqual(['t1', 't4'])
        expect(ids(await search('ren'))).toEqual([])                          // whole words only
        expect(ids(await search('   '))).toEqual([])
        await expectCode(search('x', []), 'INVALID_ARGUMENT')
      })

      it('rejects operators outside the contract', async () => {
        const tx = await seed()
        await expectCode(tx.find({ amount: { $gte2: 1 } }), 'UNSUPPORTED_QUERY')
        await expectCode(tx.find({ $where: 'true' } as never), 'UNSUPPORTED_QUERY')
        await expectCode(tx.find({ amount: { $size: 1 } }), 'UNSUPPORTED_QUERY')
        await expectCode(tx.count({ amount: { $near: 1 } }), 'UNSUPPORTED_QUERY')
        await expectCode(tx.deleteMany({ amount: { $near: 1 } }), 'UNSUPPORTED_QUERY')
        expect(await tx.count()).toBe(6)
      })
    })

    // -----------------------------------------------------------------------
    describe('updates', () => {
      it('$set, $unset, $inc, $push, $pull, with dotted paths', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', n: 1, tags: ['a'], nested: { keep: true, drop: true } })
        const result = await c.updateOne({ id: '1' }, {
          $set: { 'nested.new': 'x', label: 'L' },
          $unset: { 'nested.drop': true },
          $inc: { n: 2, counter: 5 },
          $push: { tags: 'b', list: 1 },
          $pull: { tags: 'a' }
        })
        expect(result).toEqual({ matched: 1, modified: 1 })
        expect(await c.get('1')).toEqual({ id: '1', rev: 2, n: 3, counter: 5, tags: ['b'], list: [1], nested: { keep: true, new: 'x' }, label: 'L' })
      })

      it('bumps rev only when something changed', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', n: 1 })
        expect(await c.updateOne({ id: '1' }, { $set: { n: 1 } })).toEqual({ matched: 1, modified: 0 })
        expect((await c.get('1'))?.rev).toBe(1)
        expect(await c.updateOne({ id: '1' }, { $set: { n: 2 } })).toEqual({ matched: 1, modified: 1 })
        expect((await c.get('1'))?.rev).toBe(2)
        expect(await c.updateOne({ id: 'missing' }, { $set: { n: 2 } })).toEqual({ matched: 0, modified: 0 })
      })

      it('updateMany', async () => {
        const tx = await seed()
        expect(await tx.updateMany({ category: 'food' }, { $set: { category: 'groceries' } })).toEqual({ matched: 3, modified: 3 })
        expect(await tx.count({ category: 'groceries' })).toBe(3)
        expect(await tx.updateMany({ category: 'none' }, { $set: { x: 1 } })).toEqual({ matched: 0, modified: 0 })
      })

      it('upserts from the filter equalities plus the update', async () => {
        const c = db.collection('c')
        const result = await c.updateOne({ key: 'theme', 'scope.kind': 'user', n: { $gt: 1 } }, { $set: { value: 'dark' }, $inc: { hits: 1 } }, { upsert: true })
        expect(result.matched).toBe(0)
        expect(result.upsertedId).toBeTruthy()
        expect(await c.get(result.upsertedId!)).toEqual({ id: result.upsertedId, rev: 1, key: 'theme', scope: { kind: 'user' }, value: 'dark', hits: 1 })

        const again = await c.updateOne({ id: 'fixed' }, { $set: { v: 1 } }, { upsert: true })
        expect(again.upsertedId).toBe('fixed')
        expect(await c.updateOne({ id: 'fixed' }, { $set: { v: 2 } }, { upsert: true })).toEqual({ matched: 1, modified: 1 })
      })

      it('rejects updates without operators, unknown operators, and changes to id or rev', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', n: 1, s: 'x', list: [] })
        await expectCode(c.updateOne({ id: '1' }, { n: 2 } as never), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, {}), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $rename: { n: 'm' } } as never), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $set: { id: '2' } }), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $inc: { rev: 1 } }), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $inc: { s: 1 } }), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $push: { s: 1 } }), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $set: { '$bad': 1 } }), 'INVALID_UPDATE')
        await expectCode(c.updateOne({ id: '1' }, { $set: { fn: (() => 1) as never } }), 'INVALID_DOCUMENT')
        expect(await c.get('1')).toEqual({ id: '1', rev: 1, n: 1, s: 'x', list: [] })
      })
    })

    // -----------------------------------------------------------------------
    describe('replace', () => {
      it('replaces the whole document and bumps rev', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', a: 1, b: 2 })
        const stored = await c.replace({ id: '1', c: 3 })
        expect(stored).toEqual({ id: '1', rev: 2, c: 3 })
        expect(await c.get('1')).toEqual({ id: '1', rev: 2, c: 3 })
      })

      it('NOT_FOUND without upsert, inserts with it', async () => {
        const c = db.collection('c')
        await expectCode(c.replace({ id: '1', a: 1 }), 'NOT_FOUND')
        expect(await c.replace({ id: '1', a: 1 }, { upsert: true })).toEqual({ id: '1', rev: 1, a: 1 })
        await expectCode(c.replace({ a: 1 } as never), 'INVALID_DOCUMENT')
      })

      it('expectedRev detects a concurrent change', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', a: 1 })
        await c.replace({ id: '1', a: 2 }, { expectedRev: 1 })
        const err = await expectCode(c.replace({ id: '1', a: 3 }, { expectedRev: 1 }), 'CONFLICT')
        expect((err as { details?: { rev?: number } }).details?.rev).toBe(2)
        await expectCode(c.replace({ id: 'new', a: 3 }, { expectedRev: 1, upsert: true }), 'CONFLICT')
        expect(await c.get('1')).toEqual({ id: '1', rev: 2, a: 2 })
      })
    })

    // -----------------------------------------------------------------------
    describe('delete', () => {
      it('deleteOne and deleteMany', async () => {
        const tx = await seed()
        expect(await tx.deleteOne({ category: 'food' })).toBe(1)
        expect(await tx.count({ category: 'food' })).toBe(2)
        expect(await tx.get('t2')).toBeUndefined()
        expect(await tx.deleteOne({ category: 'none' })).toBe(0)
        expect(await tx.deleteMany({ accountId: 'a1' })).toBe(3)
        expect(ids(await tx.find())).toEqual(['t3', 't5'])
        expect(await tx.deleteMany({})).toBe(2)
        expect(await tx.count()).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    describe('indexes', () => {
      it('are declared, listed, idempotent and dropped', async () => {
        const c = db.collection('c')
        await c.ensureIndex({ name: 'byKey', fields: ['key'] })
        await c.ensureIndex({ name: 'byKey', fields: ['key'] })
        await c.ensureIndex({ name: 'byPair', fields: ['a', 'b'], unique: true })
        expect(await c.indexes()).toEqual([{ name: 'byKey', fields: ['key'] }, { name: 'byPair', fields: ['a', 'b'], unique: true }])
        await c.dropIndex('byKey')
        expect(await c.indexes()).toEqual([{ name: 'byPair', fields: ['a', 'b'], unique: true }])
        await expectCode(c.ensureIndex({ name: '', fields: ['x'] }), 'INVALID_ARGUMENT')
        await expectCode(c.ensureIndex({ name: 'x', fields: [] }), 'INVALID_ARGUMENT')
      })

      it('unique indexes reject duplicates on insert, replace and update', async () => {
        const c = db.collection('c')
        await c.ensureIndex({ name: 'byExternal', fields: ['accountId', 'externalId'], unique: true })
        await c.insert({ id: '1', accountId: 'a', externalId: 'x' })
        await c.insert({ id: '2', accountId: 'b', externalId: 'x' })            // different account: fine
        const err = await expectCode(c.insert({ id: '3', accountId: 'a', externalId: 'x' }), 'UNIQUE_VIOLATION')
        expect((err as { details?: { index?: string } }).details?.index).toBe('byExternal')
        await expectCode(c.replace({ id: '2', accountId: 'a', externalId: 'x' }), 'UNIQUE_VIOLATION')
        await expectCode(c.updateOne({ id: '2' }, { $set: { accountId: 'a' } }), 'UNIQUE_VIOLATION')
        await expectCode(c.insertMany([{ id: '4', accountId: 'c', externalId: 'y' }, { id: '5', accountId: 'c', externalId: 'y' }]), 'UNIQUE_VIOLATION')
        expect(await c.count()).toBe(2)

        await c.replace({ id: '1', accountId: 'a', externalId: 'x', note: 'same key, same doc' })   // replacing itself is fine
        await c.deleteOne({ id: '1' })
        await c.insert({ id: '3', accountId: 'a', externalId: 'x' })            // free again after the delete
      })

      it('unique indexes are sparse: documents missing a field are not indexed', async () => {
        const c = db.collection('c')
        await c.ensureIndex({ name: 'byExternal', fields: ['externalId'], unique: true })
        await c.insert({ id: '1' })
        await c.insert({ id: '2' })
        await c.insert({ id: '3', externalId: null })
        await expectCode(c.insert({ id: '4', externalId: null }), 'UNIQUE_VIOLATION')
      })

      it('cannot build a unique index over duplicates', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: '1', k: 'x' }, { id: '2', k: 'x' }])
        await expectCode(c.ensureIndex({ name: 'byK', fields: ['k'], unique: true }), 'UNIQUE_VIOLATION')
        expect(await c.indexes()).toEqual([])
        await c.ensureIndex({ name: 'byK', fields: ['k'] })                    // non-unique is fine
      })

      it('unique violations inside a transaction roll it back', async () => {
        const c = db.collection('c')
        await c.ensureIndex({ name: 'byK', fields: ['k'], unique: true })
        await c.insert({ id: '1', k: 'x' })
        await expectCode(db.transaction(async tx => {
          await tx.collection('c').insert({ id: '2', k: 'y' })
          await tx.collection('c').insert({ id: '3', k: 'x' })
        }), 'UNIQUE_VIOLATION')
        expect(ids(await c.find())).toEqual(['1'])
        await expectCode(db.transaction(async tx => { await tx.collection('c').ensureIndex({ name: 'z', fields: ['z'] }) }), 'INVALID_ARGUMENT')
      })
    })

    // -----------------------------------------------------------------------
    describe('pagination', () => {
      it('pages in sort order with a cursor, and stays correct while data changes', async () => {
        const tx = await seed()
        const sort = { date: -1 as const }
        const page1 = await tx.findPage({ accountId: 'a1' }, { sort, limit: 2 })
        expect(ids(page1.items)).toEqual(['t6', 't4'])
        expect(page1.next).toBeTruthy()

        // Inserting before and after the cursor must not shift or repeat what follows.
        await tx.insert({ id: 't0', accountId: 'a1', date: '2026-03-01', amount: 1 })
        await tx.insert({ id: 't7', accountId: 'a1', date: '2026-01-07', amount: 1 })
        await tx.deleteOne({ id: 't4' })

        const page2 = await tx.findPage({ accountId: 'a1' }, { sort, limit: 2, after: page1.next })
        expect(ids(page2.items)).toEqual(['t2', 't7'])
        const page3 = await tx.findPage({ accountId: 'a1' }, { sort, limit: 2, after: page2.next })
        expect(ids(page3.items)).toEqual(['t1'])
        expect(page3.next).toBeUndefined()
      })

      it('breaks ties by id and handles exact page boundaries', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: 'b', g: 1 }, { id: 'a', g: 1 }, { id: 'd', g: 0 }, { id: 'c', g: 1 }])
        const page1 = await c.findPage(undefined, { sort: { g: -1 }, limit: 2 })
        expect(ids(page1.items)).toEqual(['a', 'b'])
        const page2 = await c.findPage(undefined, { sort: { g: -1 }, limit: 2, after: page1.next })
        expect(ids(page2.items)).toEqual(['c', 'd'])
        expect(page2.next).toBeUndefined()
      })

      it('rejects bad cursors and limits', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1' })
        await expectCode(c.findPage(undefined, { limit: 0 }), 'INVALID_ARGUMENT')
        await expectCode(c.findPage(undefined, { limit: 1, after: '!!!' }), 'INVALID_ARGUMENT')
        const page = await c.findPage(undefined, { sort: { a: 1 }, limit: 1 })
        expect(page.next).toBeUndefined()
        const withMore = await (async () => { await c.insert({ id: '2' }); return c.findPage(undefined, { sort: { a: 1 }, limit: 1 }) })()
        await expectCode(c.findPage(undefined, { sort: { a: 1, b: 1 }, limit: 1, after: withMore.next }), 'INVALID_ARGUMENT')
      })
    })

    // -----------------------------------------------------------------------
    describe('aggregation', () => {
      it('$match, $group with every accumulator, $sort', async () => {
        const tx = await seed()
        const rows = await tx.aggregate([
          { $match: { amount: { $lt: 0 } } },
          { $group: {
            _id: '$category',
            total: { $sum: '$amount' },
            count: { $count: {} },
            avg: { $avg: '$amount' },
            min: { $min: '$amount' },
            max: { $max: '$amount' },
            first: { $first: '$id' },
            last: { $last: '$id' },
            payees: { $push: '$payee' }
          } },
          { $sort: { total: 1 } }
        ])
        expect(rows).toEqual([
          { _id: 'rent', total: -2400, count: 2, avg: -1200, min: -1200, max: -1200, first: 't1', last: 't4', payees: ['Acme Lettings', 'Acme Lettings'] },
          { _id: 'food', total: -155, count: 3, avg: -155 / 3, min: -80, max: -30, first: 't2', last: 't6', payees: ['Corner Shop', 'Amazon Fresh', 'amazon'] }
        ])
      })

      it('groups everything with _id null, and by a compound key', async () => {
        const tx = await seed()
        expect(await tx.aggregate([{ $group: { _id: null, net: { $sum: '$amount' }, n: { $count: {} } } }])).toEqual([{ _id: null, net: 445, n: 6 }])
        const rows = await tx.aggregate([
          { $group: { _id: { account: '$accountId', month: { $substr: ['$date', 0, 7] } }, net: { $sum: '$amount' } } },
          { $sort: { '_id.account': 1, '_id.month': 1 } }
        ])
        expect(rows).toEqual([
          { _id: { account: 'a1', month: '2026-01' }, net: -1245 },
          { _id: { account: 'a1', month: '2026-02' }, net: -1230 },
          { _id: { account: 'a2', month: '2026-01' }, net: 3000 },
          { _id: { account: 'a2', month: '2026-02' }, net: -80 }
        ])
      })

      it('$sum ignores non-numbers, $avg of none is null, $min/$max skip nulls', async () => {
        const c = db.collection('c')
        await c.insertMany([{ id: '1', v: 'x' }, { id: '2' }, { id: '3', v: null }])
        expect(await c.aggregate([{ $group: { _id: null, s: { $sum: '$v' }, a: { $avg: '$v' }, lo: { $min: '$v' }, hi: { $max: '$v' } } }]))
          .toEqual([{ _id: null, s: 0, a: null, lo: 'x', hi: 'x' }])
      })

      it('$project with inclusion, exclusion and computed fields', async () => {
        const tx = await seed()
        expect(await tx.aggregate([{ $match: { id: 't1' } }, { $project: { payee: 1, year: { $year: '$date' }, month: { $month: '$date' } } }]))
          .toEqual([{ id: 't1', payee: 'Acme Lettings', year: 2026, month: 1 }])
        expect(await tx.aggregate([{ $match: { id: 't2' } }, { $project: { id: 0, memo: 0, tags: 0, payee: 0, category: 0, rev: 0 } }]))
          .toEqual([{ accountId: 'a1', date: '2026-01-09', amount: -45 }])
        expect(await tx.aggregate([{ $match: { id: 't2' } }, { $project: {
          id: 0,
          label: { $concat: ['$payee', ' / ', '$category'] },
          abs: { $abs: '$amount' },
          doubled: { $multiply: ['$amount', 2] },
          plusOne: { $add: ['$amount', 1] },
          minusOne: { $subtract: ['$amount', 1] },
          half: { $divide: ['$amount', 2] },
          byZero: { $divide: ['$amount', 0] },
          tagged: { $ifNull: ['$tags', 'none'] },
          kind: { $cond: [{ amount: { $lt: 0 } }, 'debit', 'credit'] },
          literal: { fixed: [1, 'two'] }
        } }])).toEqual([{
          label: 'Corner Shop / food', abs: 45, doubled: -90, plusOne: -44, minusOne: -46, half: -22.5, byZero: null,
          tagged: 'none', kind: 'debit', literal: { fixed: [1, 'two'] }
        }])
        await expectCode(tx.aggregate([{ $project: { a: 1, b: 0 } }]), 'INVALID_ARGUMENT')
      })

      it('$unwind, $skip, $limit, $count', async () => {
        const tx = await seed()
        expect(await tx.aggregate([{ $unwind: '$splits' }, { $project: { id: 0, cat: '$splits.category', amt: '$splits.amount' } }]))
          .toEqual([{ cat: 'food', amt: -60 }, { cat: 'gifts', amt: -20 }])
        expect(await tx.aggregate([{ $sort: { date: 1 } }, { $skip: 1 }, { $limit: 2 }, { $project: { id: 1 } }]))
          .toEqual([{ id: 't2' }, { id: 't3' }])
        expect(await tx.aggregate([{ $match: { accountId: 'a1' } }, { $count: 'n' }])).toEqual([{ n: 4 }])
      })

      it('$lookup joins within the database', async () => {
        const tx = await seed()
        const rows = await tx.aggregate([
          { $group: { _id: '$accountId', net: { $sum: '$amount' } } },
          { $lookup: { from: 'accounts.accounts', localField: '_id', foreignField: 'id', as: 'account' } },
          { $unwind: '$account' },
          { $project: { _id: 0, name: '$account.name', net: 1 } },
          { $sort: { name: 1 } }
        ])
        expect(rows).toEqual([{ name: 'Current', net: -2475 }, { name: 'Savings', net: 2920 }])
        const orphan = await tx.aggregate([{ $match: { id: 't1' } }, { $lookup: { from: 'nothing', localField: 'accountId', foreignField: 'id', as: 'x' } }, { $project: { x: 1 } }])
        expect(orphan).toEqual([{ id: 't1', x: [] }])
      })

      it('rejects stages and operators outside the contract', async () => {
        const tx = await seed()
        await expectCode(tx.aggregate([{ $facet: {} } as never]), 'UNSUPPORTED_QUERY')
        await expectCode(tx.aggregate([{ $project: { x: { $toUpper: '$payee' } } } as never]), 'UNSUPPORTED_QUERY')
        await expectCode(tx.aggregate([{ $group: { _id: null, x: { $stdDev: '$amount' } } } as never]), 'INVALID_ARGUMENT')
        await expectCode(tx.aggregate([{ $group: { _id: null, x: '$amount' } }]), 'INVALID_ARGUMENT')
        await expectCode(tx.aggregate([{ $limit: -1 }]), 'INVALID_ARGUMENT')
      })

      it('does not leak the documents it works on', async () => {
        const tx = await seed()
        const [row] = await tx.aggregate([{ $match: { id: 't1' } }])
        ;(row.tags as string[]).push('leak')
        expect((await tx.get('t1'))?.tags).toEqual(['fixed'])
      })
    })

    // -----------------------------------------------------------------------
    describe('transactions', () => {
      it('commits all writes together', async () => {
        const result = await db.transaction(async tx => {
          await tx.collection('a').insert({ id: '1' })
          await tx.collection('b').insert({ id: '1' })
          await tx.collection('a').updateOne({ id: '1' }, { $set: { v: 2 } })
          return 'done'
        })
        expect(result).toBe('done')
        expect(await db.collection('a').get('1')).toEqual({ id: '1', rev: 2, v: 2 })
        expect(await db.collection('b').count()).toBe(1)
      })

      it('rolls back everything when work throws, and rethrows', async () => {
        await db.collection('a').insert({ id: 'existing' })
        await expect(db.transaction(async tx => {
          await tx.collection('a').insert({ id: '1' })
          await tx.collection('a').deleteOne({ id: 'existing' })
          await tx.collection('b').insert({ id: '1' })
          throw new Error('abort')
        })).rejects.toThrow('abort')
        expect(ids(await db.collection('a').find())).toEqual(['existing'])
        expect(await db.collection('b').count()).toBe(0)
        expect((await db.listCollections()).map(c => c.name)).toEqual(['a'])
      })

      it('shows its own writes inside and nothing outside until commit', async () => {
        const live = db.collection('a')
        await live.insert({ id: '1', v: 1 })
        await db.transaction(async tx => {
          const c = tx.collection('a')
          await c.updateOne({ id: '1' }, { $set: { v: 2 } })
          await c.insert({ id: '2' })
          expect((await c.get('1'))?.v).toBe(2)
          expect(await c.count()).toBe(2)
          expect(ids(await c.find({ v: { $exists: false } }))).toEqual(['2'])
          expect((await live.get('1'))?.v).toBe(1)
          expect(await live.count()).toBe(1)
        })
        expect((await live.get('1'))?.v).toBe(2)
        expect(await live.count()).toBe(2)
      })

      it('runs concurrent transactions one at a time, keeping every write', async () => {
        const c = db.collection('c')
        await c.insert({ id: 'counter', n: 0 })
        await Promise.all(Array.from({ length: 5 }, (_, i) => db.transaction(async tx => {
          const current = await tx.collection('c').get('counter')
          await new Promise(resolve => setTimeout(resolve, 2))
          await tx.collection('c').replace({ id: 'counter', n: (current!.n as number) + 1 })
          await tx.collection('c').insert({ id: `row${i}` })
        })))
        expect((await c.get('counter'))?.n).toBe(5)
        expect(await c.count()).toBe(6)
      })

      it('fails with CONFLICT if a collection it wrote was written outside it', async () => {
        const c = db.collection('c')
        await c.insert({ id: '1', v: 1 })
        await expectCode(db.transaction(async tx => {
          await tx.collection('c').updateOne({ id: '1' }, { $set: { v: 'tx' } })
          await c.updateOne({ id: '1' }, { $set: { v: 'outside' } })
        }), 'CONFLICT')
        expect((await c.get('1'))?.v).toBe('outside')
      })

      it('is not affected by outside writes to collections it only read', async () => {
        const c = db.collection('c')
        await db.transaction(async tx => {
          await tx.collection('c').count()
          await c.insert({ id: 'outside' })
          await tx.collection('other').insert({ id: 'inside' })
        })
        expect(await c.count()).toBe(1)
        expect(await db.collection('other').count()).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('change events', () => {
      let events: ChangeEvent[]
      beforeEach(() => {
        events = []
        db.onDidChange(event => events.push(event))
      })

      it('fire once per collection and kind after a commit, never on rollback', async () => {
        await db.transaction(async tx => {
          await tx.collection('a').insert({ id: '1' })
          await tx.collection('a').insert({ id: '2' })
          await tx.collection('a').updateOne({ id: '1' }, { $set: { v: 1 } })
          await tx.collection('b').deleteMany({})
          await tx.collection('b').insert({ id: '1' })
          await tx.collection('b').deleteOne({ id: '1' })
          expect(events).toEqual([])
        })
        expect(events).toEqual([
          { database: 'test', collection: 'a', kind: 'insert', ids: ['1', '2'] },
          { database: 'test', collection: 'a', kind: 'update', ids: ['1'] },
          { database: 'test', collection: 'b', kind: 'insert', ids: ['1'] },
          { database: 'test', collection: 'b', kind: 'delete', ids: ['1'] }
        ])

        events.length = 0
        await db.transaction(async tx => {
          await tx.collection('a').insert({ id: '3' })
          throw new Error('abort')
        }).catch(() => {})
        expect(events).toEqual([])
      })

      it('fire for writes outside a transaction, and stop after dispose', async () => {
        const c = db.collection('c')
        const stored = await c.insert({ v: 1 })
        await c.updateMany({}, { $set: { v: 2 } })
        await c.updateMany({}, { $set: { v: 2 } })       // unchanged: no event
        await c.replace({ id: 'up', v: 1 }, { upsert: true })
        const upserted = await c.updateOne({ k: 'x' }, { $set: { v: 1 } }, { upsert: true })
        await c.deleteMany({})
        expect(events).toEqual([
          { database: 'test', collection: 'c', kind: 'insert', ids: [stored.id] },
          { database: 'test', collection: 'c', kind: 'update', ids: [stored.id] },
          { database: 'test', collection: 'c', kind: 'insert', ids: ['up'] },
          { database: 'test', collection: 'c', kind: 'insert', ids: [upserted.upsertedId!] },
          { database: 'test', collection: 'c', kind: 'delete', ids: [stored.id, 'up', upserted.upsertedId!] }
        ])

        const other: ChangeEvent[] = []
        const subscription = db.onDidChange(event => other.push(event))
        subscription.dispose()
        await c.insert({ id: 'after' })
        expect(other).toEqual([])
      })
    })

    // -----------------------------------------------------------------------
    if (harness.reopen) {
      describe('persistence', () => {
        it('keeps data, indexes and meta across closeAll and reopen', async () => {
          const tx = await seed()
          await tx.ensureIndex({ name: 'byAccountDate', fields: ['accountId', 'date'] })
          await tx.ensureIndex({ name: 'byExternal', fields: ['externalId'], unique: true })
          await db.meta.set('schema.accounts', 3)
          await db.transaction(async t => { await t.collection('accounts.transactions').updateOne({ id: 't1' }, { $set: { memo: 'edited' } }) })
          await db.flush()
          await engine.closeAll()

          engine = await harness.reopen!(engine)
          db = await engine.open({ name: 'test' })
          const again = db.collection<Tx>('accounts.transactions')
          expect(await again.count()).toBe(6)
          expect(await again.get('t1')).toEqual({ ...TRANSACTIONS[0], rev: 2, memo: 'edited' })
          expect(await again.indexes()).toEqual([
            { name: 'byAccountDate', fields: ['accountId', 'date'] },
            { name: 'byExternal', fields: ['externalId'], unique: true }
          ])
          await again.insert({ id: 'x', accountId: 'a1', date: '2026-03-01', amount: 1, externalId: 'e1' } as Tx)
          await expectCode(again.insert({ id: 'y', accountId: 'a1', date: '2026-03-01', amount: 1, externalId: 'e1' } as Tx), 'UNIQUE_VIOLATION')
          expect(await db.meta.get('schema.accounts')).toBe(3)
          expect((await db.listCollections()).map(c => c.name)).toEqual(['accounts.accounts', 'accounts.transactions'])
        })
      })
    }
  })
}
