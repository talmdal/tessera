// Shared by the backup tests: a book-shaped snapshot, and ways to turn streams into bytes and back.
import { Readable, Writable } from 'node:stream'
import type { Database, DatabaseSnapshot } from '@tessera/types'
import { BOOK_META } from '@tessera/book-api'
import type { BackupSource } from '../../../../plugins/book/src/privileged/backups/backupFile'

export const SOURCE: BackupSource = {
  book: { id: '01JD3K5V8Q2W4E6R8T0Y2U4A6B', name: 'Home Finances', path: '/home/kim/Documents/Home Finances.tessera' },
  takenAt: new Date('2026-11-19T18:42:10.512Z'),
  trigger: 'auto',
  app: 'book 0.1.0',
  engine: 'storage-sqlite'
}

/**
 * Fills a database the way a real book looks: book meta, contributors' data versions, indexes (one unique),
 * documents edited after insert, and text that JSON lines must survive (newlines, quotes, line separators, emoji).
 */
export async function fillBook(db: Database) {
  await db.meta.set(BOOK_META.format, 1)
  await db.meta.set(BOOK_META.id, SOURCE.book.id)
  await db.meta.set(BOOK_META.schemaVersion('accounts'), 3)
  await db.meta.set(BOOK_META.schemaVersion('recurring'), 2)

  const accounts = db.collection<any>('accounts.accounts')
  await accounts.ensureIndex({ fields: ['code'], unique: true })
  await accounts.insertMany([
    { id: 'chq', code: 'CHQ', name: 'Chequing', opening: 125000, closed: false },
    { id: 'sav', code: 'SAV', name: 'Savings', notes: 'line one\nline two\t"quoted" sep', tags: ['emergency', '🏦'] }
  ])
  await accounts.updateOne({ id: 'chq' }, { $set: { name: 'Everyday Chequing' } })

  const transactions = db.collection<any>('accounts.transactions')
  await transactions.ensureIndex({ name: 'byAccountDate', fields: ['accountId', 'date'] })
  await transactions.insertMany(Array.from({ length: 50 }, (_, i) => ({
    id: `t${String(i).padStart(3, '0')}`, accountId: i % 2 ? 'chq' : 'sav', date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-15`,
    amount: (i % 7 - 3) * 1234, payee: `Payee ${i}`, split: i % 10 === 0 ? [{ category: 'food', amount: 1 }, { category: null, amount: 2 }] : undefined
  })))
  await db.collection('ledger.subledgers').insert({ id: 'sb1', parentId: null, name: 'Rental', order: 0 })
  await db.collection('budgets.things').insert({ id: 'from-a-plugin-not-installed', anything: { deep: [1, [2, [3]]] } })
}

export async function bookSnapshot(db: Database): Promise<DatabaseSnapshot> {
  await fillBook(db)
  return db.snapshot()
}

/** A writable that keeps everything written to it. */
export function collector() {
  const chunks: Buffer[] = []
  const out = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
  return { out, bytes: () => Buffer.concat(chunks) }
}

/** Bytes as a stream, in chunks of `size`, counting how many bytes were actually handed out. */
export function source(bytes: Buffer, size = 16 * 1024) {
  const delivered = { bytes: 0 }
  function* chunks() {
    for (let at = 0; at < bytes.length; at += size) {
      const chunk = bytes.subarray(at, at + size)
      delivered.bytes += chunk.length
      yield chunk
    }
  }
  return { stream: Readable.from(chunks(), { objectMode: false }), delivered }
}

/** The code a promise rejects with (a BookError's), or undefined if it resolved. */
export async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(() => undefined, (err: { code?: string }) => err.code ?? `not coded: ${String(err)}`)
}

/** The message a promise rejects with. */
export async function messageOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => 'resolved', (err: Error) => err.message)
}
