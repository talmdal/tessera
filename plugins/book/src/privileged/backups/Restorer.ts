// Restoring a backup: over the open book, or as a new book. See docs/backup-restore-design.md, "Restore".
//
// Restore never merges and never writes in place. The whole backup is read and checked, written into a staging
// file beside where it will go, and that file probed as a book, before anything the user has is touched. Only then
// is the open book backed up and moved to the Trash (or the chosen file's old occupant trashed), the staged file
// renamed into place, and the result opened the way File › Open opens any book: migrations run, plugins rebuild.
import path from 'node:path'
import type { Database, DatabaseSnapshot, Logger, StorageEngine } from '@tessera/types'
import {
  BOOK_FILE_EXTENSION, BOOK_FORMAT_VERSION, BOOK_META, BookError, isArchiveMarker,
  type ArchiveMarker, type BackupInfo, type BookInfo, type RestoreTarget
} from '@tessera/book-api'
import { bookName, defaultTrashName } from '../BookSessionImpl'
import type { SessionInside } from '../BookSessionImpl'
import type { BookDisk } from '../disk'
import type { BackupDisk } from './BackupDisk'
import { readBackup, readBackupHeader, restoreProblem, type BackupHeader } from './backupFile'
import type { Backups } from './Backups'

export interface RestorerDeps {
  session: {
    readonly current: BookInfo | undefined
    exclusive<T>(work: (inside: SessionInside) => Promise<T>): Promise<T>
    unscopedDatabase(): Database
  }
  engine: Pick<StorageEngine, 'open' | 'newId'>
  backupDisk: Pick<BackupDisk, 'open' | 'stat' | 'list' | 'folderExists'>
  bookDisk: Pick<BookDisk, 'exists' | 'renameWithSideFiles' | 'removeWithSideFiles'>
  backups: Pick<Backups, 'backUpNow' | 'markChanged'>
  /** The installed `book.schema` contributors: a backup with newer data than one of them understands is refused. */
  contributions: () => readonly { id: string, version: number }[]
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** The name of the OS trash in messages. */
  trashName?: string
}

export interface RestoreOutcome {
  /** The book now open: the restored one. */
  book: BookInfo
  header: BackupHeader
  /** Where the safety copy of the replaced book went; absent for a new book, or when the replaced one was empty. */
  safetyBackup?: string
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

const samePath = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

export class Restorer {
  constructor(private readonly deps: RestorerDeps) {}

  private get trash() { return this.deps.trashName ?? defaultTrashName() }

  // ---- What the Restore dialog lists

  /** One file, from its header only: what it is, and why this Tessera can't restore it, if it can't. */
  async inspect(file: string): Promise<BackupInfo> {
    const sizeBytes = await this.deps.backupDisk.stat(file).then(s => s.size, () => 0)
    try {
      const header = await readBackupHeader(this.deps.backupDisk.open(file))
      const problem = restoreProblem(header, this.deps.contributions())
      return {
        file, sizeBytes,
        header: {
          bookId: header.book.id, bookName: header.book.name, bookPath: header.book.path, takenAt: header.takenAt,
          trigger: header.trigger, app: header.app, engine: header.engine, documents: header.counts.documents
        },
        ...(problem !== undefined && { problem })
      }
    } catch (err) {
      try {
        const db = await this.deps.engine.open({ path: file }, { readOnly: true })
        try {
          const marker = await db.meta.get(BOOK_META.archive)
          const readOnly = await db.meta.get(BOOK_META.readOnly)
          if (readOnly !== true || !isArchiveMarker(marker)) throw new Error('This is not a Tessera archive.')
          const snapshot = await db.snapshot()
          const documents = snapshot.collections.reduce((total, collection) => total + collection.docs.length, 0)
          let problem: string | undefined
          const format = snapshot.meta[BOOK_META.format]
          if (typeof format === 'number' && format > BOOK_FORMAT_VERSION) {
            problem = 'It was made by a newer version of Tessera. Update Tessera to restore it.'
          } else {
            for (const contribution of this.deps.contributions()) {
              const stored = snapshot.meta[BOOK_META.schemaVersion(contribution.id)]
              if (typeof stored === 'number' && stored > contribution.version) {
                problem = `It needs a newer version of the “${contribution.id}” plugin (data version ${stored}; this one understands ${contribution.version}). Update Tessera to restore it.`
                break
              }
            }
          }
          return {
            file, sizeBytes,
            header: {
              bookId: marker.of, bookName: marker.ofName, bookPath: file,
              takenAt: marker.takenAt, trigger: 'archive',
              app: marker.app, engine: this.deps.engine.id ?? 'unknown', documents,
              archiveThrough: marker.through
            },
            ...(problem !== undefined && { problem })
          }
        } finally {
          await db.close()
        }
      } catch (archiveErr) {
        // A malformed backup stays a backup error; an ordinary unreadable .tessera is reported as an archive/file error.
        return { file, sizeBytes, problem: describe(archiveErr) }
      }
    }
  }

