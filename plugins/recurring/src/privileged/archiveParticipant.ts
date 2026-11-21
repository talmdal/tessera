// The recurring plugin's part in archiving. See docs/archive-design.md, "Participants" and "The archived period
// is closed".
//
// Two jobs. Old postings go — they are history about transactions that are themselves going — except each series'
// most recent one and the posting of the transaction the series was made from. And every series still due before
// the cut-off is rolled forward past it, recording what it passed over as skipped postings: without that, the Due
// list would fill with occurrences whose period was just archived, and Enter would write transactions into it.
import type { Doc, Transaction as StorageTransaction } from '@tessera/types'
import type {
  ArchiveContext, ArchiveParticipant, ArchiveRequest, ArchiveResult, ArchiveSurvey, ArchiveWarning
} from '@tessera/book-api'
import { SOURCE_POSTING_INDEX, occurrenceAt, type BusinessCalendar, type Occurrence } from '@tessera/recurring-api'
import { collectionsOf, type Collections, type StoredPosting, type StoredSeries } from './store'

/** Occurrences a roll-forward will walk per series before giving up: a daily series missed for 27 years. */
const MAX_ROLL = 10000

interface SeriesRoll {
  series: Doc<StoredSeries>
  /** The occurrences passed over, in order; at least one. */
  skipped: Occurrence[]
  /** Where the series lands: the first occurrence on or after the cut-off, or none when the schedule ends first. */
  next?: Occurrence
  nextIndex: number
}

interface RecurringArchivePlan {
  /** Postings to remove. */
  postingIds: string[]
  /** Series still due before the cut-off, and what skipping to it looks like. */
  rolls: SeriesRoll[]
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** `2026-01-01` → `1 Jan 2026` (locale-dependent), read as a local date so it is never a day out. */
const humanDate = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** Everything archiving would do to the recurring data, for a cut-off. Reads only. */
export async function planRecurringArchive(c: Collections, request: ArchiveRequest): Promise<RecurringArchivePlan> {
  const series = await c.series.find({})
  const postings = await c.postings.find({})
  const calendar: BusinessCalendar = { holidays: new Set((await c.holidays.find({})).map(h => h.date)) }

  // Old postings go, except each series' most recent occurrence and its source posting
  const newestBySeries = new Map<string, Doc<StoredPosting>>()
  for (const posting of postings) {
    if (posting.index === SOURCE_POSTING_INDEX) continue
    const newest = newestBySeries.get(posting.seriesId)
    if (!newest || posting.index > newest.index) newestBySeries.set(posting.seriesId, posting)
  }
  const postingIds = postings
    .filter(posting => posting.dueDate < request.before)
    .filter(posting => posting.index !== SOURCE_POSTING_INDEX)
    .filter(posting => newestBySeries.get(posting.seriesId)?.id !== posting.id)
    .map(posting => posting.id)

  // Series still due before the cut-off are rolled past it, however they are paused: resuming one must not
  // quietly re-create the period that was just archived
  const rolls: SeriesRoll[] = []
  for (const one of series) {
    if (one.endedOn !== undefined || one.nextDate === null || one.nextDate >= request.before) continue
    const skipped: Occurrence[] = []
    let index = one.nextIndex
    let next: Occurrence | undefined
    for (let steps = 0; steps < MAX_ROLL; steps++) {
      const occurrence = occurrenceAt(one.schedule, index, calendar)
      if (occurrence === undefined || occurrence.date >= request.before) { next = occurrence; break }
      skipped.push(occurrence)
      index++
    }
    if (skipped.length > 0) rolls.push({ series: one, skipped, nextIndex: index, ...(next && { next }) })
  }

  return { postingIds, rolls }
}

export function recurringArchiveParticipant(deps: {
  collections: () => Collections
  /** The moment skipped postings are stamped with, ISO 8601. */
  now: () => string
  /** Today, `YYYY-MM-DD`, for a series whose schedule ends inside the archived period. */
  today: () => string
}): ArchiveParticipant {
  return {
    async survey(request: ArchiveRequest): Promise<ArchiveSurvey> {
      const plan = await planRecurringArchive(deps.collections(), request)
      const warnings: ArchiveWarning[] = plan.rolls.map(({ series, skipped }) => ({
        kind: 'other' as const,
        message: `${series.name}: ${count(skipped.length, 'occurrence')} before ${humanDate(request.before)} ` +
          `${skipped.length === 1 ? 'was' : 'were'} never entered. ${skipped.length === 1 ? 'It' : 'They'} will be marked skipped.`
      }))
      return {
        describe: count(plan.postingIds.length, 'recurring posting'),
        documents: plan.postingIds.length,
        warnings
      }
    },

    async prune(tx: StorageTransaction, context: ArchiveContext): Promise<ArchiveResult> {
      const c = collectionsOf(tx)
      const plan = await planRecurringArchive(c, context.request)

      if (plan.postingIds.length > 0) await c.postings.deleteMany({ id: { $in: plan.postingIds } })

      // A kept posting whose transaction is going points at nothing: say so, rather than leaving a stale id
      const kept = await c.postings.find({})
      for (const posting of kept) {
        if (posting.transactionId !== undefined && context.removedIds.has(posting.transactionId)) {
          await c.postings.updateOne({ id: posting.id }, { $unset: { transactionId: true } })
        }
      }

      const now = deps.now()
      for (const { series, skipped, next, nextIndex } of plan.rolls) {
        for (const occurrence of skipped) {
          await c.postings.insert({
            seriesId: series.id, accountId: series.accountId, index: occurrence.index, dueDate: occurrence.date,
            outcome: 'skipped', at: now
          })
        }
        const { id: _id, rev: _rev, endedOn: _ended, ...rest } = series
        await c.series.replace({
          id: series.id,
          ...rest,
          nextIndex,
          nextDate: next?.date ?? null,
          skippedCount: series.skippedCount + skipped.length,
          ...(next === undefined && { endedOn: deps.today() }),
          updatedAt: now
        })
      }

      return { documents: plan.postingIds.length }
    }
  }
}
