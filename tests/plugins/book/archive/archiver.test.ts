// @vitest-environment node
// The whole archive run against a real session and the real accounts participant: refuse, plan, write the frozen
// copy, prune in one transaction, record the cut-off, announce. See docs/archive-design.md, "The archive sequence".
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BOOK_META, isBookError,
  type ArchiveParticipant, type ArchiveRequest, type BookChange
} from '@tessera/book-api'
import { ArchiveWriter } from '../../../../plugins/book/src/privileged/archive/ArchiveWriter'
import { Archiver } from '../../../../plugins/book/src/privileged/archive/Archiver'
import { DIR, logger, memoryBackupDisk } from '../harness'
import { chequing, setupAccounts } from '../../accounts/harness'

const FOLDER = path.join(DIR, 'Documents', 'Tessera Archives')
const BEFORE = '2026-01-01'
const NOW = () => new Date(2026, 10, 20, 10, 0, 0)
const REQUEST: ArchiveRequest = { before: BEFORE, removeReconciled: true, removeVoided: true }

const failure = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return err as { code: string, message: string }
}

async function setup() {
  const env = await setupAccounts()
  env.session.participateInArchive('accounts', env.service.archiveParticipant)
  const folders = memoryBackupDisk()
  const log = logger()
  const writer = new ArchiveWriter({
    engine: env.engine, bookDisk: env.disk.disk, folders: folders.disk,
    probe: file => env.session.probeFile(file), log, now: NOW
  })
  const archiver = new Archiver({
    session: env.session, participants: env.session.archiveParticipants, writer, folder: () => FOLDER, log, now: NOW
  })
  const events: BookChange[] = []
  env.session.onDidChange(change => events.push(change))

  /** An account with two old reconciled transactions and one recent one. */
  const seeded = async (name = 'Chequing') => {
    const account = await env.service.createAccount(chequing({ name, openingDate: '2024-01-01', openingBalance: 100000 }))
    const transactions = env.service.transactions(account.id)
    for (const [date, amount] of [['2025-03-01', -1000], ['2025-06-01', 2500]] as [string, number][]) {
      const made = await transactions.create({ date, amount, payee: 'Shop' })
      await transactions.setStatus([made.id], 'reconciled', { confirm: ['reconciled'] })
    }
    await transactions.create({ date: '2026-03-01', amount: -400, payee: 'Shop' })
    return account
  }

  return { ...env, archiver, folders, log, events, seeded, archiveLog: log }
}

describe('a successful archive run', () => {
  it('writes the frozen copy, prunes the book, records the cut-off and announces it', async () => {
    const env = await setup()
    const account = await env.seeded()
    const balancesBefore = await env.service.balances(account.id)

    const outcome = await env.archiver.archive(REQUEST)

    // The copy: a frozen book holding everything, old transactions included
    expect(outcome).toEqual({ file: path.join(FOLDER, 'Home Archive through 2026-01-01.tessera'), before: BEFORE, documents: 2 })
    const archive = env.driver.databases.get(outcome.file)!
    expect(archive.meta.get(BOOK_META.readOnly)).toBe(true)
    expect(archive.collections.get('accounts.transactions')!.docs.size).toBe(3)

    // The book: pruned, balanced, and stamped
    const balancesAfter = await env.service.balances(account.id)
    expect(balancesAfter).toEqual({ ...balancesBefore, transactionCount: 1 })
    expect((await env.service.get(account.id))!.openingBalance).toBe(100000 + 1500)
    expect(env.driver.databases.get(env.session.current!.path)!.meta.get(BOOK_META.lastArchivedThrough)).toBe(BEFORE)
    expect(env.events).toContainEqual({ type: 'pruned', book: expect.objectContaining({ name: 'Home' }), through: BEFORE })
  })

  it('leaves a book that still opens, and an archive that opens read-only with the old data', async () => {
    const env = await setup()
    await env.seeded()
    const outcome = await env.archiver.archive(REQUEST)

    const opened = await env.session.open(outcome.file)
    expect(opened).toMatchObject({ readOnly: true, archive: expect.objectContaining({ through: BEFORE, ofName: 'Home' }) })
  })

  it('refuses a second archive through the same date, and takes a later one', async () => {
    const env = await setup()
    const account = await env.seeded()
    await env.archiver.archive(REQUEST)

    const err = await failure(env.archiver.archive(REQUEST))
    expect(err.code).toBe('ARCHIVE_DATE')
    expect(err.message).toMatch(/already been archived through/)

    // Reconcile the 2026 transaction and archive further
    const left = (await env.service.transactions(account.id).list())[0]
    await env.service.transactions(account.id).setStatus([left.id], 'reconciled', { confirm: ['reconciled'] })
    const second = await env.archiver.archive({ ...REQUEST, before: '2026-06-01' })
    expect(second.documents).toBe(1)
  })
})

