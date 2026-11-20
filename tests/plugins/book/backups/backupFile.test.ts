// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createMemoryEngine } from '@tessera/storage-kit'
import type { DatabaseSnapshot } from '@tessera/types'
import { BOOK_FORMAT_VERSION } from '@tessera/book-api'
import {
  BACKUP_FILE_VERSION, backupHeader, backupLines, readBackup, readBackupHeader, readBackupLines, restoreProblem,
  verifyBackup, writeBackup, type BackupHeader
} from '../../../../plugins/book/src/privileged/backups/backupFile'
import { bookSnapshot, codeOf, collector, messageOf, source, SOURCE } from './helpers'

const snapshotOfABook = async () => bookSnapshot(await createMemoryEngine().open({ name: 'book' }))

/** The uncompressed lines of a backup of `snapshot`, as strings without their newlines. */
const linesOf = (header: BackupHeader, snapshot: DatabaseSnapshot) =>
  [...backupLines(header, snapshot)].map(b => b.toString('utf8').slice(0, -1))

/** Joins lines back into the bytes the line reader takes. */
const bytesOf = (lines: string[]) => Buffer.from(lines.map(l => `${l}\n`).join(''), 'utf8')

/** Reads uncompressed lines, as the line layer does. */
const readLines = (lines: string[] | Buffer) => readBackupLines(Readable.from([Buffer.isBuffer(lines) ? lines : bytesOf(lines)]))

/** Re-signs edited lines with a correct trailer, so a test reaches the check after the digest. */
const resign = (lines: string[]) => {
  const body = lines.slice(0, -1)
  const trailer = JSON.parse(lines[lines.length - 1])
  trailer.sha256 = createHash('sha256').update(bytesOf(body)).digest('hex')
  return [...body, JSON.stringify(trailer)]
}

const written = async (snapshot: DatabaseSnapshot, header = backupHeader(SOURCE, snapshot)) => {
  const { out, bytes } = collector()
  const result = await writeBackup(out, header, snapshot)
  return { file: bytes(), result, header }
}

describe('the header', () => {
  it('describes the book, and reads its format, data versions and counts from the snapshot itself', async () => {
    const header = backupHeader(SOURCE, await snapshotOfABook())
    expect(header).toEqual({
      kind: 'tessera-backup', version: BACKUP_FILE_VERSION,
      book: SOURCE.book, takenAt: '2026-11-19T18:42:10.512Z', trigger: 'auto', app: 'book 0.1.0', engine: 'storage-sqlite',
      bookFormat: 1, schemaVersions: { accounts: 3, recurring: 2 },
      counts: { collections: 4, documents: 54, meta: 4 }
    })
  })

  it('refuses a database that is not a book', async () => {
    expect(() => backupHeader(SOURCE, { collections: [], meta: {} })).toThrow('Only a book can be backed up')
  })
})

