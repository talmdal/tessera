// @vitest-environment node
// The 2 → 3 migration: an earlier build of this feature kept one `exchange.pending` document per statement row
// and the statement itself in `exchange.statements`. A book it touched must open cleanly and keep its
// statements to read, converted to one document per statement; nothing it left behind may crash the service.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { EXCHANGE_COLLECTIONS, type PendingStatement } from '@tessera/exchange-api'
import {
  EXCHANGE_SCHEMA, convertPerRowPending, exchangeMigrator, stampAcceptedRows
} from '../../../plugins/exchange/src/privileged/schema'
import { document, setupExchange } from './harness'

const legacyStatement = {
  batchId: 'batch-1', accountId: 'acct-1', formatId: 'exchange-ofx.ofx', dialect: 'OFX 102 (SGML)',
  fileName: 'personal-chequing-2026-10.ofx', fileHash: 'abc123', institution: 'Maple Trust Bank',
  importedAt: '2026-11-18T17:55:07.253Z', period: { from: '2026-10-01', to: '2026-10-31' },
  balance: { amount: 800000, asOf: '2026-10-31' }, read: 3
}
const legacyRow = (statementId: string, index: number, over: Record<string, unknown> = {}) => ({
  statementId, batchId: 'batch-1', accountId: 'acct-1', index,
  incoming: { date: `2026-10-0${index + 1}`, amount: -1000 * (index + 1), externalId: `FIT-${index}`, payee: `Payee ${index}` },
  draft: { date: `2026-10-0${index + 1}`, amount: -1000 * (index + 1), status: 'electronic' },
  disposition: 'new', matchedBy: 'none', reason: 'Not in this account yet',
  ...over
})

async function bookWithLegacyData() {
  const engine = new KitStorageEngine(memoryDriver())
  const db = await engine.open({ name: 'book' }, { schema: EXCHANGE_SCHEMA.collections })
  const statements = db.collection<typeof legacyStatement>(EXCHANGE_COLLECTIONS.legacyStatements)
  const pending = db.collection<Record<string, unknown>>(EXCHANGE_COLLECTIONS.pending)
  const stored = await statements.insert(legacyStatement)
  // The user matched the third row by hand; the matcher's own proposal on the first is not kept
  await pending.insert(legacyRow(stored.id, 2, { disposition: 'merge', matchedBy: 'user', existingId: 'txn-9', reason: 'Matched by you' }))
  await pending.insert(legacyRow(stored.id, 0, { disposition: 'merge', matchedBy: 'heuristic', existingId: 'txn-1' }))
  await pending.insert(legacyRow(stored.id, 1))
  // A row whose statement is gone cannot be read, and is dropped
  await pending.insert(legacyRow('no-such-statement', 0))
  return { db, pending, statements }
}

describe('converting the per-row pending layout', () => {
  it('writes one statement document in place of its rows, keeping the user’s matches', async () => {
    const { db, pending, statements } = await bookWithLegacyData()
    await exchangeMigrator.migrate(db, 2)

    const docs = await pending.find()
    expect(docs).toHaveLength(1)
    const converted = docs[0] as unknown as PendingStatement
    expect(converted).toMatchObject({
      accountId: 'acct-1', fileName: 'personal-chequing-2026-10.ofx', fileHash: 'abc123', formatId: 'exchange-ofx.ofx',
      dialect: 'OFX 102 (SGML)', readAt: '2026-11-18T17:55:07.253Z', batchId: 'batch-1',
      period: { from: '2026-10-01', to: '2026-10-31' }, ledger: { amount: 800000, asOf: '2026-10-31' }
    })
    expect(converted.rows.map(r => r.key)).toEqual(['r0', 'r1', 'r2'])
    expect(converted.rows.map(r => r.transaction.externalId)).toEqual(['FIT-0', 'FIT-1', 'FIT-2'])
    expect(converted.rows[0].userMatch).toBeUndefined()
    expect(converted.rows[2].userMatch).toBe('txn-9')
    expect(await statements.find()).toEqual([])
  })

  it('is safe to run again, and leaves documents already in the new shape alone', async () => {
    const { db, pending } = await bookWithLegacyData()
    await convertPerRowPending(db)
    const [once] = await pending.find()
    await convertPerRowPending(db)
    expect(await pending.find()).toEqual([once])
  })

  it('does nothing to a book that never had the old layout', async () => {
    const engine = new KitStorageEngine(memoryDriver())
    const db = await engine.open({ name: 'book' }, { schema: EXCHANGE_SCHEMA.collections })
    await exchangeMigrator.migrate(db, 2)
    expect(await db.collection(EXCHANGE_COLLECTIONS.pending).find()).toEqual([])
  })
})