describe('what archiving refuses before anything happens', () => {
  it('needs an open, writable book', async () => {
    const env = await setup()
    await env.session.close()
    expect((await failure(env.archiver.plan(REQUEST))).code).toBe('NO_BOOK')
  })

  it('refuses a cut-off in the future', async () => {
    const env = await setup()
    await env.seeded()
    const err = await failure(env.archiver.plan({ ...REQUEST, before: '2026-12-01' }))
    expect(err.code).toBe('ARCHIVE_DATE')
    expect(err.message).toMatch(/in the future/)
  })

  it('says when there is nothing to archive, with no file written', async () => {
    const env = await setup()
    const err = await failure(env.archiver.archive(REQUEST))
    expect(err.code).toBe('ARCHIVE_NOTHING_TO_DO')
    expect([...env.driver.databases.keys()].filter(f => f.includes('Archive'))).toEqual([])
  })

  it('is blocked by a reconciliation in progress, with no file written', async () => {
    const env = await setup()
    const account = await env.seeded()
    await env.service.reconciliation.begin(account.id, {
      reconcilerId: 'accounts.statement', statementDate: '2025-06-30', startingBalance: 0, statementBalance: 0
    })

    const err = await failure(env.archiver.archive(REQUEST))
    expect(err.code).toBe('ARCHIVE_BLOCKED')
    expect(err.message).toMatch(/reconciliation of “Chequing” is in progress/)
    expect([...env.driver.databases.keys()].filter(f => f.includes('Archive'))).toEqual([])
  })
})

describe('when the prune fails, the archive is the safety net', () => {
  const saying = (documents: number, prune: ArchiveParticipant['prune']): ArchiveParticipant => ({
    survey: vi.fn(async () => ({ describe: `${documents} things`, documents, warnings: [] })),
    prune: vi.fn(prune)
  })

  it('rolls everything back when a participant throws, and keeps the copy', async () => {
    const env = await setup()
    const account = await env.seeded()
    env.session.participateInArchive('boom', saying(1, async () => { throw new Error('kaput') }), { before: ['accounts'] })
    const before = await env.service.balances(account.id)

    const err = await failure(env.archiver.archive(REQUEST))

    expect(err.message).toMatch(/nothing was removed from “Home”.*kaput.*archive was saved as “Home Archive through 2026-01-01\.tessera”/s)
    expect(await env.service.balances(account.id)).toEqual(before)
    expect(env.driver.databases.has(path.join(FOLDER, 'Home Archive through 2026-01-01.tessera'))).toBe(true)
  })

  it('rolls everything back when a participant removes a different count than it promised', async () => {
    const env = await setup()
    const account = await env.seeded()
    env.session.participateInArchive('flaky', saying(5, async () => ({ documents: 3 })), { before: ['accounts'] })
    const before = await env.service.balances(account.id)

    const err = await failure(env.archiver.archive(REQUEST))

    expect(err.code).toBe('ARCHIVE_CHANGED')
    expect(err.message).toMatch(/changed while it was being archived, so nothing was removed/)
    expect(await env.service.balances(account.id)).toEqual(before)
    expect((await env.service.get(account.id))!.openingBalance).toBe(100000)
  })

  it('hands every prune the ids from every survey, however late it runs', async () => {
    const env = await setup()
    await env.seeded()
    const seen: ReadonlySet<string>[] = []
    env.session.participateInArchive('watcher', {
      survey: async () => ({ describe: 'watching', documents: 0, warnings: [], removesIds: ['w1'] }),
      prune: async (_tx, context) => { seen.push(context.removedIds); return { documents: 0 } }
    }, { before: ['accounts'] })

    await env.archiver.archive(REQUEST)

    expect(seen).toHaveLength(1)
    expect(seen[0].has('w1')).toBe(true)
    expect(seen[0].size).toBe(3)      // its own id and the two transactions accounts removes
  })
})