describe('writing and reading back', () => {
  it('gives back exactly what was written', async () => {
    const snapshot = await snapshotOfABook()
    const { file, header } = await written(snapshot)
    const read = await readBackup(Readable.from([file]))
    expect(read.header).toEqual(header)
    expect(read.snapshot).toEqual(snapshot)
  })

  it('gives back an empty book exactly', async () => {
    const snapshot = { collections: [], meta: { 'ledger.format': 1 } }
    const { file } = await written(snapshot)
    expect((await readBackup(Readable.from([file]))).snapshot).toEqual(snapshot)
  })

  it('is gzip of JSON lines: header first, then meta, collections each followed by their documents, then the trailer', async () => {
    const snapshot = await snapshotOfABook()
    const { file, result } = await written(snapshot)
    const text = gunzipSync(file).toString('utf8')
    expect(text.endsWith('\n')).toBe(true)

    const lines = text.slice(0, -1).split('\n').map(line => JSON.parse(line))
    expect(lines[0].kind).toBe('tessera-backup')
    expect(lines.slice(1, 5).map(l => l.t)).toEqual(['meta', 'meta', 'meta', 'meta'])
    expect(lines[5]).toEqual({ t: 'collection', name: 'accounts.accounts', indexes: [{ name: 'code', fields: ['code'], unique: true }] })
    expect(lines[6]).toMatchObject({ t: 'doc', c: 'accounts.accounts', doc: { id: 'chq', rev: 2 } })

    const body = Buffer.from(text.slice(0, text.lastIndexOf('\n', text.length - 2) + 1), 'utf8')
    const digest = createHash('sha256').update(body).digest('hex')
    expect(lines[lines.length - 1]).toEqual({ t: 'end', documents: 54, sha256: digest })
    expect(result).toEqual({ sha256: digest, documents: 54 })
  })

  it('keeps every line on one line, whatever the documents contain', async () => {
    const snapshot = await snapshotOfABook()
    const lines = linesOf(backupHeader(SOURCE, snapshot), snapshot)
    expect(lines).toHaveLength(1 + 4 + 4 + 54 + 1)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('verifies a whole file without keeping its contents', async () => {
    const { file, header } = await written(await snapshotOfABook())
    expect(await verifyBackup(Readable.from([file]))).toEqual(header)
  })
})

describe('reading only the header', () => {
  it('stops after the first line, without decompressing the rest', async () => {
    // Random text barely compresses, so the file is far larger than the first chunk
    const docs = Array.from({ length: 4000 }, (_, i) => ({ id: `d${i}`, rev: 1, noise: randomBytes(100).toString('hex') }))
    const snapshot: DatabaseSnapshot = { collections: [{ name: 'c', indexes: [], docs }], meta: { 'ledger.format': 1 } }
    const { file, header } = await written(snapshot)
    expect(file.length).toBeGreaterThan(400_000)

    const { stream, delivered } = source(file)
    expect(await readBackupHeader(stream)).toEqual(header)
    expect(delivered.bytes).toBeLessThan(file.length / 4)
    expect(stream.destroyed).toBe(true)
  })

  it('needs only the header to be intact: the rest is verify’s question', async () => {
    const { file, header } = await written(await snapshotOfABook())
    expect(await readBackupHeader(Readable.from([file.subarray(0, Math.floor(file.length * 0.6))]))).toEqual(header)
  })

  it('refuses what is not a backup, and one from a newer Tessera', async () => {
    expect(await codeOf(readBackupHeader(Readable.from([Buffer.from('hello, world')])))).toBe('UNSUPPORTED_FILE')
    expect(await codeOf(readBackupHeader(Readable.from([gzipSync('{"kind":"something-else"}\n')])))).toBe('UNSUPPORTED_FILE')
    expect(await codeOf(readBackupHeader(Readable.from([gzipSync(Buffer.alloc(2 * 1024 * 1024, 'x'))])))).toBe('UNSUPPORTED_FILE')
    const newer = JSON.stringify({ kind: 'tessera-backup', version: BACKUP_FILE_VERSION + 1, whatever: 'shape' })
    expect(await messageOf(readBackupHeader(Readable.from([gzipSync(`${newer}\n`)])))).toContain('newer version of Tessera')
  })
})

describe('refusing a file that is not a backup', () => {
  const cases: [string, Buffer][] = [
    ['an empty file', Buffer.alloc(0)],
    ['plain text', Buffer.from('Date,Amount\n2026-01-01,5\n')],
    ['a book file', Buffer.from('SQLite format 3\0 and then pages')],
    ['gzip of something else', gzipSync('{"hello":"world"}\n')],
    ['gzip of text that is not JSON', gzipSync('not json at all\n')]
  ]
  for (const [what, bytes] of cases) {
    it(what, async () => {
      expect(await messageOf(readBackup(Readable.from([bytes])))).toBe('This is not a Tessera backup.')
    })
  }

  it('refuses a newer backup file format as UNSUPPORTED_FILE, saying why', async () => {
    const snapshot = await snapshotOfABook()
    const lines = linesOf({ ...backupHeader(SOURCE, snapshot), version: BACKUP_FILE_VERSION + 1 }, snapshot)
    const err = await readLines(lines).catch(e => e)
    expect(err).toMatchObject({ code: 'UNSUPPORTED_FILE', message: expect.stringContaining('newer version of Tessera') })
  })
})

describe('refusing a damaged backup', () => {
  let lines: string[]
  const damagedBy = async (edit: (lines: string[]) => string[] | Buffer) => {
    const snapshot = await snapshotOfABook()
    lines = linesOf(backupHeader(SOURCE, snapshot), snapshot)
    const err = await readLines(edit([...lines])).catch(e => e)
    expect(err?.code, String(err?.message ?? err)).toBe('DAMAGED')
    return err.message as string
  }

  it('cut off after any line', async () => {
    const snapshot = await snapshotOfABook()
    const all = linesOf(backupHeader(SOURCE, snapshot), snapshot)
    for (let keep = 1; keep < all.length; keep++) {
      expect(await codeOf(readLines(all.slice(0, keep))), `after ${keep} lines`).toBe('DAMAGED')
    }
  })

  it('cut off part-way through a line', async () => {
    expect(await damagedBy(l => bytesOf(l).subarray(0, bytesOf(l).length - 5))).toContain('part-way through a line')
    expect(await damagedBy(l => bytesOf(l).subarray(0, bytesOf(l).length - 1))).toContain('part-way through a line')
  })

  it('a value changed, however plausibly', async () => {
    expect(await damagedBy(l => l.map(line => line.replace('"amount":-3702', '"amount":-3701')))).toContain('changed since it was written')
  })

  it('a document removed', async () => {
    expect(await damagedBy(l => l.filter(line => !line.includes('"id":"t010"')))).toContain('holds 53 documents, not the 54')
  })

  it('a document removed and the trailer re-signed to hide it: the header still counts', async () => {
    expect(await damagedBy(l => {
      const edited = l.filter(line => !line.includes('"id":"t010"'))
      const trailer = JSON.parse(edited[edited.length - 1])
      edited[edited.length - 1] = JSON.stringify({ ...trailer, documents: 53 })
      return resign(edited)
    })).toContain('do not match its header')
  })

  it('no trailer', async () => {
    expect(await damagedBy(l => l.slice(0, -1))).toContain('ending before its last line')
  })

  it('more after the trailer', async () => {
    expect(await damagedBy(l => [...l, '{"t":"meta","key":"late","value":1}'])).toContain('more after its last line')
  })

  it('an unreadable line', async () => {
    expect(await damagedBy(l => resign(l.map((line, i) => i === 7 ? line.slice(0, -2) : line)))).toContain('not readable')
  })

  it('a line of an unknown kind', async () => {
    expect(await damagedBy(l => resign(l.map((line, i) => i === 7 ? '{"t":"surprise"}' : line)))).toContain('unknown kind')
  })

  it('a document before any collection', async () => {
    expect(await damagedBy(l => resign([l[0], l[6], ...l.slice(1, 6), ...l.slice(7)]))).toContain('outside its collection')
  })

  it('meta after the collections', async () => {
    expect(await damagedBy(l => resign([l[0], ...l.slice(2, -1), l[1], l[l.length - 1]]))).toContain('after the collections')
  })

  it('a collection twice', async () => {
    expect(await damagedBy(l => resign([...l.slice(0, -1), l[5], l[l.length - 1]]))).toContain('appears twice')
  })

  it('a header that is ours but incomplete', async () => {
    expect(await damagedBy(l => {
      const header = JSON.parse(l[0])
      delete header.book
      return [JSON.stringify(header), ...l.slice(1)]
    })).toContain('header is incomplete')
  })

  it('compressed bytes cut off or changed', async () => {
    const { file } = await written(await snapshotOfABook())
    expect(await codeOf(readBackup(Readable.from([file.subarray(0, file.length - 40)])))).toBe('DAMAGED')
    expect(await codeOf(readBackup(Readable.from([file.subarray(0, Math.floor(file.length / 2))])))).toBe('DAMAGED')
    const flipped = Buffer.from(file)
    flipped[Math.floor(flipped.length / 2)] ^= 0xff
    expect(await codeOf(readBackup(Readable.from([flipped])))).toBe('DAMAGED')
  })

  it('a stream that fails is reported as it failed, not as damage', async () => {
    const failing = new Readable({ read() { this.destroy(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })) } })
    expect(await messageOf(readBackup(failing))).toBe('EIO: i/o error')
  })
})

