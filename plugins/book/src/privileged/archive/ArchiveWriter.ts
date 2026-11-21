// Writing an archive: a complete copy of the open book as an ordinary book file, frozen read-only.
// See docs/archive-design.md, "The archive file".
//
// Nothing is removed from the working book here — that is the pruner's job, and it only ever runs after this has
// finished. The copy is taken from memory (`snapshot`), written into a staging file beside where it will go, given
// its own id and its archive meta, renamed into place, and then reopened and checked against the snapshot it came
// from. An archive that cannot be read back is deleted and the write fails, because its whole purpose is to be the
// thing the user still has when the prune goes wrong.
import path from 'node:path'
import type { Database, DatabaseSnapshot, Logger, StorageEngine } from '@tessera/types'
import {
  BOOK_API_VERSION, BOOK_META, BookError, isArchiveMarker, type ArchiveMarker, type BookInfo
} from '@tessera/book-api'
import { bookName } from '../BookSessionImpl'
import type { BookDisk } from '../disk'
import type { BackupDisk } from '../backups/BackupDisk'
import { MAX_NAME_ATTEMPTS } from '../backups/BackupDisk'
import { archiveFileName, archiveStagingName, isIsoDate } from './naming'

export interface ArchiveWriterDeps {
  engine: Pick<StorageEngine, 'open' | 'newId'>
  bookDisk: Pick<BookDisk, 'exists' | 'renameWithSideFiles' | 'removeWithSideFiles'>
  /** Only for the archive folder itself: whether it is there, and making the default one. */
  folders: Pick<BackupDisk, 'folderExists' | 'makeFolder'>
  /**
   * Checks the finished file is a book this Tessera can open, exactly as File › Open would — the session's own
   * probe, so an archive is never left behind that Tessera would refuse to read.
   */
  probe: (file: string) => Promise<void>
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => Date
  /** What wrote it, recorded in the marker. */
  app?: string
}

export interface ArchiveWriteOptions {
  /** The cut-off, `YYYY-MM-DD`: what the working book is about to have removed. Recorded, never applied here. */
  before: string
  /** Where the archive goes. The file is named from the book and the cut-off. */
  folder: string
  /** Make `folder` (and its parents) when it is missing. For the default folder only, never one the user chose. */
  createFolder?: boolean
}

export interface ArchiveWriteOutcome {
  /** Where it was written. */
  file: string
  marker: ArchiveMarker
  /** What is in it, as verified by reading it back. */
  documents: number
  collections: number
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

const countDocuments = (snapshot: DatabaseSnapshot) =>
  snapshot.collections.reduce((total, collection) => total + collection.docs.length, 0)

export class ArchiveWriter {
  constructor(private readonly deps: ArchiveWriterDeps) {}

  private get now() { return this.deps.now ?? (() => new Date()) }

