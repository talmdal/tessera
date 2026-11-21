// @vitest-environment node
// The recurring plugin's part in archiving: old postings go (keeping each series' most recent and its source),
// dangling transaction links are cleared, and a series still due before the cut-off rolls past it as skipped.
// See docs/archive-design.md, "Participants" and "The archived period is closed".
import { describe, expect, it } from 'vitest'
import type { Transaction as StorageTransaction } from '@tessera/types'
import type { ArchiveContext, ArchiveRequest } from '@tessera/book-api'
import { SOURCE_POSTING_INDEX } from '@tessera/recurring-api'
import { scopedTransaction } from '../../../plugins/book/src/privileged/scopedDatabase'
import { collectionsOf } from '../../../plugins/recurring/src/privileged/store'
import { monthly, setupRecurring } from './harness'

const BEFORE = '2026-06-01'
const REQUEST: ArchiveRequest = { before: BEFORE, removeReconciled: true, removeVoided: true }

async function setup() {
  const env = await setupRecurring()          // today is 2026-11-13
  const c = () => collectionsOf(env.session.database('recurring'))
  const participant = env.service.archiveParticipant
  const prune = (context: Partial<ArchiveContext> = {}) =>
    env.session.unscopedDatabase().transaction((tx: StorageTransaction) =>
      participant.prune(scopedTransaction(tx, 'recurring'), { request: REQUEST, removedIds: new Set(), ...context }))
  const survey = (request: Partial<ArchiveRequest> = {}, published = new Set<string>()) =>
    participant.survey({ ...REQUEST, ...request }, published)
  return { ...env, c, participant, prune, survey }
}

/** A monthly series started at `startDate`, with its first `entered` occurrences entered. */
async function entered(env: Awaited<ReturnType<typeof setup>>, startDate: string, count: number, over: Parameters<typeof env.create>[0] = {}) {
  const series = await env.create({ schedule: monthly(startDate), ...over })
  for (let n = 0; n < count; n++) await env.service.enter([{ seriesId: series.id }])
  return (await env.service.get(series.id))!
}

describe('old postings', () => {
  it('removes postings before the cut-off, keeping each series’ most recent and its source', async () => {
    const env = await setup()
    // Entered Jan..May (5 postings before the cut-off); the newest of them stays as the series' last word
    const series = await entered(env, '2026-01-15', 5)

    const result = await env.prune()

    expect(result.documents).toBe(4)
    const left = await env.c().postings.find({ seriesId: series.id })
    expect(left.map(p => p.dueDate)).toEqual(['2026-05-15'])
  })

  it('keeps the posting of the transaction a series was made from', async () => {
    const env = await setup()
    const series = await entered(env, '2026-05-20', 1)
    await env.c().postings.insert({
      seriesId: series.id, accountId: series.accountId, index: SOURCE_POSTING_INDEX,
      dueDate: '2025-12-01', outcome: 'entered', at: '2025-12-01T09:00:00.000Z'
    })

    await env.prune()

    const left = await env.c().postings.find({ seriesId: series.id })
    expect(left.map(p => p.index).sort()).toEqual([0, SOURCE_POSTING_INDEX].sort())
  })

  it('keeps everything on or after the cut-off', async () => {
    const env = await setup()
    await entered(env, '2026-06-15', 3)
    const result = await env.prune()
    expect(result.documents).toBe(0)
  })

  it('clears the transaction link of a kept posting whose transaction is being archived', async () => {
    const env = await setup()
    const series = await entered(env, '2026-01-15', 4)
    const kept = (await env.c().postings.find({ seriesId: series.id, dueDate: '2026-04-15' }))[0]
    expect(kept.transactionId).toBeDefined()

    await env.prune({ removedIds: new Set([kept.transactionId!]) })

    const after = (await env.c().postings.find({ seriesId: series.id }))[0]
    expect(after.transactionId).toBeUndefined()
    expect(after.dueDate).toBe('2026-04-15')      // the record itself survives
  })
})

describe('rolling a series past the cut-off', () => {
  it('marks every missed occurrence skipped and lands on the first one after the cut-off', async () => {
    const env = await setup()
    const series = await env.create({ schedule: monthly('2026-02-10') })    // never entered: due 10 Feb

    const result = await env.prune()

    expect(result.documents).toBe(0)                     // skipping is not a removal
    const after = (await env.service.get(series.id))!
    expect(after.nextDate).toBe('2026-06-10')
    expect(after.skippedCount).toBe(4)                   // Feb, Mar, Apr, May
    const skipped = await env.c().postings.find({ seriesId: series.id, outcome: 'skipped' })
    expect(skipped.map(p => p.dueDate).sort()).toEqual(['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10'])
  })

  it('rolls a paused series too, so resuming it can’t re-enter the archived period', async () => {
    const env = await setup()
    const series = await env.create({ schedule: monthly('2026-03-01') })
    await env.service.setPaused([series.id], true)

    await env.prune()

    const after = (await env.service.get(series.id))!
    expect(after.paused).toBe(true)
    expect(after.nextDate).toBe('2026-06-01')
  })

  it('ends a series whose schedule finishes inside the archived period', async () => {
    const env = await setup()
    const series = await env.create({ schedule: { ...monthly('2026-01-05'), end: { kind: 'afterCount', count: 3 } } })

    await env.prune()

    const after = (await env.service.get(series.id))!
    expect(after.nextDate).toBeNull()
    expect(after.endedOn).toBe(env.today)
    expect(after.skippedCount).toBe(3)
  })

  it('leaves a series already past the cut-off alone', async () => {
    const env = await setup()
    const series = await env.create({ schedule: monthly('2026-07-15') })
    const before = (await env.service.get(series.id))!

    await env.prune()

    expect(await env.service.get(series.id)).toEqual(before)
  })
})

describe('the survey', () => {
  it('counts the postings and warns about every series it will roll', async () => {
    const env = await setup()
    await entered(env, '2026-01-15', 5, { name: 'Hydro bill' })
    await env.create({ name: 'Rent', schedule: monthly('2026-02-01') })

    const survey = await env.survey()

    expect(survey.describe).toBe('4 recurring postings')
    expect(survey.documents).toBe(4)
    expect(survey.warnings).toEqual([{
      kind: 'other',
      message: expect.stringMatching(/^Rent: 4 occurrences before .* were never entered\. They will be marked skipped\.$/)
    }])
  })

  it('answers the same with and without published ids, so the two passes agree', async () => {
    const env = await setup()
    await entered(env, '2026-01-15', 5)
    const empty = await env.survey({}, new Set())
    const full = await env.survey({}, new Set(['t1', 't2']))
    expect(full).toEqual(empty)
  })

  it('writes nothing', async () => {
    const env = await setup()
    await entered(env, '2026-01-15', 5)
    const before = await env.session.unscopedDatabase().snapshot()
    await env.survey()
    expect(await env.session.unscopedDatabase().snapshot()).toEqual(before)
  })
})
