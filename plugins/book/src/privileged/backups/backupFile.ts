// The `.tessera-backup` file: a whole book as gzip-compressed JSON lines. See docs/backup-restore-design.md,
// "The backup file".
//
// Two layers. The line layer (`backupLines`, `readBackupLines`) is the uncompressed bytes, so tests can damage a
// line precisely; the file layer (`writeBackup`, `readBackup`, `verifyBackup`, `readBackupHeader`) adds gzip.
// Nothing here touches the disk or the clock: the caller passes streams and the time.
import { createHash } from 'node:crypto'
import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { CollectionSnapshot, DatabaseSnapshot, Doc, Json } from '@tessera/types'
import { BOOK_FORMAT_VERSION, BOOK_META, BookError, type BackupTrigger } from '@tessera/book-api'

export const BACKUP_FILE_KIND = 'tessera-backup'
/** The backup file format, independent of the book's format and its contributors' data versions. */
export const BACKUP_FILE_VERSION = 1

/** The first line: everything needed to list a backup and decide whether it can be restored, without reading on. */
export interface BackupHeader {
  kind: typeof BACKUP_FILE_KIND
  version: number
  /** The book as it was when backed up. `path` only suggests where a restored copy might go. */
  book: { id: string, name: string, path: string }
  /** ISO timestamp. */
  takenAt: string
  trigger: BackupTrigger
  /** What wrote it, e.g. `book 0.1.0`. */
  app: string
  /** The storage engine the book was open in. A backup restores into any engine. */
  engine: string
  /** The book's `BOOK_META.format`. */
  bookFormat: number
  /** Each `book.schema` contributor's data version in the book, from its meta. */
  schemaVersions: Record<string, number>
  counts: { collections: number, documents: number, meta: number }
}

/** What the header says about where a snapshot came from; the rest is read from the snapshot itself. */
export interface BackupSource {
  book: { id: string, name: string, path: string }
  takenAt: Date
  trigger: BackupTrigger
  app: string
  engine: string
}

/** What writing produced: the digest of every line before the trailer, kept as proof without reading back. */
export interface BackupWritten {
  sha256: string
  documents: number
}

/** A line after the header. `t` keeps each line short: a book has tens of thousands of `doc` lines. */
type BackupRecord =
  | { t: 'meta', key: string, value: Json }
  | { t: 'collection', name: string, indexes: CollectionSnapshot['indexes'] }
  | { t: 'doc', c: string, doc: Doc }
  | { t: 'end', documents: number, sha256: string }

/** Longest line read: far beyond any real document, short enough that a file without newlines can't exhaust memory. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024
/** Longest header read when only the header is wanted: listing a folder must stay cheap. */
export const MAX_HEADER_BYTES = 1024 * 1024
/** Lines are gathered into chunks of about this size for gzip, rather than handed over one by one. */
const CHUNK_BYTES = 64 * 1024

const TRIGGERS: readonly BackupTrigger[] = ['auto', 'manual', 'pre-restore']
const SCHEMA_PREFIX = BOOK_META.schemaVersion('')

// ---- Messages: what the user reads when a backup can't be used

const notABackup = () => new BookError('UNSUPPORTED_FILE', 'This is not a Tessera backup.')
const newerBackup = () => new BookError('UNSUPPORTED_FILE', 'This backup was made by a newer version of Tessera. Update Tessera to restore it.')
const damaged = (why: string) => new BookError('DAMAGED', `This backup is damaged and can't be used: ${why}.`)

