// @vitest-environment node
// The exchange plugin's part in archiving: an import batch goes once every transaction it made is going — its undo
// window went with them. Links, rules, profiles and pending statements stay. See docs/archive-design.md.
import { describe, expect, it } from 'vitest'
import type { Transaction as StorageTransaction } from '@tessera/types'
import type { ArchiveContext, ArchiveRequest } from '@tessera/book-api'
import { scopedTransaction } from '../../../plugins/book/src/privileged/scopedDatabase'
import { collectionsOf } from '../../../plugins/exchange/src/privileged/store'
import { batchTransactionIds } from '../../../plugins/exchange/src/privileged/archiveParticipant'
import { document, row, setupExchange, statement } from './harness'

const BEFORE = '2026-06-01'
const REQUEST: ArchiveRequest = { before: BEFORE, removeReconciled: true, removeVoided: true }

async function setup() {
  const env = await setupExchange()
  const c = () => collectionsOf(env.session.database('exchange'))
  const participant = env.service.archiveParticipant
  const survey = (published: Set<string>, request: Partial<ArchiveRequest> = {}) =>
    participant.survey({ ...REQUEST, ...request }, published)
  const prune = (removedIds: Set<string>) =>
    env.session.unscopedDatabase().transaction((tx: StorageTransaction) =>
      participant.prune(scopedTransaction(tx, 'exchange'), { request: REQUEST, removedIds } satisfies ArchiveContext))

  /** Imports a small statement and accepts every row, closing its batch; returns the batch and its transactions. */
  const imported = async (dates = ['2026-01-05', '2026-01-12']) => {
    await env.fileOf(document({ statements: [statement({ transactions: dates.map(date => row({ date, payee: `P ${date}` })) })] }))
    await env.acceptAll()
    const batches = await c().batches.find({})
    const batch = batches[batches.length - 1]
    return { batch, ids: batchTransactionIds(batch) }
  }

  return { ...env, c, participant, survey, prune, imported }
}

describe('what the exchange removes', () => {
  it('removes a closed batch once every transaction it created is going', async () => {
    const env = await setup()
    const { batch, ids } = await env.imported()
    expect(batch.closedAt).toBeDefined()

    const survey = await env.survey(new Set(ids))
    expect(survey).toMatchObject({ describe: '1 import batch', documents: 1 })

    const result = await env.prune(new Set(ids))
    expect(result.documents).toBe(1)
    expect(await env.c().batches.find({})).toEqual([])
  })

  it('keeps a batch while any of its transactions stays', async () => {
    const env = await setup()
    const { ids } = await env.imported()

    const survey = await env.survey(new Set(ids.slice(0, 1)))
    expect(survey.documents).toBe(0)

    await env.prune(new Set(ids.slice(0, 1)))
    expect(await env.c().batches.find({})).toHaveLength(1)
  })

  it('keeps an open batch whatever is going, and warns about it', async () => {
    const env = await setup()
    // Two rows filed, only one accepted: the statement still has rows, so the batch stays open
    await env.fileOf(document({ statements: [statement({ transactions: [row({ date: '2026-01-05' }), row({ date: '2026-01-12', payee: 'Other' })] })] }),
      { path: '/in/january.fake' })
    const waiting = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting[0].id, waiting[0].rows[0].key)
    const batch = (await env.c().batches.find({}))[0]
    expect(batch.closedAt).toBeUndefined()
    const ids = batchTransactionIds(batch)

    const survey = await env.survey(new Set(ids))

    expect(survey.documents).toBe(0)
    expect(survey.warnings).toContainEqual({ kind: 'openImport', message: 'One import of “january.fake” is still open. Its batch is kept.' })
    await env.prune(new Set(ids))
    expect(await env.c().batches.find({})).toHaveLength(1)
  })

  it('warns about a pending statement reaching before the cut-off, and keeps it', async () => {
    const env = await setup()
    await env.fileOf(document({ statements: [statement({ period: { from: '2026-01-01', to: '2026-01-31' }, transactions: [row({ date: '2026-01-05' })] })] }),
      { path: '/in/january.fake' })

    const survey = await env.survey(new Set())

    expect(survey.warnings).toContainEqual({
      kind: 'openImport',
      message: expect.stringMatching(/statement of “january\.fake” from before .* hasn’t been reviewed\. It is kept\./)
    })
    await env.prune(new Set())
    expect(await env.c().pending.find({})).toHaveLength(1)
  })

  it('leaves links, rules and profiles alone', async () => {
    const env = await setup()
    const { ids } = await env.imported()
    const links = await env.c().links.find({})

    await env.prune(new Set(ids))

    expect(await env.c().links.find({})).toEqual(links)
  })

  it('writes nothing in the survey', async () => {
    const env = await setup()
    const { ids } = await env.imported()
    const before = await env.session.unscopedDatabase().snapshot()
    await env.survey(new Set(ids))
    expect(await env.session.unscopedDatabase().snapshot()).toEqual(before)
  })
})
