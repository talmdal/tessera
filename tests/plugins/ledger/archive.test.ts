// @vitest-environment node
// Archiving, the session's half: participants, the one storage transaction they run in, the ledger's record, and what
// `runArchive` refuses. The participants here are fakes over their own collections; the accounts participant is tested
// in tests/plugins/accounts/archive.test.ts. See docs/ledger-compaction-design.md, "The participant contract".
//
// The fakes record what they were given, and the tests assert afterwards: an assertion failing inside a participant
// would only turn into ARCHIVE_FAILED.
import { describe, expect, it, vi } from 'vitest'
import type { Transaction } from '@tessera/types'
import { LEDGER_COLLECTIONS, LedgerError, displayDate, type ArchiveParticipant, type ArchiveRequest, type LedgerArchived } from '@tessera/ledger-api'
import { contributor, file, setupSession } from './harness'

/** Noon on 10 November 2026, local time: "today" for the archive date's check. */
const NOW = () => new Date(2026, 10, 10, 12)
const COPY = { path: file('Archives/Home (archive before 2026-01-01).tesserabkp'), takenAt: '2026-11-10T17:00:00.000Z' }

async function setup() {
  const env = setupSession({ now: NOW })
  for (const id of ['accounts', 'import', 'budgets']) env.contribute(contributor(id, 1))
  await env.created()
  const things = (id: string) => env.session.database(id).collection<{ name: string }>(`${id}.things`)
  for (const id of ['accounts', 'import', 'budgets']) await things(id).insert({ name: 'old' })
  const archived: LedgerArchived[] = []
  env.session.onDidArchive(event => archived.push(event))
  return { ...env, things, archived }
}

/** A participant that removes its `old` thing and records what it was given. */
function remover(id: string, over: Partial<ArchiveParticipant> = {}) {
  const requests: ArchiveRequest[] = []
  const committed = vi.fn()
  const participant: ArchiveParticipant = {
    describe: async () => ({ count: 1, summary: `1 ${id} thing` }),
    archive: async (tx: Transaction, request) => {
      requests.push({ ...request, earlier: new Map(request.earlier) })
      const { deleted } = await tx.collection(`${id}.things`).deleteMany({ name: 'old' })
      return { count: deleted, summary: `${deleted} ${id} thing`, shared: { from: id } }
    },
    committed,
    ...over
  }
  return { participant, requests, committed }
}

const rejection = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a rejection') }, err => err as LedgerError)

