// The archive run: refuse the impossible, plan, write the frozen copy, then prune — one storage transaction that
// either removes everything the plan said or nothing at all. See docs/archive-design.md, "The archive sequence".
//
// The copy comes first and is the safety net: nothing is removed until the archive has been written, reopened and
// verified. A failure during the prune rolls the book back and *keeps* the archive file, because it is a true copy
// and deleting it would only destroy the one thing that is certainly right.
import path from 'node:path'
import type { Database, Logger } from '@tessera/types'
import {
  BOOK_META, BookError,
  type ArchiveContext, type ArchiveOutcome, type ArchivePlan, type ArchiveRequest, type BookInfo
} from '@tessera/book-api'
import type { SessionInside } from '../BookSessionImpl'
import { scopedTransaction } from '../scopedDatabase'
import type { ArchiveParticipants } from './participants'
import { buildArchivePlan } from './ArchivePlan'
import type { ArchiveWriter } from './ArchiveWriter'
import { humanDate, isoDay } from './naming'

export interface ArchiverDeps {
  session: {
    readonly current: BookInfo | undefined
    exclusive<T>(work: (inside: SessionInside) => Promise<T>): Promise<T>
    unscopedDatabase(): Database
    announcePruned(through: string): void
  }
  participants: Pick<ArchiveParticipants, 'ordered'>
  writer: Pick<ArchiveWriter, 'write'>
  /** Where archives go when a run does not override the folder. */
  folder: () => string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => Date
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

export class Archiver {
  constructor(private readonly deps: ArchiverDeps) {}

  private get now() { return this.deps.now ?? (() => new Date()) }

  /** The open book, checked to be one archiving can work on at all. */
  private openWritable(): BookInfo {
    const book = this.deps.session.current
    if (!book) throw new BookError('NO_BOOK', 'Open a book to archive it.')
    if (book.readOnly) throw new BookError('READ_ONLY', `“${book.name}” can’t be archived, because it can’t be changed.`)
    return book
  }

  /** The cut-off, checked against today and against the book's last archive. */
  private async checkDate(before: string): Promise<void> {
    const today = isoDay(this.now())
    if (before > today) throw new BookError('ARCHIVE_DATE', `${humanDate(before)} is in the future. Archive up to today at most.`)
    const last = await this.deps.session.unscopedDatabase().meta.get(BOOK_META.lastArchivedThrough)
    if (typeof last === 'string' && before <= last) {
      throw new BookError('ARCHIVE_DATE',
        `“${this.openWritable().name}” has already been archived through ${humanDate(last)}. Choose a later date.`)
    }
  }

  /**
   * What archiving would do, for the dialog and the command's confirmation: the checks, then every participant's
   * survey. Writes nothing. A plan with a `blocker` is returned, not thrown, so the caller can show it in place.
   */
  async plan(request: ArchiveRequest): Promise<ArchivePlan> {
    this.openWritable()
    await this.checkDate(request.before)
    return buildArchivePlan(this.deps.participants.ordered(), request, this.deps.log)
  }

  /**
   * The archive run. The caller has confirmed: this refuses, writes the copy, prunes, records the cut-off and
   * announces the prune. On any failure after the copy was written, the copy is kept and the book is untouched.
   */
  async archive(request: ArchiveRequest, where: { folder?: string } = {}): Promise<ArchiveOutcome> {
    return this.deps.session.exclusive(async () => {
      const book = this.openWritable()
      // Planned again inside the file-operation queue: what runs is decided here, not when the dialog asked
      await this.checkDate(request.before)
      const participants = this.deps.participants.ordered()
      const plan = await buildArchivePlan(participants, request, this.deps.log)
      if (plan.blocker !== undefined) throw new BookError('ARCHIVE_BLOCKED', plan.blocker)
      if (plan.documents === 0) {
        throw new BookError('ARCHIVE_NOTHING_TO_DO', `There is nothing to archive before ${humanDate(request.before)}.`)
      }

      const db = this.deps.session.unscopedDatabase()
      // A folder the user browsed to is never created; only the default one is
      const written = await this.deps.writer.write(db, book, {
        before: request.before, folder: where.folder ?? this.deps.folder(), createFolder: where.folder === undefined
      })
      const kept = ` The archive was saved as “${path.basename(written.file)}”.`

      // ---- The point of no return is *inside* the transaction: it commits whole or rolls back whole
      const context: ArchiveContext = { request: { ...request }, removedIds: new Set(plan.removedIds) }
      let removed = 0
      try {
        await db.transaction(async tx => {
          for (const { contributor, participant } of participants) {
            const result = await participant.prune(scopedTransaction(tx, contributor), context)
            removed += result.documents
            const planned = plan.parts.find(part => part.contributor === contributor)?.documents ?? 0
            if (result.documents !== planned) {
              // The book changed between the survey the user agreed to and now: nothing it planned still holds
              throw new BookError('ARCHIVE_CHANGED',
                `“${book.name}” changed while it was being archived, so nothing was removed. Try again.${kept}`)
            }
          }
        })
      } catch (err) {
        this.deps.log.warn(`[book] Archiving “${book.name}” through ${request.before} was rolled back: ${describe(err)}`)
        if (err instanceof Error && isArchiveError(err)) throw err
        throw new BookError('INVALID', `Archiving was stopped and nothing was removed from “${book.name}”: ${describe(err)}${kept}`)
      }

      // Bookkeeping, after the commit: losing it costs only the next dialog's suggestion
      try {
        await db.meta.set(BOOK_META.lastArchivedThrough, request.before)
        await db.flush()
      } catch (err) {
        this.deps.log.warn(`[book] Could not record that “${book.name}” was archived through ${request.before}: ${describe(err)}`)
      }

      this.deps.session.announcePruned(request.before)
      this.deps.log.info(`[book] Archived “${book.name}” through ${request.before}: ${removed} documents removed, copy at ${written.file}`)
      return { file: written.file, before: request.before, documents: removed }
    })
  }
}

/** An error already written for the user, passed on as it is rather than wrapped. */
const isArchiveError = (err: Error) =>
  'code' in err && typeof (err as { code: unknown }).code === 'string' &&
  ['ARCHIVE_BLOCKED', 'ARCHIVE_CHANGED', 'ARCHIVE_BALANCE_MISMATCH'].includes((err as { code: string }).code)