// ---- The header

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** The header for a snapshot of a book. The book's format and data versions come from the snapshot's own meta. */
export function backupHeader(source: BackupSource, snapshot: DatabaseSnapshot): BackupHeader {
  const bookFormat = snapshot.meta[BOOK_META.format]
  if (typeof bookFormat !== 'number') throw new BookError('INVALID', 'Only a book can be backed up: this database has no book format.')

  const schemaVersions: Record<string, number> = {}
  for (const [key, value] of Object.entries(snapshot.meta)) {
    if (key.startsWith(SCHEMA_PREFIX) && typeof value === 'number') schemaVersions[key.slice(SCHEMA_PREFIX.length)] = value
  }
  return {
    kind: BACKUP_FILE_KIND,
    version: BACKUP_FILE_VERSION,
    book: { ...source.book },
    takenAt: source.takenAt.toISOString(),
    trigger: source.trigger,
    app: source.app,
    engine: source.engine,
    bookFormat,
    schemaVersions,
    counts: {
      collections: snapshot.collections.length,
      documents: snapshot.collections.reduce((sum, c) => sum + c.docs.length, 0),
      meta: Object.keys(snapshot.meta).length
    }
  }
}

/**
 * Checks a parsed first line. Not ours: UNSUPPORTED_FILE. A newer format: UNSUPPORTED_FILE, before its shape is
 * looked at, since a newer format may have changed it. Ours but malformed: DAMAGED.
 */
function checkHeader(value: unknown): BackupHeader {
  if (!isRecord(value) || value.kind !== BACKUP_FILE_KIND) throw notABackup()
  const { version, book, takenAt, trigger, app, engine, bookFormat, schemaVersions, counts } = value
  if (!isCount(version) || version < 1) throw damaged('its header has no valid format version')
  if (version > BACKUP_FILE_VERSION) throw newerBackup()

  const valid =
    isRecord(book) && typeof book.id === 'string' && typeof book.name === 'string' && typeof book.path === 'string' &&
    typeof takenAt === 'string' && !Number.isNaN(Date.parse(takenAt)) &&
    TRIGGERS.includes(trigger as BackupTrigger) &&
    typeof app === 'string' && typeof engine === 'string' &&
    isCount(bookFormat) &&
    isRecord(schemaVersions) && Object.values(schemaVersions).every(isCount) &&
    isRecord(counts) && isCount(counts.collections) && isCount(counts.documents) && isCount(counts.meta)
  if (!valid) throw damaged('its header is incomplete')
  return value as unknown as BackupHeader
}

/**
 * Why this Tessera can't restore a backup, or undefined if it can. The same rule as opening a book: a book format,
 * or any installed contributor's data, newer than this version understands is refused. A contributor in the backup
 * whose plugin isn't installed is fine: its data is restored as it is, and migrated when the plugin returns.
 */
export function restoreProblem(header: BackupHeader, installed: readonly { id: string, version: number }[]): string | undefined {
  if (header.bookFormat > BOOK_FORMAT_VERSION) return 'It was made by a newer version of Tessera. Update Tessera to restore it.'
  for (const { id, version } of installed) {
    const stored = header.schemaVersions[id] ?? 0
    if (stored > version) {
      return `It needs a newer version of the “${id}” plugin (data version ${stored}; this one understands ${version}). Update Tessera to restore it.`
    }
  }
  return undefined
}

// ---- Writing

/**
 * The file's uncompressed lines, each ending in `\n`, ending with the trailer. `written` is filled in once the last
 * line has been produced.
 */
export function* backupLines(header: BackupHeader, snapshot: DatabaseSnapshot, written: Partial<BackupWritten> = {}): Generator<Buffer> {
  const hash = createHash('sha256')
  const line = (value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    hash.update(bytes)
    return bytes
  }

  yield line(header)
  for (const [key, value] of Object.entries(snapshot.meta)) yield line({ t: 'meta', key, value } satisfies BackupRecord)
  let documents = 0
  for (const { name, indexes, docs } of snapshot.collections) {
    yield line({ t: 'collection', name, indexes } satisfies BackupRecord)
    for (const doc of docs) {
      documents++
      yield line({ t: 'doc', c: name, doc } satisfies BackupRecord)
    }
  }
  const sha256 = hash.digest('hex')
  written.sha256 = sha256
  written.documents = documents
  yield Buffer.from(`${JSON.stringify({ t: 'end', documents, sha256 } satisfies BackupRecord)}\n`, 'utf8')
}

