// The archive participants, and the one storage transaction an archive runs them in. The ledger knows nothing about
// what is archived: each participant removes its own data, through a transaction limited to its own collections, and
// the ledger records the archive in `ledger.archives` in the same transaction, so it happens whole or not at all.
// See docs/ledger-compaction-design.md, "The participant contract".
import type { Database, Disposable, Logger } from '@tessera/types'
import {
  LEDGER_COLLECTIONS, LedgerError, displayDate,
  type ArchiveOutcome, type ArchiveParticipant, type ArchivePreviewPart, type ArchiveRecord, type ArchiveResult
} from '@tessera/ledger-api'
import { scopedTransaction } from '../scopedDatabase'

/** One participant's description, for the Archive dialog. */
export type ArchivePart = ArchivePreviewPart

export interface ArchiveRun {
  /** YYYY-MM-DD, checked by the caller. */
  before: string
  options: Readonly<Record<string, boolean>>
  /** The archive file, made before anything is removed. */
  copy: { path: string, takenAt: string }
  /** ISO 8601, UTC. */
  archivedAt: string
  /** Runs first inside the transaction, holding the kit's transaction lock: throw to refuse (the ledger changed). */
  check?(): void
}

/** What a participant threw during an archive: reported as ARCHIVE_FAILED, whatever it was, with its message. */
export class ParticipantFailure extends Error {
  override readonly name = 'ParticipantFailure'
  constructor(readonly contributor: string, override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

/** Lets the event loop turn, so the window stays responsive during a long archive. */
export const turn = () => new Promise<void>(resolve => setImmediate(resolve))

const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0

/** A participant's answer, checked: a count and a summary at least. */
function checked(contributor: string, result: unknown): ArchiveResult {
  const r = result as ArchiveResult | undefined
  if (typeof r !== 'object' || r === null || !isCount(r.count) || typeof r.summary !== 'string') {
    throw new Error(`The archive participant "${contributor}" didn't say what it removed`)
  }
  return r
}

export class ArchiveParticipants {
  private readonly participants = new Map<string, ArchiveParticipant>()

  constructor(private readonly log: Pick<Logger, 'warn' | 'error'>, private readonly yieldTo: () => Promise<void> = turn) {}

  add(contributor: string, participant: ArchiveParticipant): Disposable {
    if (typeof contributor !== 'string' || contributor === '') throw new Error('An archive participant needs a contributor id')
    if (typeof participant?.archive !== 'function' || typeof participant.describe !== 'function') {
      throw new Error(`The archive participant of "${contributor}" needs describe and archive`)
    }
    if (this.participants.has(contributor)) throw new Error(`"${contributor}" already takes part in archives`)
    this.participants.set(contributor, participant)
    return { dispose: () => { if (this.participants.get(contributor) === participant) this.participants.delete(contributor) } }
  }

  /** What each participant would remove, in order. One that fails is logged and left out. */
  async describe(before: string, options: Readonly<Record<string, boolean>>): Promise<ArchivePart[]> {
    const parts: ArchivePart[] = []
    for (const [contributor, participant] of this.participants) {
      try {
        const description = await participant.describe(before, options)
        if (description) parts.push({ contributor, ...checked(contributor, description) })
      } catch (err) {
        this.log.warn(`[ledger] "${contributor}" could not describe an archive before ${before}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return parts
  }

  /**
   * Runs every participant's `archive` in one storage transaction on the raw database, in the order they joined,
   * each with a transaction limited to its own collections, then writes the archive's record. Nothing removed at all
   * is refused (INVALID), and rolls back. `committed` is called on each participant only once the transaction has
   * committed. Whatever a participant throws rolls back every participant's changes, and is thrown on as a
   * `ParticipantFailure`.
   */
  async run(db: Database, run: ArchiveRun): Promise<ArchiveOutcome> {
    const participants = [...this.participants]
    const outcome = await db.transaction(async tx => {
      run.check?.()
      const earlier = new Map<string, unknown>()
      const summaries: string[] = []
      let count = 0
      for (const [contributor, participant] of participants) {
        await this.yieldTo()
        let result: ArchiveResult
        try {
          result = checked(contributor, await participant.archive(scopedTransaction(tx, contributor), { before: run.before, options: run.options, earlier }))
        } catch (err) {
          throw new ParticipantFailure(contributor, err)
        }
        count += result.count
        if (result.count > 0) summaries.push(result.summary)
        if (result.shared !== undefined) earlier.set(contributor, result.shared)
      }
      if (count === 0) throw new LedgerError('INVALID', `There is nothing to archive before ${displayDate(run.before)}.`, 'before')
      const record: ArchiveOutcome = { before: run.before, archivedAt: run.archivedAt, copy: { ...run.copy }, count, summaries }
      await tx.collection<Omit<ArchiveRecord, 'id' | 'rev'>>(LEDGER_COLLECTIONS.archives).insert(record)
      return record
    })
    for (const [contributor, participant] of participants) {
      try {
        participant.committed?.()
      } catch (err) {
        this.log.error(`[ledger] "${contributor}" failed after an archive was committed`, err)
      }
    }
    return outcome
  }
}

/** The ledger's archives, newest first. */
export async function archiveRecords(db: Database): Promise<ArchiveRecord[]> {
  // Ids increase as records are made, so they order two archives made in the same millisecond
  return (await db.collection<Omit<ArchiveRecord, 'id' | 'rev'>>(LEDGER_COLLECTIONS.archives).find())
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.id.localeCompare(a.id))
}
