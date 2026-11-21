// @vitest-environment node
// The archiver with the real accounts *and* recurring participants: the ids flow from the accounts survey into the
// recurring prune, the ordering holds, and the pruned book still balances. See docs/archive-design.md.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BOOK_SCHEMA_POINT, type ArchiveRequest } from '@tessera/book-api'
import { RECURRING_MIGRATOR_SERVICE, SOURCE_POSTING_INDEX } from '@tessera/recurring-api'
import { ArchiveWriter } from '../../../../plugins/book/src/privileged/archive/ArchiveWriter'
import { Archiver } from '../../../../plugins/book/src/privileged/archive/Archiver'
import { RecurringServiceImpl } from '../../../../plugins/recurring/src/privileged/RecurringServiceImpl'
import { RECURRING_SCHEMA, recurringMigrator } from '../../../../plugins/recurring/src/privileged/schema'
import { collectionsOf as recurringCollections } from '../../../../plugins/recurring/src/privileged/store'
import { publicService as accountsPublic } from '../../../../plugins/accounts/src/privileged/index'
import { DIR, logger, memoryBackupDisk } from '../harness'
import { chequing, setupAccounts } from '../../accounts/harness'

const FOLDER = path.join(DIR, 'Documents', 'Tessera Archives')
const TODAY = '2026-11-13'
const REQUEST: ArchiveRequest = { before: '2026-06-01', removeReconciled: true, removeVoided: true }

async function setup() {
  const env = await setupAccounts({ open: false })
  env.extensions.contribute('recurring', BOOK_SCHEMA_POINT, 'recurring', RECURRING_SCHEMA)
  env.services.provide('recurring', RECURRING_MIGRATOR_SERVICE, recurringMigrator)
  await env.created()

  const log = logger()
  const recurring = new RecurringServiceImpl({
    session: env.session, accounts: accountsPublic(env.service), log,
    today: () => TODAY, now: () => `${TODAY}T09:00:00.000Z`
  })
  // As the plugins register: recurring before accounts
  env.session.participateInArchive('recurring', recurring.archiveParticipant, { before: ['accounts'] })
  env.session.participateInArchive('accounts', env.service.archiveParticipant)

  const writer = new ArchiveWriter({
    engine: env.engine, bookDisk: env.disk.disk, folders: memoryBackupDisk().disk,
    probe: file => env.session.probeFile(file), log, now: () => new Date(2026, 10, 13)
  })
  const archiver = new Archiver({
    session: env.session, participants: env.session.archiveParticipants, writer,
    folder: () => FOLDER, log, now: () => new Date(2026, 10, 13)
  })
  const rc = () => recurringCollections(env.session.database('recurring'))
  return { ...env, recurring, archiver, rc }
}

describe('archiving a book with recurring series in it', () => {
  it('prunes both plugins in one transaction, clears the dangling link, and the book still balances', async () => {
    const env = await setup()
    const account = await env.service.createAccount(chequing({ openingDate: '2025-12-01', openingBalance: 100000 }))
    const series = await env.recurring.create({
      accountId: account.id,
      template: { amount: -14200, payee: 'Hydro', autoNumber: false, estimated: false },
      schedule: { frequency: 'monthly', interval: 1, startDate: '2026-01-15' }
    })
    // Enter Jan..May and reconcile everything: the series lands on 15 June, past the cut-off
    for (let n = 0; n < 5; n++) await env.recurring.enter([{ seriesId: series.id }])
    const transactions = env.service.transactions(account.id)
    const all = await transactions.list()
    await transactions.setStatus(all.map(t => t.id), 'reconciled', { confirm: ['reconciled'] })
    const before = await env.service.balances(account.id)

    const outcome = await env.archiver.archive(REQUEST)

    // 5 transactions and 4 postings went; the newest posting stayed, its transaction link cleared
    expect(outcome.documents).toBe(9)
    expect(await env.service.balances(account.id)).toEqual({ ...before, transactionCount: 0 })
    expect((await env.service.get(account.id))!.openingBalance).toBe(100000 - 5 * 14200)
    const postings = await env.rc().postings.find({ seriesId: series.id })
    expect(postings).toHaveLength(1)
    expect(postings[0].dueDate).toBe('2026-05-15')
    expect(postings[0].transactionId).toBeUndefined()
    // The series itself is untouched: it was already past the cut-off
    expect((await env.recurring.get(series.id))!.nextDate).toBe('2026-06-15')
    // The archive holds everything from before the prune
    const archive = env.driver.databases.get(outcome.file)!
    expect(archive.collections.get('accounts.transactions')!.docs.size).toBe(5)
    expect(archive.collections.get('recurring.postings')!.docs.size).toBe(5)
  })

  it('rolls an overdue series inside the same run, and the Due list is quiet about the archived period', async () => {
    const env = await setup()
    const account = await env.service.createAccount(chequing({ openingDate: '2025-12-01', openingBalance: 100000 }))
    // Never entered: due since February. Give accounts something to remove too, so the run has work
    await env.recurring.create({
      accountId: account.id, name: 'Rent',
      template: { amount: -50000, payee: 'Landlord', autoNumber: false, estimated: false },
      schedule: { frequency: 'monthly', interval: 1, startDate: '2026-02-01' }
    })
    const old = await env.service.transactions(account.id).create({ date: '2026-01-10', amount: -1000, payee: 'Shop' })
    await env.service.transactions(account.id).setStatus([old.id], 'reconciled', { confirm: ['reconciled'] })

    const outcome = await env.archiver.archive(REQUEST)

    expect(outcome.documents).toBe(1)        // the transaction; skipped postings are additions, not removals
    const rent = (await env.recurring.list())[0]
    expect(rent.nextDate).toBe('2026-06-01')
    expect(rent.skippedCount).toBe(4)
    const skipped = await env.rc().postings.find({ outcome: 'skipped' })
    expect(skipped.map(p => p.dueDate)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'])
    expect(skipped.every(p => p.index !== SOURCE_POSTING_INDEX)).toBe(true)
  })
})
