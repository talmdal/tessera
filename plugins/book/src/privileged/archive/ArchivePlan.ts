// What archiving would do, asked of every participant and put together for the user to agree to.
// See docs/archive-design.md, "The archive sequence" (step 2) and "The Archive dialog".
//
// Surveying never writes. The plan the user is shown is the plan that runs: the ids each participant says it will
// remove are carried into the prune, so no participant has to work them out twice or depend on running first.
import type { Logger } from '@tessera/types'
import {
  BookError, type ArchivePlan, type ArchivePlanPart, type ArchivePlanRow, type ArchiveRequest, type ArchiveWarning
} from '@tessera/book-api'
import type { RegisteredParticipant } from './participants'
import { isIsoDate } from './naming'

const describeError = (err: unknown) => err instanceof Error ? err.message : String(err)

/** Checks a survey is shaped the way the contract says, so one bad plugin can't make a nonsense plan. */
function checkSurvey(contributor: string, survey: unknown): asserts survey is Awaited<ReturnType<RegisteredParticipant['participant']['survey']>> {
  const value = survey as Record<string, unknown> | null
  if (typeof value !== 'object' || value === null) throw new Error('it answered with nothing')
  if (typeof value.describe !== 'string') throw new Error('it answered without a description')
  if (!Number.isInteger(value.documents) || (value.documents as number) < 0) throw new Error('it answered with an impossible number of documents')
  if (!Array.isArray(value.warnings)) throw new Error('it answered without warnings')
  if (value.rows !== undefined && !Array.isArray(value.rows)) throw new Error('it answered with unusable rows')
  if (value.removesIds !== undefined && !Array.isArray(value.removesIds)) throw new Error('it answered with unusable ids')
  if (value.blocker !== undefined && typeof value.blocker !== 'string') throw new Error('it answered with an unusable blocker')
}

/**
 * Asks every participant what it would do, in the order they will run. Rejects if one of them fails: a plan that
 * is missing a participant's part would understate what archiving does, and the user would agree to the wrong
 * thing. Nothing is written, so a failure costs only the time it took.
 *
 * Two passes: the first collects every survey's `removesIds` and is thrown away; the second hands the full set to
 * every survey and is the plan. So a participant whose answer depends on another's — exchange removes a batch
 * only when accounts removes every transaction it made — never depends on who was asked first.
 */
export async function buildArchivePlan(
  participants: readonly RegisteredParticipant[],
  request: ArchiveRequest,
  log?: Pick<Logger, 'info' | 'warn'>
): Promise<ArchivePlan> {
  if (!isIsoDate(request.before)) throw new BookError('INVALID', `“${String(request.before)}” is not a date. Use YYYY-MM-DD.`)

  // Pass 1: only what everyone publishes
  const published = new Set<string>()
  for (const { contributor, participant } of participants) {
    try {
      const survey = await participant.survey({ ...request }, new Set())
      checkSurvey(contributor, survey)
      for (const id of survey.removesIds ?? []) published.add(id)
    } catch (err) {
      throw new BookError('INVALID', `“${contributor}” couldn’t work out what archiving would remove, so nothing was archived: ${describeError(err)}`)
    }
  }

  const parts: ArchivePlanPart[] = []
  const rows: ArchivePlanRow[] = []
  const warnings: ArchiveWarning[] = []
  const removedIds: string[] = []
  let documents = 0
  let blocker: string | undefined

  // Pass 2: the plan, with everyone knowing what everyone removes
  for (const { contributor, participant } of participants) {
    let survey
    try {
      survey = await participant.survey({ ...request }, published)
      checkSurvey(contributor, survey)
    } catch (err) {
      throw new BookError('INVALID', `“${contributor}” couldn’t work out what archiving would remove, so nothing was archived: ${describeError(err)}`)
    }

    parts.push({ contributor, describe: survey.describe, documents: survey.documents })
    documents += survey.documents
    for (const warning of survey.warnings) warnings.push(warning)
    for (const row of survey.rows ?? []) rows.push({ ...row, contributor })
    for (const id of survey.removesIds ?? []) removedIds.push(id)
    // The first blocker is the one the user is shown; the rest are logged, so a second reason isn't a surprise
    if (survey.blocker !== undefined) {
      if (blocker === undefined) blocker = survey.blocker
      else log?.info(`[book] Archiving is also blocked by “${contributor}”: ${survey.blocker}`)
    }
  }

  return {
    before: request.before,
    documents,
    parts,
    rows,
    warnings,
    ...(blocker !== undefined && { blocker }),
    removedIds
  }
}