  /** Backups and archives, newest first, then anything that couldn't be read. Missing folders hold none. */
  async list(folder: string, archiveFolder?: string): Promise<BackupInfo[]> {
    const found: BackupInfo[] = []
    if (await this.deps.backupDisk.folderExists(folder)) {
      found.push(...await Promise.all((await this.deps.backupDisk.list(folder)).map(({ file }) => this.inspect(file))))
    }
    if (archiveFolder && await this.deps.backupDisk.folderExists(archiveFolder) && this.deps.backupDisk.listArchives) {
      found.push(...await Promise.all((await this.deps.backupDisk.listArchives(archiveFolder)).map(({ file }) => this.inspect(file))))
    }
    const when = (info: BackupInfo) => info.header ? Date.parse(info.header.takenAt) : -Infinity
    return found.sort((a, b) => when(b) - when(a))
  }

  // ---- Restoring

  /**
   * Restores `file` over the open book, or as a new book at `target.path`, and opens the result. Rejects, having
   * changed nothing, for a backup this Tessera can't restore or one that is damaged; past the point of no return, a
   * failure says where the previous book, its safety copy and the restored copy each are.
   */
  async restore(file: string, target: RestoreTarget): Promise<RestoreOutcome> {
    let header: BackupHeader
    let snapshot: DatabaseSnapshot
    let archiveMarker: ArchiveMarker | undefined

    try {
      // 1. A `.tessera-backup`: header first, then the complete digest-checked snapshot
      header = await readBackupHeader(this.deps.backupDisk.open(file))
      const problem = restoreProblem(header, this.deps.contributions())
      if (problem !== undefined) throw new BookError('UNSUPPORTED_FILE', `This backup can’t be restored here. ${problem}`)
      snapshot = (await readBackup(this.deps.backupDisk.open(file))).snapshot
    } catch (err) {
      if (err instanceof BookError && err.code === 'DAMAGED') throw err
      if (file.toLowerCase().endsWith('.tessera-backup')) throw err
      // 1. An ordinary `.tessera` archive: open it read-only, verify its marker and version compatibility
      const db = await this.deps.engine.open({ path: file }, { readOnly: true })
      try {
        const marker = await db.meta.get(BOOK_META.archive)
        if ((await db.meta.get(BOOK_META.readOnly)) !== true || !isArchiveMarker(marker)) {
          throw new Error('This is not a Tessera archive.')
        }
        archiveMarker = marker
        snapshot = await db.snapshot()
        const format = snapshot.meta[BOOK_META.format]
        if (typeof format === 'number' && format > BOOK_FORMAT_VERSION) {
          throw new BookError('UNSUPPORTED_FILE', 'This archive was made by a newer version of Tessera. Update Tessera to restore it.')
        }
        for (const contribution of this.deps.contributions()) {
          const stored = snapshot.meta[BOOK_META.schemaVersion(contribution.id)]
          if (typeof stored === 'number' && stored > contribution.version) {
            throw new BookError('UNSUPPORTED_FILE', `This archive needs a newer version of the “${contribution.id}” plugin (data version ${stored}; this one understands ${contribution.version}). Update Tessera to restore it.`)
          }
        }
        header = {
          kind: 'tessera-backup',
          version: 1,
          book: { id: marker.of, name: marker.ofName, path: file },
          takenAt: marker.takenAt,
          trigger: 'archive',
          app: marker.app,
          engine: this.deps.engine.id,
          bookFormat: typeof format === 'number' ? format : 0,
          schemaVersions: {},
          counts: {
            collections: snapshot.collections.length,
            documents: snapshot.collections.reduce((total, collection) => total + collection.docs.length, 0),
            meta: Object.keys(snapshot.meta).length
          }
        }
      } finally {
        await db.close()
      }
    }

    return this.deps.session.exclusive(async inside => {
      const current = this.deps.session.current
      const destination = this.destination(target, current)

      // 3 and 4. Staged beside where it goes, so putting it in place is a rename on one drive, then probed as a book
      const staging = path.join(path.dirname(destination), `.${bookName(destination)}.restoring-${this.deps.engine.newId()}${BOOK_FILE_EXTENSION}`)
      try {
        const db = await this.deps.engine.open({ path: staging })
        try {
          await db.load(snapshot)
          if (archiveMarker) {
            // Restoring an archive makes it a new, writable book even when Replace is chosen.
            await db.meta.delete(BOOK_META.readOnly)
            await db.meta.delete(BOOK_META.archive)
            await db.meta.set(BOOK_META.id, this.deps.engine.newId())
            await db.meta.set(BOOK_META.restoredFrom, { bookId: archiveMarker.of, takenAt: archiveMarker.takenAt })
          } else if (target.kind === 'new') {
            // A copy is a book of its own: its backups must never prune the original's
            await db.meta.set(BOOK_META.id, this.deps.engine.newId())
            await db.meta.set(BOOK_META.restoredFrom, { bookId: header.book.id, takenAt: header.takenAt })
          }
        } finally {
          await db.close()
        }
        await inside.probe(staging)
      } catch (err) {
        await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
        throw err
      }
      // ---- Up to here nothing outside the staging file has changed

      let safetyBackup: string | undefined
      if (target.kind === 'replace') {
        const replaced = current!
        try {
          safetyBackup = await this.safetyBackup(replaced)
        } catch (err) {
          await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
          throw new BookError('INVALID', `A backup of “${replaced.name}” as it is now couldn’t be made first, so nothing was changed. ${describe(err)}`)
        }
        await inside.close()
        try {
          await inside.trash(destination)
        } catch (err) {
          await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
          await inside.open(destination).catch(() => undefined)
          throw new BookError('INVALID', `“${replaced.name}” couldn’t be moved to the ${this.trash}, so nothing was restored. ${describe(err)}`)
        }
      } else if (await this.deps.bookDisk.exists(destination)) {
        // The save dialog asked before replacing; the old file goes to the trash, where it can be restored from
        try {
          await inside.trash(destination)
        } catch (err) {
          await this.deps.bookDisk.removeWithSideFiles(staging).catch(() => {})
          throw new BookError('INVALID', `“${path.basename(destination)}” couldn’t be moved to the ${this.trash}, so nothing was restored. ${describe(err)}`)
        }
      }

      // 5. Into place. The staged copy stays where it is if this fails: it is the restored book
      const where = this.whereThingsAre(target, current, safetyBackup)
      try {
        await this.deps.bookDisk.renameWithSideFiles(staging, destination)
      } catch (err) {
        throw new BookError('INVALID', `The restored book couldn’t be put in place: ${describe(err)} It was left as “${staging}”.${where}`)
      }

      // 6. Opened as File › Open opens any book: an older backup is migrated, and every plugin rebuilds
      let book: BookInfo | undefined
      try {
        book = await inside.open(destination)
      } catch (err) {
        throw new BookError('INVALID', `The restored book was saved as “${path.basename(destination)}” but couldn’t be opened: ${describe(err)}${where}`)
      }
      if (!book) throw new BookError('INVALID', `The restored book was saved as “${path.basename(destination)}” but wasn’t opened.${where}`)
      // It holds what no backup of this book has, whatever the last one says: its next close backs it up
      this.deps.backups.markChanged(book)
      this.deps.log.info(`[book] Restored ${file} to ${destination}`)
      return { book, header, ...(safetyBackup !== undefined && { safetyBackup }) }
    })
  }