describe('whether this Tessera can restore it', () => {
  const header = (bookFormat: number, schemaVersions: Record<string, number>) =>
    ({ ...backupHeader(SOURCE, { collections: [], meta: { 'ledger.format': 1 } }), bookFormat, schemaVersions })

  it('can, from the same or older versions, and with data of a plugin that is not installed', () => {
    const installed = [{ id: 'accounts', version: 3 }, { id: 'recurring', version: 2 }]
    expect(restoreProblem(header(BOOK_FORMAT_VERSION, { accounts: 3, recurring: 2 }), installed)).toBeUndefined()
    expect(restoreProblem(header(BOOK_FORMAT_VERSION, { accounts: 1 }), installed)).toBeUndefined()
    expect(restoreProblem(header(BOOK_FORMAT_VERSION, { accounts: 3, budgets: 9 }), installed)).toBeUndefined()
  })

  it('cannot, from a newer book format', () => {
    expect(restoreProblem(header(BOOK_FORMAT_VERSION + 1, {}), [])).toContain('newer version of Tessera')
  })

  it('cannot, when an installed plugin is older than the data', () => {
    expect(restoreProblem(header(BOOK_FORMAT_VERSION, { accounts: 4 }), [{ id: 'accounts', version: 3 }]))
      .toBe('It needs a newer version of the “accounts” plugin (data version 4; this one understands 3). Update Tessera to restore it.')
  })
})
