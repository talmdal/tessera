// @vitest-environment node
// Imports after an archive: the import plugin's records of bank lines follow the archive, and an import never adds a
// line dated before its account's last archival date. First the participant's rules on records made by hand, then the
// plugins activated together, re-importing statements after an archive. See docs/ledger-compaction-design.md,
// "Imports after an archive".
import { describe, expect, it, vi } from 'vitest'
import { LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import type { AccountInput, AccountsArchived } from '@tessera/accounts-api'
import { IMPORT_COMMANDS, IMPORT_EVENTS, IMPORT_MIGRATOR_SERVICE, type ImportReport, type ParsedStatement, type StatementLine } from '@tessera/import-api'
import { acceptTooltip } from '../../../plugins/import/src/privileged/annotator'
import { importArchiver } from '../../../plugins/import/src/privileged/archive'
import { IMPORT_SCHEMA, importMigrator } from '../../../plugins/import/src/privileged/schema'
import { collectionsOf, type StoredBatch, type StoredLine } from '../../../plugins/import/src/privileged/store'
import { setupSession } from '../ledger/harness'
import { sample, setupImport, type ImportEnv } from './harness'

// ---- The participant, on records made by hand

async function records() {
  const env = setupSession()
  env.extensions.contribute('import', LEDGER_SCHEMA_POINT, 'import', IMPORT_SCHEMA)
  env.services.provide('import', IMPORT_MIGRATOR_SERVICE, importMigrator)
  await env.created()
  const db = env.session.database('import')
  const c = collectionsOf(db)
  const batch = (accountId: string, state: StoredBatch['state'] = 'applied') => c.batches.insert({
    accountId, fileName: 'x.ofx', statementIndex: 0, importedAt: '2025-02-01T00:00:00.000Z', state,
    counts: { lines: 1, added: 1, matched: 0, possible: 0, duplicates: 0, invalid: 0 }
  })
  const line = (batchId: string, accountId: string, date: string, over: Partial<StoredLine> = {}) => c.lines.insert({
    batchId, accountId, importId: `id-${Math.random()}`, bank: { date, amount: -100 }, outcome: 'added', review: 'done', ...over
  })
  const changed = vi.fn()
  let turns = 0
  const archiver = importArchiver({ changed, turn: async () => { turns++ } })
  /** Runs the participant as the ledger does, in a transaction of the import's own collections. */
  const archive = (before: string, shared: unknown) => db.transaction(tx => archiver.archive(tx, { before, options: {}, earlier: new Map(shared === undefined ? [] : [['accounts', shared]]) }))
  const left = async () => ({ lines: (await c.lines.find()).map(l => l.id).sort(), batches: (await c.batches.find()).map(b => b.id).sort() })
  return { env, db, c, batch, line, archiver, archive, changed, left, turns: () => turns }
}

const shared = (over: Partial<AccountsArchived> = {}): AccountsArchived => ({ transactionIds: [], accounts: [], removedAccountIds: [], ...over })

describe('the import\'s records, in an archive', () => {
  it('go only where an import can no longer add the line again', async () => {
    const { batch, line, archive, left } = await records()
    const b = await batch('chq')
    const removedBefore = await line(b.id, 'chq', '2024-12-10', { transactionId: 't1' })
    const keptTransaction = await line(b.id, 'chq', '2024-12-11', { transactionId: 't2' })
    // Posted after the archive date for a transaction the user dated before it: its record keeps it from coming back
    const postedAfter = await line(b.id, 'chq', '2025-01-02', { transactionId: 't3' })
    const skipped = await line(b.id, 'chq', '2024-12-12', { outcome: 'skipped' })
    const pendingAdded = await line(b.id, 'chq', '2024-12-13', { transactionId: 't4', review: 'pending' })
    const proposal = await line(b.id, 'chq', '2024-12-14', { outcome: 'matched', review: 'pending', proposedId: 't5' })
    // Another account, where the archive removed nothing: its last archival date doesn't cover the line
    const elsewhere = await batch('sav')
    const skippedElsewhere = await line(elsewhere.id, 'sav', '2024-12-12', { outcome: 'skipped' })

    const result = await archive('2025-01-01', shared({
      transactionIds: ['t1', 't3', 't4', 't5'],
      accounts: [{ id: 'chq', lastArchiveDate: '2025-01-01' }]
    }))

    expect(result).toEqual({ count: 4, summary: '4 imported bank lines' })
    expect((await left()).lines).toEqual([keptTransaction.id, postedAfter.id, skippedElsewhere.id].sort())
    // Gone: a removed transaction's, a skipped one, a pending review and a proposal, all dated before the archive date
    expect(new Set([removedBefore, skipped, pendingAdded, proposal].map(l => l.id)).size).toBe(4)
  })

  it('go only before this archive\'s date, even when the account\'s last archival date is later', async () => {
    const { batch, line, archive, left } = await records()
    const b = await batch('chq')
    // Archiving to an earlier date than before: a line between the two dates stays, one before both goes
    const between = await line(b.id, 'chq', '2024-08-01', { transactionId: 't1' })
    await line(b.id, 'chq', '2024-03-01', { transactionId: 't2' })
    await archive('2024-06-01', shared({ transactionIds: ['t1', 't2'], accounts: [{ id: 'chq', lastArchiveDate: '2025-01-01' }] }))
    expect((await left()).lines).toEqual([between.id])
  })

  it('stay in an account whose last archival date is before them', async () => {
    const { batch, line, archive, left } = await records()
    const b = await batch('chq')
    const skipped = await line(b.id, 'chq', '2024-12-01', { outcome: 'skipped' })
    // Shared by another copy of the accounts plugin with an older date for the account: the line isn't covered
    await archive('2025-01-01', shared({ transactionIds: ['x'], accounts: [{ id: 'chq', lastArchiveDate: '2024-06-01' }] }))
    expect((await left()).lines).toEqual([skipped.id])
  })

  it('take a batch with them when none of its lines is left, unless it is still being applied', async () => {
    const { batch, line, archive, left } = await records()
    const emptied = await batch('chq'), partly = await batch('chq'), applying = await batch('chq', 'applying'), untouched = await batch('chq')
    await line(emptied.id, 'chq', '2024-12-01', { transactionId: 't1' })
    await line(partly.id, 'chq', '2024-12-01', { transactionId: 't2' })
    const stays = await line(partly.id, 'chq', '2025-02-01', { transactionId: 't3' })
    await line(applying.id, 'chq', '2024-12-01', { outcome: 'skipped' })
    await archive('2025-01-01', shared({ transactionIds: ['t1', 't2'], accounts: [{ id: 'chq', lastArchiveDate: '2025-01-01' }] }))
    const after = await left()
    expect(after.batches).toEqual([partly.id, applying.id, untouched.id].sort())
    expect(after.lines).toEqual([stays.id])
  })

  it('all go for a closed account the archive removed: lines, batches and saved matches', async () => {
    const { c, batch, line, archive, left } = await records()
    const old = await batch('old'), chq = await batch('chq')
    await line(old.id, 'old', '2021-03-01', { transactionId: 't1' })
    await line(old.id, 'old', '2026-02-01', { outcome: 'skipped' })
    const mine = await line(chq.id, 'chq', '2024-12-01')
    const link = { strength: 'strong' as const, autoApply: true, label: 'x', formatId: 'f', createdAt: 'x', lastUsedAt: 'x' }
    await c.links.insert({ ...link, key: 'bank:old', accountId: 'old' })
    const kept = await c.links.insert({ ...link, key: 'bank:chq', accountId: 'chq' })

    const result = await archive('2025-01-01', shared({ transactionIds: ['t1'], removedAccountIds: ['old'] }))

    expect(result.count).toBe(2)
    expect(await left()).toEqual({ lines: [mine.id], batches: [chq.id] })
    expect((await c.links.find()).map(l => l.id)).toEqual([kept.id])
  })

  it('are left alone without what accounts removed, and read what it shared defensively', async () => {
    const { batch, line, archive, left } = await records()
    const b = await batch('chq')
    await line(b.id, 'chq', '2024-12-01', { transactionId: 't1' })
    await line(b.id, 'chq', '2024-12-01', { transactionId: 't' })
    const before = await left()
    expect(await archive('2025-01-01', undefined)).toEqual({ count: 0, summary: 'No imported bank lines' })
    // A list given as text would read as its letters, and take the transaction "t"'s line: not a list, so nothing
    const malformed = { transactionIds: 't1', accounts: [{ id: 'chq', lastArchiveDate: '2025-01-01' }, null, { id: 'sav' }], removedAccountIds: [3] }
    expect(await archive('2025-01-01', malformed)).toMatchObject({ count: 0 })
    expect(await left()).toEqual(before)
  })

  it('tell the registers once the archive is committed, and let the event loop turn', async () => {
    const { batch, line, archiver, archive, changed, turns } = await records()
    const b = await batch('chq')
    for (let i = 0; i < 2500; i++) await line(b.id, 'chq', '2024-12-01', { transactionId: `t${i}` })
    await archive('2025-01-01', shared({ transactionIds: Array.from({ length: 2500 }, (_, i) => `t${i}`), accounts: [{ id: 'chq', lastArchiveDate: '2025-01-01' }] }))
    // At the 2,000th removal, and once more before the batches
    expect(turns()).toBe(2)
    expect(changed).not.toHaveBeenCalled()
    archiver.committed!()
    expect(changed).toHaveBeenCalledWith(['chq'])
    archiver.committed!()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('describe nothing for the dialog: which go depends on what accounts removes', async () => {
    const { archiver } = await records()
    expect(await archiver.describe('2025-01-01', {})).toBeUndefined()
  })
})

// ---- The plugins together, re-importing statements after an archive

const OCTOBER = sample('maple-trust-chequing-2026-10.ofx')
const NOVEMBER = sample('maple-trust-chequing-2026-11.ofx')

const chequing = (over: Partial<AccountInput> = {}): AccountInput => ({
  name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2024-06-01', openingBalance: 100000,
  accountNumber: '8812345678', ...over
})

/** A statement for the chequing account, found by its number without asking. */
const statement = (lines: StatementLine[]): ParsedStatement => ({
  account: { key: 'test:bank:8812345678', accountNumber: '8812345678', institution: 'Test Bank' }, currency: 'CAD', lines
})
const bankLine = (externalId: string, date: string, amount: string, payee: string, over: Partial<StatementLine> = {}): StatementLine =>
  ({ externalId, date, amount, payee, ...over })

async function imported() {
  const env = await setupImport()
  const chq = await env.accounts.createAccount(chequing())
  const t = env.accounts.transactions(chq.id)
  const reconcileAll = async (before: string) => {
    const ids = (await t.list()).filter(x => x.date < before).map(x => x.id)
    await t.setStatus(ids, 'reconciled', { confirm: ['reconciled'] })
  }
  const importLines = (lines: StatementLine[]) => env.manager.importStatements([statement(lines)], { label: 'Test Bank' }, { interactive: false })
  const counts = (report: ImportReport | undefined) => report!.results.map(r => r.counts)
  return { env, chq, t, reconcileAll, importLines, counts }
}

const balancesOf = async (env: ImportEnv, id: string) => {
  const { transactionCount: _count, ...money } = await env.accounts.balances(id)
  return money
}

describe('importing after an archive', () => {
  it('adds nothing when every statement is imported again, and every balance stays (the sample statements)', async () => {
    const { env, chq, t, reconcileAll } = await imported()
    await env.manager.importFiles([OCTOBER])
    await env.manager.importFiles([NOVEMBER])
    expect(await t.list()).toHaveLength(22)                  // 17 in October, and November's five new ones
    await reconcileAll('2026-11-01')
    const was = await balancesOf(env, chq.id)

    const outcome = await env.archive('2026-11-01')
    expect(outcome.summaries).toEqual(['17 transactions from 1 account', '17 imported bank lines'])

    const october = await env.manager.importFiles([OCTOBER])
    const november = await env.manager.importFiles([NOVEMBER])

    expect(october!.results[0]).toMatchObject({ lastArchiveDate: '2026-11-01', counts: { lines: 17, added: 0, duplicates: 0, archived: 17 } })
    // November repeats five October lines: left out too. Its own five were imported before
    expect(november!.results[0]).toMatchObject({ lastArchiveDate: '2026-11-01', counts: { lines: 10, added: 0, duplicates: 5, archived: 5 } })
    expect(await t.list()).toHaveLength(5)
    expect(await balancesOf(env, chq.id)).toEqual(was)
  })

  it.each([
    ['accepted', true],
    ['still waiting for review', false]
  ])('prunes the lines that looked already imported from another file (%s), and adds nothing when both files come again', async (_how, accept) => {
    const { env, chq, t, reconcileAll } = await imported()
    await env.manager.importFiles([sample('maple-trust-chequing-2026-10-converted.qbo')])   // October, known by content
    const november = await env.manager.importFiles([NOVEMBER])                              // the bank's ids
    expect(november!.results[0].counts).toMatchObject({ added: 5, alreadyImported: 5 })
    if (accept) {
      env.prompts.confirm.mockResolvedValueOnce(true)
      expect(await env.runtime.commands.execute(IMPORT_COMMANDS.acceptAll, { accountId: chq.id })).toMatchObject({ ok: true })
    }
    await reconcileAll('2026-11-01')
    const was = await balancesOf(env, chq.id)

    const outcome = await env.archive('2026-11-01')
    // October's 17 lines, and November's five that looked like five of them: left out (accepted), or proposed on them
    expect(outcome.summaries).toEqual(['17 transactions from 1 account', '22 imported bank lines'])

    const again = await env.manager.importFiles([sample('maple-trust-chequing-2026-10-converted.qbo'), NOVEMBER])
    expect(again!.results.map(r => r.counts)).toEqual([
      { lines: 17, added: 0, matched: 0, possible: 0, duplicates: 0, invalid: 0, archived: 17 },
      { lines: 10, added: 0, matched: 0, possible: 0, duplicates: 5, invalid: 0, archived: 5 }
    ])
    expect(await t.list()).toHaveLength(5)
    expect(await balancesOf(env, chq.id)).toEqual(was)
  })

  it('keeps the record of a line the bank posted after the archive date, for a transaction dated before it', async () => {
    const { env, chq, t, importLines, counts } = await imported()
    await importLines([bankLine('A', '2024-12-10', '-20.00', 'COFFEE'), bankLine('B', '2025-01-02', '-1200.00', 'CHEQUE 104', { number: '104' })])
    const cheque = (await t.findByExternalIds(['B']))[0]
    // The user dates the cheque the day they wrote it
    await t.update(cheque.id, { date: '2024-12-30' })
    await t.setStatus((await t.list()).map(x => x.id), 'reconciled', { confirm: ['reconciled'] })
    const was = await balancesOf(env, chq.id)

    const outcome = await env.archive('2025-01-01')
    expect(outcome.summaries).toEqual(['2 transactions from 1 account', '1 imported bank line'])

    const again = await importLines([bankLine('A', '2024-12-10', '-20.00', 'COFFEE'), bankLine('B', '2025-01-02', '-1200.00', 'CHEQUE 104', { number: '104' })])
    // The coffee is dated before the archival date; the cheque's line is still known
    expect(counts(again)).toEqual([{ lines: 2, added: 0, matched: 0, possible: 0, duplicates: 1, invalid: 0, archived: 1 }])
    expect(await t.list()).toEqual([])
    expect(await balancesOf(env, chq.id)).toEqual(was)
  })

  it('still matches a line dated before the archival date to a transaction that stayed, and adds what is after it', async () => {
    const { env, chq, t, importLines } = await imported()
    const settled = await t.create({ date: '2024-11-01', amount: -5000, payee: 'Grocer' })
    await t.setStatus([settled.id], 'reconciled', { confirm: ['reconciled'] })
    // An old cheque, still outstanding: it stays in the ledger through the archive
    const cheque = await t.create({ date: '2024-12-15', amount: -15000, payee: 'Plumber', number: '104' })
    await env.archive('2025-01-01')
    expect(await env.accounts.get(chq.id)).toMatchObject({ lastArchiveDate: '2025-01-01' })

    const report = await importLines([
      bankLine('C104', '2024-12-28', '-150.00', 'CHEQUE 104', { number: '104' }),     // the bank clears it at last
      bankLine('OLD', '2024-12-05', '-9.99', 'MYSTERY'),                              // not in the ledger: never added
      bankLine('NEW', '2025-01-05', '-5.00', 'COFFEE')                                // after the date: added
    ])

    expect(report.results[0]).toMatchObject({ lastArchiveDate: '2025-01-01', counts: { added: 1, archived: 1 } })
    expect(report.results[0].counts.matched + report.results[0].counts.possible).toBe(1)
    const left = await t.list()
    expect(left.map(x => [x.date, x.amount])).toEqual([['2024-12-15', -15000], ['2025-01-05', -500]])
    expect(left[0].id).toBe(cheque.id)
  })

  it('keeps a transaction\'s own date when its bank line, dated before the archival date, is accepted as its match', async () => {
    const { env, chq, t, importLines } = await imported()
    const settled = await t.create({ date: '2024-11-01', amount: -5000, payee: 'Grocer' })
    await t.setStatus([settled.id], 'reconciled', { confirm: ['reconciled'] })
    // Entered on the day the user paid it; the bank posted it on the last day of the old year
    const rent = await t.create({ date: '2025-01-02', amount: -120000, payee: 'Landlord' })
    await env.archive('2025-01-01')

    await importLines([bankLine('R1', '2024-12-31', '-1200.00', 'LANDLORD')])
    const c = collectionsOf(env.ledger.database('import'))
    const line = (await c.lines.findOne({ accountId: chq.id }))!
    expect(line).toMatchObject({ outcome: 'matched', proposedId: rent.id })
    expect(acceptTooltip(line as never, rent, 'CAD', '2025-01-01')).toBe('Link it to the bank line, and mark it electronically cleared')

    expect(await env.runtime.commands.execute(IMPORT_COMMANDS.accept, { lineIds: [line.id] })).toEqual({ ok: true, value: undefined })
    // The bank's date would put it before the archival date, which the accounts refuse: it keeps its own
    expect(await t.get(rent.id)).toMatchObject({ date: '2025-01-02', amount: -120000, status: 'electronic', externalId: line.importId })
  })

  it('changes nothing for an account never archived', async () => {
    const { env } = await imported()
    const savings = await env.accounts.createAccount(chequing({ name: 'Savings', accountNumber: '5550001111' }))
    const report = await env.manager.importStatements([{ ...statement([bankLine('S1', '2020-01-01', '1.00', 'INTEREST')]), account: { key: 'test:bank:5550001111', accountNumber: '5550001111' } }], { label: 'Test Bank' }, { interactive: false })
    expect(report.results[0]).toMatchObject({ accountId: savings.id, counts: { added: 1 } })
    expect(report.results[0].counts.archived).toBeUndefined()
    expect(report.results[0].lastArchiveDate).toBeUndefined()
  })

  it('takes a removed closed account\'s records, and refreshes the registers of the rest', async () => {
    const { env, chq, t, importLines } = await imported()
    const old = await env.accounts.createAccount(chequing({ name: 'Old', accountNumber: '7770002222', openingBalance: 0 }))
    await env.manager.importStatements([{ ...statement([bankLine('O1', '2021-02-01', '10.00', 'DEPOSIT'), bankLine('O2', '2021-03-01', '-10.00', 'WITHDRAWAL')]), account: { key: 'test:bank:7770002222', accountNumber: '7770002222' } }], { label: 'Test Bank' }, { interactive: false })
    const oldIds = (await env.accounts.transactions(old.id).list()).map(x => x.id)
    await env.accounts.transactions(old.id).setStatus(oldIds, 'reconciled', { confirm: ['reconciled'] })
    await env.accounts.closeAccount(old.id)
    await importLines([bankLine('A', '2024-12-10', '-20.00', 'COFFEE')])
    await t.setStatus((await t.list()).map(x => x.id), 'reconciled', { confirm: ['reconciled'] })
    const events: string[] = []
    env.runtime.events.subscribe(event => events.push(`${event.name} ${JSON.stringify((event as { data?: unknown }).data)}`))

    const outcome = await env.archive('2025-01-01')

    expect(outcome.summaries).toEqual(['3 transactions from 2 accounts, and 1 closed account with nothing left', '3 imported bank lines'])
    const c = collectionsOf(env.ledger.database('import'))
    expect(await c.lines.find({ accountId: old.id })).toEqual([])
    expect(await c.batches.find({ accountId: old.id })).toEqual([])
    expect(await c.lines.find({ accountId: chq.id })).toEqual([])
    expect(events).toContain(`${IMPORT_EVENTS.batches} ${JSON.stringify({ accounts: [chq.id] })}`)
  })

  it('rolls back the import\'s records with everything else when the archive fails after them', async () => {
    const { env, t, importLines } = await imported()
    await importLines([bankLine('A', '2024-12-10', '-20.00', 'COFFEE')])
    await t.setStatus((await t.list()).map(x => x.id), 'reconciled', { confirm: ['reconciled'] })
    env.ledger.participateInArchive('zz', { describe: async () => undefined, archive: async () => { throw new Error('late') } })
    const c = collectionsOf(env.ledger.database('import'))
    const lines = await c.lines.count()

    await expect(env.archive('2025-01-01')).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' })

    expect(await c.lines.count()).toBe(lines)
    expect(await t.list()).toHaveLength(1)
    // And so an import still finds the line it knows
    expect((await importLines([bankLine('A', '2024-12-10', '-20.00', 'COFFEE')])).results[0].counts).toMatchObject({ added: 0, duplicates: 1 })
  })
})