describe('archive participants', () => {
  it('join once each, need describe and archive, and leave when disposed', async () => {
    const { session } = await setup()
    const joined = session.participateInArchive('accounts', remover('accounts').participant)
    expect(() => session.participateInArchive('accounts', remover('accounts').participant)).toThrow('already takes part')
    expect(() => session.participateInArchive('import', { describe: async () => undefined } as never)).toThrow('needs describe and archive')
    joined.dispose()
    expect(() => session.participateInArchive('accounts', remover('accounts').participant)).not.toThrow()
  })

  it('run in the order they joined, each with the date, the options and what those before it shared', async () => {
    const { session, things } = await setup()
    const accounts = remover('accounts'), imports = remover('import')
    session.participateInArchive('accounts', accounts.participant)
    session.participateInArchive('import', imports.participant)

    const outcome = await session.runArchive({ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': false }, copy: COPY })

    expect(accounts.requests).toEqual([{ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': false }, earlier: new Map() }])
    expect(imports.requests).toEqual([{ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': false }, earlier: new Map([['accounts', { from: 'accounts' }]]) }])
    expect(await things('accounts').find()).toEqual([])
    expect(await things('import').find()).toEqual([])
    expect(await things('budgets').count()).toBe(1)      // not a participant
    expect(outcome).toEqual({ before: '2026-01-01', archivedAt: NOW().toISOString(), copy: COPY, count: 2, summaries: ['1 accounts thing', '1 import thing'] })
  })

  it('reach only their own collections', async () => {
    const { session, things } = await setup()
    session.participateInArchive('accounts', remover('accounts').participant)
    session.participateInArchive('import', remover('import', {
      archive: async tx => { await tx.collection('accounts.things').insert({ name: 'sneaky' }); return { count: 1, summary: 'x' } }
    }).participant)

    const err = await rejection(session.runArchive({ before: '2026-01-01', copy: COPY }))
    expect(err.code).toBe('ARCHIVE_FAILED')
    expect(err.message).toMatch(/may only use names starting with "import\."/)
    expect((await things('accounts').find()).map(t => t.name)).toEqual(['old'])   // the first participant's removal rolled back too
  })

  it('are described for the dialog, one that fails being left out', async () => {
    const { session, log } = await setup()
    session.participateInArchive('accounts', remover('accounts', {
      describe: async (before, options) => ({ count: 3, summary: `3 before ${before}`, warnings: [{ message: 'careful' }], options: [{ id: 'accounts.x', label: 'X', default: options['accounts.x'] ?? true }] })
    }).participant)
    session.participateInArchive('import', remover('import', { describe: async () => { throw new Error('oops') } }).participant)
    session.participateInArchive('budgets', remover('budgets', { describe: async () => undefined }).participant)

    expect(await session.describeArchive('2026-01-01', { 'accounts.x': false })).toEqual([
      { contributor: 'accounts', count: 3, summary: '3 before 2026-01-01', warnings: [{ message: 'careful' }], options: [{ id: 'accounts.x', label: 'X', default: false }] }
    ])
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/"import" could not describe an archive before 2026-01-01: oops/))
    expect((await rejection(session.describeArchive('2026-13-01'))).code).toBe('INVALID')
  })
})

describe('running an archive', () => {
  it('records it in the ledger, in the same transaction, newest first', async () => {
    const { session, driver } = await setup()
    session.participateInArchive('accounts', remover('accounts').participant)
    await session.runArchive({ before: '2025-01-01', copy: COPY })
    await session.database('accounts').collection('accounts.things').insert({ name: 'old' })
    const second = { path: file('Archives/Home (archive before 2026-01-01).tesserabkp'), takenAt: '2026-11-10T17:30:00.000Z' }
    await session.runArchive({ before: '2026-01-01', copy: second })

    const records = await session.archiveRecords()
    expect(records.map(r => [r.before, r.copy, r.count, r.summaries])).toEqual([
      ['2026-01-01', second, 1, ['1 accounts thing']],
      ['2025-01-01', COPY, 1, ['1 accounts thing']]
    ])
    // The ledger's own collection, declared with the ledger format
    const stored = driver.databases.get(file('Home.tessera'))!.collections.get(LEDGER_COLLECTIONS.archives)
    expect(stored?.docs.size).toBe(2)
  })

  it('rolls every participant back when one fails, and says nothing was archived', async () => {
    const { session, things, archived, log } = await setup()
    const accounts = remover('accounts'), imports = remover('import', { archive: async () => { throw new Error('boom') } })
    session.participateInArchive('accounts', accounts.participant)
    session.participateInArchive('import', imports.participant)

    const err = await rejection(session.runArchive({ before: '2026-01-01', copy: COPY }))

    expect(err).toMatchObject({ code: 'ARCHIVE_FAILED', message: 'Nothing was archived. boom' })
    expect(await things('accounts').count()).toBe(1)
    expect(await session.archiveRecords()).toEqual([])
    expect(accounts.committed).not.toHaveBeenCalled()
    expect(imports.committed).not.toHaveBeenCalled()
    expect(archived).toEqual([])
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('nothing was removed'), expect.any(Error))
  })

  it('refuses an archive that removes nothing', async () => {
    const { session, archived } = await setup()
    const nothing = remover('accounts', { archive: async () => ({ count: 0, summary: 'nothing' }) })
    session.participateInArchive('accounts', nothing.participant)

    const err = await rejection(session.runArchive({ before: '2026-01-01', copy: COPY }))

    expect(err).toMatchObject({ code: 'INVALID', field: 'before', message: `There is nothing to archive before ${displayDate('2026-01-01')}.` })
    expect(await session.archiveRecords()).toEqual([])
    expect(nothing.committed).not.toHaveBeenCalled()
    expect(archived).toEqual([])
  })

  it('refuses a participant that doesn\'t say what it removed', async () => {
    const { session, things } = await setup()
    session.participateInArchive('accounts', remover('accounts').participant)
    session.participateInArchive('import', remover('import', { archive: async () => undefined as never }).participant)
    expect((await rejection(session.runArchive({ before: '2026-01-01', copy: COPY }))).code).toBe('ARCHIVE_FAILED')
    expect(await things('accounts').count()).toBe(1)
  })

  it('tells the participants once it is committed, then everyone else', async () => {
    const { session, archived, log } = await setup()
    const order: string[] = []
    const accounts = remover('accounts', { committed: () => { order.push(`accounts, with ${archived.length} announced`); throw new Error('listener') } })
    const imports = remover('import', { committed: () => { order.push('import') } })
    session.participateInArchive('accounts', accounts.participant)
    session.participateInArchive('import', imports.participant)

    await session.runArchive({ before: '2026-01-01', copy: COPY })

    expect(order).toEqual(['accounts, with 0 announced', 'import'])
    expect(log.error).toHaveBeenCalledWith('[ledger] "accounts" failed after an archive was committed', expect.any(Error))
    expect(archived).toEqual([{ before: '2026-01-01', copy: COPY.path }])
  })

  it('refuses when anything was committed after the copy began', async () => {
    const { session, things } = await setup()
    session.participateInArchive('accounts', remover('accounts').participant)
    const before = session.changeCount
    await things('budgets').insert({ name: 'new' })
    expect(session.changeCount).toBe(before + 1)

    const err = await rejection(session.runArchive({ before: '2026-01-01', copy: COPY, unchangedSince: before }))
    expect(err).toMatchObject({ code: 'CONFLICT', message: '“Home” changed while it was being copied. Try again.' })
    expect(await things('accounts').count()).toBe(1)

    await session.runArchive({ before: '2026-01-01', copy: COPY, unchangedSince: session.changeCount })
    expect(await things('accounts').count()).toBe(0)
  })

  it('runs in the file-operation queue, so the ledger can\'t close under it', async () => {
    const { session } = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    session.participateInArchive('accounts', remover('accounts', {
      archive: async tx => { entered(); await gate; await tx.collection('accounts.things').deleteMany({}); return { count: 1, summary: 'x' } }
    }).participant)

    const archiving = session.runArchive({ before: '2026-01-01', copy: COPY })
    await started
    const closing = session.close()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(session.current?.name).toBe('Home')       // still open: the close waits its turn
    release()
    await archiving
    await closing
    expect(session.current).toBeUndefined()
  })

  it('checks what it is asked', async () => {
    const { session } = await setup()
    session.participateInArchive('accounts', remover('accounts').participant)
    const refused = async (input: object) => rejection(session.runArchive({ before: '2026-01-01', copy: COPY, ...input } as never))

    expect(await refused({ before: '2026-02-30' })).toMatchObject({ code: 'INVALID', field: 'before' })
    expect(await refused({ before: '1 Jan 2026' })).toMatchObject({ code: 'INVALID', field: 'before' })
    expect(await refused({ before: '2026-11-11' })).toMatchObject({ code: 'INVALID', field: 'before', message: 'The date to archive before can’t be after today.' })
    expect(await refused({ options: { 'accounts.x': 'yes' } })).toMatchObject({ code: 'INVALID', field: 'options' })
    expect(await refused({ copy: undefined })).toMatchObject({ code: 'INVALID', field: 'copy' })
    expect(await refused({ copy: { path: '', takenAt: COPY.takenAt } })).toMatchObject({ code: 'INVALID', field: 'copy' })
    // Today itself is allowed
    expect((await session.runArchive({ before: '2026-11-10', copy: COPY })).count).toBe(1)

    await session.close()
    expect((await refused({})).code).toBe('NO_LEDGER')
  })

  it('reports a ledger error a participant throws as its failure, not as the session\'s own refusal', async () => {
    const { session, log } = await setup()
    session.participateInArchive('accounts', remover('accounts', { archive: async () => { throw new LedgerError('INVALID', 'Bad date.', 'before') } }).participant)
    // Not INVALID on the date field, which the dialog would show as the user's mistake
    expect(await rejection(session.runArchive({ before: '2026-01-01', copy: COPY }))).toEqual(
      expect.objectContaining({ code: 'ARCHIVE_FAILED', message: 'Nothing was archived. Bad date.', field: undefined }))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('failed in "accounts"'), expect.objectContaining({ message: 'Bad date.' }))
  })
})
