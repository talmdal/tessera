// @vitest-environment node
// `npm run bench:backup`: the scaled book it times must be a valid book, its measurements must be of the real code
// and leave nothing behind, and its verdict must say what the numbers say.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryEngine } from '@tessera/storage-kit'
import type { DatabaseSnapshot } from '@tessera/types'
import { GROWING, documentCount, formatTable, inflate, measure, verdict, type Row } from '../../scripts/bench/bench'
import { parseArgs } from '../../scripts/bench/main'

/** A small book shaped like a real one: transactions with a sparse unique (account, external id) index. */
const BOOK: DatabaseSnapshot = {
  meta: { 'ledger.format': 1, 'ledger.schema.accounts': 1 },
  collections: [
    { name: 'accounts.accounts', indexes: [{ name: 'uniqueName', fields: ['nameKey'], unique: true }], docs: [{ id: 'chq', rev: 1, nameKey: 'chequing' }] },
    {
      name: GROWING,
      indexes: [{ name: 'uniqueExternalId', fields: ['accountId', 'externalId'], unique: true }],
      docs: [
        { id: 't1', rev: 1, accountId: 'chq', externalId: 'FIT-1', amount: -100 },
        { id: 't2', rev: 1, accountId: 'chq', amount: -250 },
        { id: 't3', rev: 2, accountId: 'chq', externalId: 'FIT-3', amount: 5000, memo: 'pay' }
      ]
    }
  ]
}

const dirs: string[] = []
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-bench-test-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('scaling a book up', () => {
  it('repeats only the transactions, leaving the rest of the book as it is', () => {
    const big = inflate(BOOK, 4)
    expect(big.collections.find(c => c.name === GROWING)!.docs).toHaveLength(12)
    expect(big.collections.find(c => c.name === 'accounts.accounts')).toBe(BOOK.collections[0])
    expect(big.meta).toBe(BOOK.meta)
    expect(documentCount(big)).toBe(13)
  })

  it('leaves a book at 1× exactly as it was', () => {
    expect(inflate(BOOK, 1)).toEqual(BOOK)
  })

  it('makes a valid book: fresh ids, fresh external ids, in id order, loadable with its unique index', async () => {
    const big = inflate(BOOK, 3)
    const docs = big.collections.find(c => c.name === GROWING)!.docs
    expect(new Set(docs.map(d => d.id)).size).toBe(docs.length)
    expect(docs.map(d => d.id)).toEqual([...docs.map(d => d.id)].sort())
    expect(docs.filter(d => d.externalId === undefined)).toHaveLength(3)       // a row without one stays without
    const db = await createMemoryEngine().open({ name: 'scaled' })
    await db.load(big)                                                          // a duplicate key would throw here
    expect(await db.collection(GROWING).count()).toBe(9)
  })

  it('varies the copies, the same way each time for the same seed', () => {
    const amounts = (seed: number) => inflate(BOOK, 5, seed).collections.find(c => c.name === GROWING)!.docs.map(d => d.amount)
    expect(amounts(1)).toEqual(amounts(1))
    expect(amounts(1)).not.toEqual(amounts(2))
    expect(new Set(amounts(1)).size).toBeGreaterThan(5)
  })
})

describe('measuring', () => {
  it.each(['sqlite', 'loki'])('times the real steps on %s, takes the median, and leaves nothing behind', async engine => {
    const work = tempDir()
    const row = await measure(engine, inflate(BOOK, 2), 2, work, 3)
    expect(row).toMatchObject({ engine, factor: 2, documents: 7 })
    for (const step of ['open', 'snapshot', 'write', 'verify', 'restore'] as const) expect(row[step]).toBeGreaterThanOrEqual(0)
    expect(row.bookBytes).toBeGreaterThan(0)
    expect(row.backupBytes).toBeGreaterThan(0)
    expect(fs.readdirSync(work)).toEqual([])
  })

  it('refuses an engine it doesn’t know', async () => {
    await expect(measure('mongo', BOOK, 1, tempDir())).rejects.toThrow('Unknown engine "mongo": use sqlite or loki')
  })
})

describe('reporting', () => {
  const row = (over: Partial<Row>): Row => ({
    engine: 'sqlite', factor: 1, documents: 1836, bookBytes: 1153433, backupBytes: 104858,
    open: 8, snapshot: 4, write: 37, quit: 41, verify: 22, restore: 45, ...over
  })

  it('is a Markdown table, ready for the design note', () => {
    expect(formatTable([row({}), row({ engine: 'loki', documents: 303321, quit: 1114.4, restore: 2722 })]).split('\n')).toEqual([
      '| Engine | Documents | Book | Backup | Open | Snapshot | Write | **Quit path** | Verify | Restore |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| sqlite | 1,836 | 1.1 MB | 0.1 MB | 8 | 4 | 37 | **41** | 22 | 45 |',
      '| loki | 303,321 | 1.1 MB | 0.1 MB | 8 | 4 | 37 | **1,114** | 22 | 2,722 |'
    ])
  })

  it('judges the slowest quit path against the budget', () => {
    expect(verdict([row({ quit: 41 }), row({ engine: 'loki', quit: 1500 })], 6000)).toEqual({
      fits: true, text: 'The slowest quit path, 1,500 ms (loki, 1,836 documents), fits the 6,000 ms shutdown budget 4.0× over.'
    })
    expect(verdict([row({ quit: 7000 })], 6000)).toMatchObject({ fits: false, text: expect.stringContaining('does NOT fit') })
  })
})

describe('the command line', () => {
  it('times every engine at five sizes, three runs each, by default', () => {
    expect(parseArgs([])).toEqual({ factors: [1, 10, 50, 100, 200], engines: ['sqlite', 'loki'], runs: 3, seed: 1 })
  })

  it('takes a book, sizes, engines, runs and a seed', () => {
    expect(parseArgs(['--book', 'My Book, 2026.tessera', '--factors', '1, 20', '--engines', 'loki', '--runs', '5', '--seed', '9'])).toEqual({
      book: path.resolve('My Book, 2026.tessera'), factors: [1, 20], engines: ['loki'], runs: 5, seed: 9
    })
  })

  it('says what is wrong with a bad argument', () => {
    expect(() => parseArgs(['--engines', 'mongo'])).toThrow('Unknown engine "mongo"')
    expect(() => parseArgs(['--runs', '0'])).toThrow('--runs must be a whole number of at least 1')
    expect(() => parseArgs(['--factors', '1,x'])).toThrow('--factors must be a whole number')
    expect(() => parseArgs(['--book'])).toThrow('--book needs a path')
    expect(() => parseArgs(['--fast'])).toThrow('Unknown option "--fast"')
  })

  it('prints its usage for --help, and does nothing else', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(parseArgs(['--help'])).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('npm run bench:backup'))
    log.mockRestore()
  })
})