/** Gathers small buffers into chunks of about `size` bytes. */
function* chunked(buffers: Iterable<Buffer>, size: number): Generator<Buffer> {
  let pending: Buffer[] = []
  let length = 0
  for (const buffer of buffers) {
    pending.push(buffer)
    length += buffer.length
    if (length >= size) {
      yield Buffer.concat(pending, length)
      pending = []
      length = 0
    }
  }
  if (length > 0) yield Buffer.concat(pending, length)
}

/**
 * Writes a backup of `snapshot` to `out`, compressed, and ends `out`. Aborting `signal` stops it part-way with an
 * AbortError and destroys `out`, which is how a backup still running when the shutdown budget runs out is abandoned.
 */
export async function writeBackup(
  out: Writable, header: BackupHeader, snapshot: DatabaseSnapshot, options: { signal?: AbortSignal } = {}
): Promise<BackupWritten> {
  const written: Partial<BackupWritten> = {}
  const chunks = Readable.from(chunked(backupLines(header, snapshot, written), CHUNK_BYTES))
  await (options.signal ? pipeline(chunks, createGzip(), out, { signal: options.signal }) : pipeline(chunks, createGzip(), out))
  return written as BackupWritten
}

// ---- Reading

/** Splits bytes into lines, each with its `\n`. A last piece without one is yielded too, so a cut-off file shows. */
async function* splitLines(chunks: AsyncIterable<Buffer | string>, maxLine: number, tooLong: () => Error): AsyncGenerator<Buffer> {
  let pending: Buffer[] = []
  let length = 0
  for await (const raw of chunks) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
    let start = 0
    for (let newline = chunk.indexOf(0x0a, start); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline + 1)
      if (length + piece.length > maxLine) throw tooLong()
      yield length === 0 ? piece : Buffer.concat([...pending, piece], length + piece.length)
      pending = []
      length = 0
      start = newline + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      length += rest.length
      if (length > maxLine) throw tooLong()
      pending.push(rest)
    }
  }
  if (length > 0) yield Buffer.concat(pending, length)
}

function parseLine(line: Buffer, onBadJson: () => Error): unknown {
  try {
    return JSON.parse(line.toString('utf8'))
  } catch {
    throw onBadJson()
  }
}

const endsLine = (line: Buffer) => line.length > 0 && line[line.length - 1] === 0x0a

/**
 * Reads and checks a backup's uncompressed lines: header first, meta, then each collection followed by its
 * documents, then the trailer, whose count and digest must match everything before it. With `keep: false` nothing
 * is collected (verifying a file needs no memory for its documents).
 */
