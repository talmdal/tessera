// @vitest-environment node
// The plan the user is shown: every participant's survey, put together. See docs/archive-design.md, step 2.
import { describe, expect, it, vi } from 'vitest'
import type { ArchiveParticipant, ArchiveSurvey } from '@tessera/book-api'
import { isBookError } from '@tessera/book-api'
import { ArchiveParticipants } from '../../../../plugins/book/src/privileged/archive/participants'
import { buildArchivePlan } from '../../../../plugins/book/src/privileged/archive/ArchivePlan'
import { logger } from '../harness'

const REQUEST = { before: '2026-01-01', removeReconciled: true, removeVoided: true }

const saying = (survey: Partial<ArchiveSurvey>): ArchiveParticipant => ({
  survey: vi.fn(async () => ({ describe: 'nothing', documents: 0, warnings: [], ...survey })),
  prune: vi.fn(async () => ({ documents: 0 }))
})

const registryOf = (entries: [string, ArchiveParticipant, string[]?][]) => {
  const registry = new ArchiveParticipants()
  for (const [contributor, participant, before] of entries) registry.add(contributor, participant, before ? { before } : {})
  return registry.ordered()
}

const failure = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return err as { code: string, message: string }
}

describe('building the plan', () => {
  it('adds up every participant’s part, in the order they will run', async () => {
    const participants = registryOf([
      ['accounts', saying({ describe: '8,412 transactions in 6 accounts', documents: 8412 })],
      ['recurring', saying({ describe: '213 recurring postings', documents: 213 }), ['accounts']]
    ])

    const plan = await buildArchivePlan(participants, REQUEST)

    expect(plan.before).toBe('2026-01-01')
    expect(plan.documents).toBe(8625)
    expect(plan.parts).toEqual([
      { contributor: 'recurring', describe: '213 recurring postings', documents: 213 },
      { contributor: 'accounts', describe: '8,412 transactions in 6 accounts', documents: 8412 }
    ])
  })

  it('collects the warnings and the Details rows, saying which plugin each came from', async () => {
    const participants = registryOf([
      ['accounts', saying({
        warnings: [{ kind: 'unreconciled', message: 'Chequing: 14 transactions are not reconciled.' }],
        rows: [{ id: 'chq', label: 'Chequing', removed: 120, detail: 'Opening balance $1,234.56 as of 1 Jan 2026' }]
      })],
      ['exchange', saying({ warnings: [{ kind: 'openImport', message: 'One import is still open.' }] }), ['accounts']]
    ])

    const plan = await buildArchivePlan(participants, REQUEST)

    expect(plan.warnings.map(w => w.kind)).toEqual(['openImport', 'unreconciled'])
    expect(plan.rows).toEqual([
      { contributor: 'accounts', id: 'chq', label: 'Chequing', removed: 120, detail: 'Opening balance $1,234.56 as of 1 Jan 2026' }
    ])
  })

  it('carries every participant’s ids, so none of them depends on running first', async () => {
    const participants = registryOf([
      ['accounts', saying({ removesIds: ['t1', 't2'] })],
      ['recurring', saying({ removesIds: ['p9'] }), ['accounts']]
    ])

    const plan = await buildArchivePlan(participants, REQUEST)

    expect([...plan.removedIds].sort()).toEqual(['p9', 't1', 't2'])
  })

  it('says there is nothing to archive when no one would remove anything', async () => {
    const plan = await buildArchivePlan(registryOf([['accounts', saying({})]]), REQUEST)
    expect(plan.documents).toBe(0)
    expect(plan.blocker).toBeUndefined()
  })
})

describe('when a participant says no', () => {
  it('reports the first blocker in run order, and logs the rest', async () => {
    const log = logger()
    const participants = registryOf([
      ['accounts', saying({ blocker: 'A reconciliation of “Chequing” is in progress.' })],
      ['recurring', saying({ blocker: 'A series is mid-entry.' }), ['accounts']]
    ])

    const plan = await buildArchivePlan(participants, REQUEST, log)

    expect(plan.blocker).toBe('A series is mid-entry.')        // recurring runs first
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('also blocked by “accounts”'))
  })

  it('still reports what would have been removed, so the dialog can show both', async () => {
    const participants = registryOf([['accounts', saying({ documents: 12, blocker: 'Not now.' })]])
    const plan = await buildArchivePlan(participants, REQUEST)
    expect(plan).toMatchObject({ documents: 12, blocker: 'Not now.' })
  })
})

describe('when a participant can’t be trusted', () => {
  it('refuses a cut-off that is not a date before asking anyone', async () => {
    const participant = saying({})
    const err = await failure(buildArchivePlan(registryOf([['accounts', participant]]), { ...REQUEST, before: 'last year' }))

    expect(err.message).toMatch(/is not a date/)
    expect(participant.survey).not.toHaveBeenCalled()
  })

  it('fails the whole plan when a survey throws, naming the plugin', async () => {
    const participants = registryOf([
      ['accounts', { survey: vi.fn(async () => { throw new Error('the database is gone') }), prune: vi.fn() } as never]
    ])

    const err = await failure(buildArchivePlan(participants, REQUEST))
    expect(err.message).toMatch(/“accounts” couldn’t work out what archiving would remove.*the database is gone/)
  })

  it('fails the plan for a survey that answers nonsense, rather than showing it', async () => {
    const nonsense: Partial<ArchiveSurvey>[] = [
      { documents: -1 }, { documents: 1.5 }, { describe: 7 as never }, { warnings: 'none' as never }, { rows: 3 as never }
    ]
    for (const survey of nonsense) {
      const participants = registryOf([['accounts', saying(survey)]])
      const err = await failure(buildArchivePlan(participants, REQUEST))
      expect(err.message).toMatch(/“accounts” couldn’t work out/)
    }
  })
})