  /**
   * Writes a complete, frozen copy of `db` (the open book, unscoped) and resolves where it went. Rejects having
   * written nothing outside the archive folder's staging file, which it removes; the working book is never touched.
   */
  async write(db: Database, book: BookInfo, options: ArchiveWriteOptions): Promise<ArchiveWriteOutcome> {
    const { before, folder } = options
    if (!isIsoDate(before)) throw new BookError('INVALID', `“${String(before)}” is not a date. Use YYYY-MM-DD.`)

    if (!(await this.deps.folders.folderExists(folder))) {
      // A folder the user chose is never created: a drive that is not plugged in must fail, not be invented
      if (!options.createFolder) throw new BookError('INVALID', `The archive folder ${folder} isn’t there.`)
      await this.deps.folders.makeFolder(folder)
    }

    const snapshot = await db.snapshot()
    const documents = countDocuments(snapshot)
    const marker: ArchiveMarker = {
      of: book.id,
      ofName: book.name,
      takenAt: this.now().toISOString(),
      through: before,
      app: this.deps.app ?? `book ${BOOK_API_VERSION}`
    }

    // Staged beside where it goes, so putting it in place is a rename on one drive
    const staging = path.join(folder, archiveStagingName(book.name, this.deps.engine.newId()))
    try {
      // No `schema`: `load` fills an empty database, and a schema would create collections before it could
      const copy = await this.deps.engine.open({ path: staging })
      try {
        await copy.load(snapshot)
        // Its own identity: an archive is a different book from the one it was cut from, and must never be
        // mistaken for it — by the backup ledger, the recent list, or a restore
        await copy.meta.set(BOOK_META.id, this.deps.engine.newId())
        await copy.meta.set(BOOK_META.readOnly, true)
        await copy.meta.set(BOOK_META.archive, marker)
        await copy.flush()
      } finally {
        await copy.close()
      }
    } catch (err) {
      await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
      throw new BookError('INVALID', `The archive of “${book.name}” couldn’t be written: ${describe(err)}`)
    }

    // ---- Into place, under the first free name: nothing is ever overwritten
    let file: string
    try {
      file = await this.freeName(folder, book.name, before)
      await this.deps.bookDisk.renameWithSideFiles(staging, file)
    } catch (err) {
      await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
      throw new BookError('INVALID', `The archive of “${book.name}” couldn’t be put in place: ${describe(err)}`)
    }

    // ---- Read it back. An archive nobody has read is not a safety net
    try {
      await this.deps.probe(file)
      await this.verify(file, snapshot, marker)
    } catch (err) {
      await this.deps.bookDisk.removeWithSideFiles(file).catch(() => {})
      throw new BookError('INVALID',
        `The archive of “${book.name}” couldn’t be verified after writing, so it was deleted and nothing was removed from the book: ${describe(err)}`)
    }

    this.deps.log.info(`[book] Archived “${book.name}” through ${before} to ${file} (${documents} documents)`)
    return { file, marker, documents, collections: snapshot.collections.length }
  }

  /** The first name in `folder` that is free. Writes are serialised in-process, so only another Tessera could race. */
  private async freeName(folder: string, name: string, before: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const candidate = path.join(folder, archiveFileName(name, before, attempt))
      if (!(await this.deps.bookDisk.exists(candidate))) return candidate
    }
    throw new Error(`every name for this archive in ${folder} is taken`)
  }

  /** Reopens the finished file read-only and checks it holds what was put in it, and says it is an archive. */
  private async verify(file: string, original: DatabaseSnapshot, marker: ArchiveMarker): Promise<void> {
    const db = await this.deps.engine.open({ path: file }, { readOnly: true })
    try {
      const stored = await db.meta.get(BOOK_META.archive)
      if (!isArchiveMarker(stored) || stored.through !== marker.through || stored.takenAt !== marker.takenAt) {
        throw new Error('it was written without a usable archive marker')
      }
      if ((await db.meta.get(BOOK_META.readOnly)) !== true) throw new Error('it was written without the read-only flag')
      if (await db.meta.get(BOOK_META.id) === original.meta[BOOK_META.id]) {
        throw new Error('it kept the book’s own id instead of being given its own')
      }

      const written = await db.snapshot()
      if (written.collections.length !== original.collections.length) {
        throw new Error(`it holds ${written.collections.length} collections, not ${original.collections.length}`)
      }
      const expected = countDocuments(original)
      const actual = countDocuments(written)
      if (actual !== expected) throw new Error(`it holds ${actual} documents, not ${expected}`)
      for (const collection of original.collections) {
        const copy = written.collections.find(c => c.name === collection.name)
        if (!copy) throw new Error(`“${collection.name}” is missing from it`)
        if (copy.docs.length !== collection.docs.length) {
          throw new Error(`“${collection.name}” holds ${copy.docs.length} documents, not ${collection.docs.length}`)
        }
      }
    } finally {
      await db.close().catch(err => this.deps.log.warn(`[book] Could not close ${bookName(file)} after verifying it: ${describe(err)}`))
    }
  }
}