  private destination(target: RestoreTarget, current: BookInfo | undefined): string {
    if (target.kind === 'replace') {
      if (!current) throw new BookError('NO_BOOK', 'No book is open to replace.')
      if (current.readOnly) throw new BookError('READ_ONLY', `“${current.name}” is read-only, so it can’t be replaced.`)
      return current.path
    }
    const destination = path.resolve(target.path)
    if (current && samePath(destination, current.path)) {
      throw new BookError('INVALID', `“${path.basename(destination)}” is the open book’s own file. To restore over it, choose Replace the open book.`)
    }
    return destination
  }

  /** The replaced book as it is now, into the backup folder; skipped for a book with nothing in it. */
  private async safetyBackup(book: BookInfo): Promise<string | undefined> {
    const db = this.deps.session.unscopedDatabase()
    const { collections } = await db.snapshot()
    if (collections.every(c => c.docs.length === 0)) return undefined
    return this.deps.backups.backUpNow(db, book, { trigger: 'pre-restore', record: false })
  }

  /** After the point of no return: where the user's copies are, so a failure never leaves them guessing. */
  private whereThingsAre(target: RestoreTarget, replaced: BookInfo | undefined, safetyBackup: string | undefined): string {
    if (target.kind !== 'replace' || !replaced) return ''
    const safety = safetyBackup ? `, and a backup of it was saved as “${path.basename(safetyBackup)}” in ${path.dirname(safetyBackup)}` : ''
    return ` Your previous “${replaced.name}” is in the ${this.trash}${safety}.`
  }
}