export async function readBackupLines(
  chunks: AsyncIterable<Buffer | string>, options: { keep?: boolean } = {}
): Promise<{ header: BackupHeader, snapshot: DatabaseSnapshot }> {
  const keep = options.keep ?? true
  const hash = createHash('sha256')
  const snapshot: DatabaseSnapshot = { collections: [], meta: {} }
  const collections = new Set<string>()
  const metaKeys = new Set<string>()
  let current: CollectionSnapshot | undefined
  let header: BackupHeader | undefined
  let documents = 0
  let ended = false

  for await (const line of splitLines(chunks, MAX_LINE_BYTES, () => header ? damaged('a line is far too long') : notABackup())) {
    if (header === undefined) {
      header = checkHeader(parseLine(line, notABackup))
      if (!endsLine(line)) throw damaged('it ends in its first line')
      hash.update(line)
      continue
    }
    if (ended) throw damaged('there is more after its last line')
    if (!endsLine(line)) throw damaged('it ends part-way through a line')

    const record = parseLine(line, () => damaged('a line is not readable'))
    if (!isRecord(record)) throw damaged('a line is not a record')

    switch (record.t) {
      case 'meta': {
        if (typeof record.key !== 'string' || !('value' in record)) throw damaged('a meta line is incomplete')
        if (current) throw damaged('a meta line comes after the collections')
        if (metaKeys.has(record.key)) throw damaged(`meta “${record.key}” appears twice`)
        metaKeys.add(record.key)
        if (keep) snapshot.meta[record.key] = record.value as Json
        break
      }
      case 'collection': {
        if (typeof record.name !== 'string' || !Array.isArray(record.indexes)) throw damaged('a collection line is incomplete')
        if (collections.has(record.name)) throw damaged(`collection “${record.name}” appears twice`)
        collections.add(record.name)
        current = { name: record.name, indexes: record.indexes as CollectionSnapshot['indexes'], docs: [] }
        if (keep) snapshot.collections.push(current)
        break
      }
      case 'doc': {
        if (!isRecord(record.doc) || typeof record.c !== 'string') throw damaged('a document line is incomplete')
        if (!current || record.c !== current.name) throw damaged('a document is outside its collection')
        documents++
        if (keep) current.docs.push(record.doc as Doc)
        break
      }
      case 'end': {
        if (!isCount(record.documents) || typeof record.sha256 !== 'string') throw damaged('its last line is incomplete')
        if (record.documents !== documents) throw damaged(`it holds ${documents} documents, not the ${record.documents} it should`)
        if (record.sha256 !== hash.digest('hex')) throw damaged('it has been changed since it was written')
        ended = true
        continue      // the trailer is not part of what its digest covers
      }
      default:
        throw damaged('a line is of an unknown kind')
    }
    hash.update(line)
  }

  if (header === undefined) throw notABackup()
  if (!ended) throw damaged('it is incomplete, ending before its last line')
  const { counts } = header
  if (counts.collections !== collections.size || counts.documents !== documents || counts.meta !== metaKeys.size) {
    throw damaged('its contents do not match its header')
  }
  return { header, snapshot }
}

/** What every gzip stream starts with. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

/**
 * Decompresses a backup's bytes. A decompression error in a file that starts as gzip is damage (cut off, or a byte
 * changed); in one that doesn't, the file was never a backup. Which it is can't be told from whether any output came
 * out first: a small file decompresses in one piece, after the error.
 */
async function* gunzipped(source: Readable): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0)
  const gunzip = createGunzip()
  source.on('error', err => gunzip.destroy(err))
  source.on('data', (chunk: Buffer) => { if (head.length < GZIP_MAGIC.length) head = Buffer.concat([head, chunk]) })
  source.pipe(gunzip)
  try {
    for await (const chunk of gunzip) yield chunk as Buffer
  } catch (err) {
    if ((err as { code?: string }).code?.startsWith('Z_')) {
      throw head.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC) ? damaged('it is cut off or corrupted') : notABackup()
    }
    throw err
  } finally {
    gunzip.destroy()
    source.destroy()
  }
}

/** Reads a whole backup file, checking all of it, and returns what is in it. */
export function readBackup(source: Readable): Promise<{ header: BackupHeader, snapshot: DatabaseSnapshot }> {
  return readBackupLines(gunzipped(source))
}

/** Reads a whole backup file, checking all of it, without keeping its contents. */
export async function verifyBackup(source: Readable): Promise<BackupHeader> {
  return (await readBackupLines(gunzipped(source), { keep: false })).header
}

/**
 * Reads only as far as the end of the header line, so a folder of backups can be listed cheaply. Checks the header
 * alone: whether the rest is intact is `verifyBackup`'s question.
 */
export async function readBackupHeader(source: Readable): Promise<BackupHeader> {
  const lines = splitLines(gunzipped(source), MAX_HEADER_BYTES, notABackup)
  try {
    const first = await lines.next()
    if (first.done) throw notABackup()
    const header = checkHeader(parseLine(first.value, notABackup))
    if (!endsLine(first.value)) throw damaged('it ends in its first line')
    return header
  } finally {
    await lines.return(undefined)      // stops decompressing and closes the source
  }
}