describe('a document the service does not recognise', () => {
  it('is ignored with one warning, rather than stopping the book from opening', async () => {
    const { service, session, log, fileOf, chq } = await setupExchange()
    await fileOf(document())
    await session.database('exchange').collection<Record<string, unknown>>(EXCHANGE_COLLECTIONS.pending)
      .insert(legacyRow('stmt-x', 0))

    expect(await service.pendingCount()).toBe(1)
    expect((await service.pendingSummary())[0]).toMatchObject({ accountId: chq.id, items: 1 })
    expect(await service.overlayRows(chq.id)).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/not in a shape this version understands/))
  })
})

// The 3 → 4 migration: the history used to hold bare transaction ids and one timestamp per batch, which was
// rewritten on every acceptance. Each written row now carries when it was accepted, so undo can tell a row
// edited since *it* was imported from one merely accepted later in the same batch.
const oldBatch = (over: Record<string, unknown> = {}) => ({
  importedAt: '2026-11-18T17:55:07.253Z',
  formatId: 'exchange-ofx.ofx',
  fileName: 'personal-chequing-2026-10.ofx',
  fileHash: 'abc123',
  accountIds: ['acct-1'],
  created: [{ accountId: 'acct-1', ids: ['txn-1', 'txn-2'] }],
  merged: [{ accountId: 'acct-1', id: 'txn-9', before: { status: 'uncleared' } }],
  createdAccounts: [],
  createdCategories: [],
  counts: { read: 3, imported: 2, merged: 1, duplicates: 0, skipped: 0, unsupported: 0 },
  manualMatches: 0,
  ...over
})

async function bookWithOldHistory(...batches: Record<string, unknown>[]) {
  const engine = new KitStorageEngine(memoryDriver())
  const db = await engine.open({ name: 'book' }, { schema: EXCHANGE_SCHEMA.collections })
  const collection = db.collection<Record<string, unknown>>(EXCHANGE_COLLECTIONS.batches)
  for (const batch of batches) await collection.insert(batch)
  return { db, collection }
}

describe('stamping the history’s rows with when they were accepted', () => {
  it('turns bare ids into rows carrying the batch’s time, which is the best the old data can say', async () => {
    const { db, collection } = await bookWithOldHistory(oldBatch())
    await stampAcceptedRows(db)

    const [batch] = await collection.find()
    expect(batch.created).toEqual([{
      accountId: 'acct-1',
      rows: [
        { id: 'txn-1', at: '2026-11-18T17:55:07.253Z' },
        { id: 'txn-2', at: '2026-11-18T17:55:07.253Z' }
      ]
    }])
    expect(batch.merged).toEqual([
      { accountId: 'acct-1', id: 'txn-9', at: '2026-11-18T17:55:07.253Z', before: { status: 'uncleared' } }
    ])
  })

  it('gives the batch a lastAcceptedAt, since the old shape had only the one timestamp', async () => {
    const { db, collection } = await bookWithOldHistory(oldBatch())
    await stampAcceptedRows(db)
    const [batch] = await collection.find()
    expect(batch.lastAcceptedAt).toBe('2026-11-18T17:55:07.253Z')
    expect(batch.importedAt).toBe('2026-11-18T17:55:07.253Z')
  })

  it('leaves a batch already converted alone, so running it again changes nothing', async () => {
    const { db, collection } = await bookWithOldHistory(oldBatch())
    await stampAcceptedRows(db)
    const [once] = await collection.find()
    await stampAcceptedRows(db)
    const [twice] = await collection.find()
    expect(twice).toEqual(once)
  })

  it('survives a batch whose fields are missing or the wrong type', async () => {
    const { db, collection } = await bookWithOldHistory(
      oldBatch({ created: undefined, merged: undefined, importedAt: undefined }),
      oldBatch({ created: [{ accountId: 'acct-1', ids: ['ok', 42, null] }] })
    )
    await stampAcceptedRows(db)

    const all = await collection.find()
    expect(all[0].created).toEqual([])
    expect(all[0].merged).toEqual([])
    expect(all[0].lastAcceptedAt).toEqual(expect.any(String))
    // Only the ids that are real text survive; the rest were never transaction ids.
    expect((all[1].created as { rows: unknown[] }[])[0].rows).toEqual([
      { id: 'ok', at: '2026-11-18T17:55:07.253Z' }
    ])
  })

  it('does nothing to a book with no history at all', async () => {
    const { db, collection } = await bookWithOldHistory()
    await expect(stampAcceptedRows(db)).resolves.toBeUndefined()
    expect(await collection.find()).toEqual([])
  })

  it('runs from the migrator for any book older than version 4', async () => {
    const { db, collection } = await bookWithOldHistory(oldBatch())
    await exchangeMigrator.migrate(db, 3)
    const [batch] = await collection.find()
    expect((batch.created as { rows: unknown[] }[])[0].rows).toHaveLength(2)
  })
})
