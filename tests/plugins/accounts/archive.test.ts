// @vitest-environment node
// Archiving, the accounts plugin's half: which transactions are no longer required, carrying their total into each
// account's opening balance, closed accounts with nothing left, the warning and options for the dialog, and the check
// that no balance changed. Run through a real ledger session (memory engine), as the ledger runs an archive.
// See docs/ledger-compaction-design.md.
import { describe, expect, it } from 'vitest'
import type { Doc } from '@tessera/types'
import { displayDate } from '@tessera/ledger-api'
import {
  ACCOUNTS_ARCHIVE_OPTIONS, ACCOUNTS_PLUGIN_ID, type Account, type AccountBalances, type AccountsArchived, type AccountsChange,
  type ArchivedTotal, type ClearingStatus, type RegisterRow, type TransactionTotal
} from '@tessera/accounts-api'
import {
  ArchiveCheckError, TOTALS_YIELD_EVERY, describePlan, planArchive, removedTotals, verifyArchive, type LedgerData
} from '../../../plugins/accounts/src/privileged/archiveCore'
import { collectionsOf, type StoredAccount, type StoredReconciliation, type StoredTransaction } from '../../../plugins/accounts/src/privileged/store'
import { compareTotals, sumTransactions, sumsByAccount } from '../../../plugins/accounts/src/privileged/transactionsCore'
import { file } from '../ledger/harness'
import { chequing, rejection, setupAccounts, type AccountsSetup } from './harness'

/** Noon on 10 November 2026, local time: "today" for the archive date's check. */
const NOW = () => new Date(2026, 10, 10, 12)
const REMOVE_CLOSED = ACCOUNTS_ARCHIVE_OPTIONS.removeClosedAccounts

async function ledger(options: AccountsSetup = {}) {
  const env = await setupAccounts({ now: NOW, ...options })
  const t = (id: string) => env.service.transactions(id)
  const reconcile = (accountId: string, ids: string[]) => t(accountId).setStatus(ids, 'reconciled', { confirm: ['reconciled'] })
  const archive = (before: string, options?: Record<string, boolean>) => env.session.runArchive({
    before, ...(options && { options }),
    copy: { path: file(`Tessera Backups/Archives/Home (archive before ${before}).tesserabkp`), takenAt: NOW().toISOString() }
  })
  /** Every account's balances, by id: the money, not `transactionCount`, which an archive lowers by design. */
  const balances = async () => {
    const all = new Map<string, Omit<AccountBalances, 'transactionCount'>>()
    for (const account of await env.service.list()) all.set(account.id, money(await env.service.balances(account.id)))
    return all
  }
  return { ...env, t, reconcile, archive, balances }
}

const money = ({ transactionCount: _count, ...balances }: AccountBalances) => balances

// ---- Documents, for the pure functions

let sequence = 0
const id = (prefix: string) => `${prefix}${String(++sequence).padStart(6, '0')}`

function account(over: Partial<Doc<StoredAccount>> = {}): Doc<StoredAccount> {
  return { id: id('A'), rev: 1, subLedgerId: null, name: 'Chequing', nameKey: 'chequing', type: 'chequing', currency: 'CAD', openingDate: '2023-01-01', openingBalance: 0, closed: false, order: 0, ...over }
}

function txn(accountId: string, over: Partial<Doc<StoredTransaction>> = {}): Doc<StoredTransaction> {
  return { id: id('T'), rev: 1, accountId, date: '2024-06-01', amount: -1000, status: 'reconciled', voided: false, createdAt: '2024-06-01T00:00:00.000Z', updatedAt: '2024-06-01T00:00:00.000Z', ...over }
}

function reconciliationDoc(accountId: string, over: Partial<Doc<StoredReconciliation>> = {}): Doc<StoredReconciliation> {
  return { id: id('R'), rev: 1, accountId, reconcilerId: 'accounts.reconcile.statement', status: 'finished', paused: false, startedAt: '2024-07-01T00:00:00.000Z', statementDate: '2024-06-30', startingBalance: 0, statementBalance: 0, original: {}, addedIds: [], reconciledIds: [], ...over }
}

const data = (accounts: Doc<StoredAccount>[], transactions: Doc<StoredTransaction>[], reconciliations: Doc<StoredReconciliation>[] = []): LedgerData => ({ accounts, transactions, reconciliations })

describe('which transactions are no longer required', () => {
  it('are the reconciled and void ones dated before the archive date (the worked cases)', () => {
    const a = account()
    const cases: [string, Partial<Doc<StoredTransaction>>, boolean][] = [
      ['reconciled payment', { status: 'reconciled' }, true],
      ['void cheque', { status: 'uncleared', voided: true }, true],
      ['void, reconciled before it was voided', { status: 'reconciled', voided: true }, true],
      ['cleared, not yet reconciled', { status: 'cleared' }, false],
      ['downloaded, not yet reconciled', { status: 'electronic' }, false],
      ['uncleared cheque from 2023', { status: 'uncleared', date: '2023-03-01', number: '104' }, false],
      ['a reconciled balance adjustment', { status: 'reconciled', memo: 'Reconciliation adjustment' }, true],
      ['dated on the archive date', { status: 'reconciled', date: '2025-01-01' }, false],
      ['dated after it', { status: 'reconciled', date: '2025-03-01' }, false]
    ]
    const docs = cases.map(([, over]) => txn(a.id, over))
    const plan = planArchive(data([a], docs), '2025-01-01', { removeClosedAccounts: true })
    const removed = new Set(plan.remove)
    expect(cases.map(([name], i) => [name, removed.has(docs[i].id)])).toEqual(cases.map(([name, , archived]) => [name, archived]))
    // The unreconciled ones before the date are what the dialog warns about; a void one isn't counted, nor one on or after the date
    expect(plan.unreconciled).toEqual(new Map([[a.id, 3]]))
  })

  it('carry their amounts, voids excepted, and the highest cheque number', () => {
    const a = account()
    const plan = planArchive(data([a], [
      txn(a.id, { amount: -120000, number: '101' }),
      txn(a.id, { amount: 300000, number: 'DEP' }),
      txn(a.id, { amount: -8000, voided: true, number: '107' }),
      txn(a.id, { amount: -15000, status: 'uncleared', number: '110' })
    ]), '2025-01-01', { removeClosedAccounts: true })
    expect(plan.accounts.get(a.id)).toEqual({ removed: 3, carried: 180000, highestNumber: 107 })
  })

  it('take a transfer only with both of its sides', () => {
    const chq = account(), sav = account({ name: 'Savings', nameKey: 'savings' })
    const pair = (transferId: string, mine: Partial<Doc<StoredTransaction>>, theirs: Partial<Doc<StoredTransaction>>) => [
      txn(chq.id, { transferId, transferAccountId: sav.id, amount: -5000, ...mine }),
      txn(sav.id, { transferId, transferAccountId: chq.id, amount: 5000, ...theirs })
    ]
    const both = pair('both', {}, {})
    const half = pair('half', {}, { status: 'uncleared' })
    const voided = pair('void', { voided: true, status: 'uncleared' }, { voided: true })
    const plan = planArchive(data([chq, sav], [...both, ...half, ...voided]), '2025-01-01', { removeClosedAccounts: true })
    expect(new Set(plan.remove)).toEqual(new Set([...both, ...voided].map(t => t.id)))
    expect(plan.keptTransfers).toBe(1)
    expect(plan.accounts.get(chq.id)?.carried).toBe(-5000)
    expect(plan.accounts.get(sav.id)?.carried).toBe(5000)
    expect(plan.unreconciled).toEqual(new Map([[sav.id, 1]]))
  })

  it('leave alone a transaction whose account is gone', () => {
    const a = account()
    const plan = planArchive(data([a], [txn('ghost')]), '2025-01-01', { removeClosedAccounts: true })
    expect(plan.remove).toEqual([])
  })
})

describe('carrying the balance forward', () => {
  it('keeps every balance and the opening date, and records the last archival date (the design\'s example)', async () => {
    const { service, t, reconcile, archive, balances } = await ledger()
    const chq = await service.createAccount(chequing({ openingDate: '2023-01-01', openingBalance: 100000 }))
    const landlord = await t(chq.id).create({ date: '2024-03-02', amount: -120000, payee: 'Landlord', number: '101' })
    const employer = await t(chq.id).create({ date: '2024-06-10', amount: 300000, payee: 'Employer' })
    const plumber = await t(chq.id).create({ date: '2024-11-15', amount: -15000, payee: 'Plumber', number: '104' })
    const hydro = await t(chq.id).create({ date: '2024-12-20', amount: -8000, payee: 'Hydro One' })
    const january = await t(chq.id).create({ date: '2025-01-05', amount: 300000, payee: 'Employer' })
    await reconcile(chq.id, [landlord.id, employer.id, january.id])
    await t(chq.id).setVoided([hydro.id], true)
    const was = await balances()
    expect(was.get(chq.id)).toMatchObject({ current: 565000, cleared: 580000, reconciled: 580000 })

    const outcome = await archive('2025-01-01')

    expect(outcome).toMatchObject({ before: '2025-01-01', count: 3, summaries: ['3 transactions from 1 account'] })
    expect(await balances()).toEqual(was)
    const after = (await service.get(chq.id))!
    expect(after).toMatchObject({ openingDate: '2023-01-01', openingBalance: 280000, lastArchiveDate: '2025-01-01', archived: { count: 3, originalOpeningBalance: 100000, highestNumber: 101 } })
    const register = await t(chq.id).register()
    expect(register.rows.map(r => [r.transaction.id, r.balance])).toEqual([[plumber.id, 265000], [january.id, 565000]])
  })

  it('keeps the available balance, the minimum and the choice to show it', async () => {
    const { service, t, reconcile, archive, balances } = await ledger()
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 600000, minimumBalance: 500000, showAvailableBalance: true }))
    const old = await t(sav.id).create({ date: '2024-02-01', amount: -50000 })
    await reconcile(sav.id, [old.id])
    const was = await balances()

    await archive('2025-01-01')

    expect(await balances()).toEqual(was)
    expect(was.get(sav.id)!.available).toBe(50000)
    expect(await service.get(sav.id)).toMatchObject({ minimumBalance: 500000, showAvailableBalance: true, openingBalance: 550000 })
  })

  it('takes the later date and adds up the counts over several archives, keeping the first opening balance', async () => {
    const { service, t, reconcile, archive } = await ledger()
    const chq = await service.createAccount(chequing({ openingDate: '2022-01-01', openingBalance: 100000 }))
    const early = await t(chq.id).create({ date: '2023-03-01', amount: -1000 })
    const late = await t(chq.id).create({ date: '2024-03-01', amount: -2000 })
    const straggler = await t(chq.id).create({ date: '2023-01-15', amount: -500, number: '250' })
    await reconcile(chq.id, [early.id, late.id])

    await archive('2024-01-01')
    expect(await service.get(chq.id)).toMatchObject({ openingBalance: 99000, lastArchiveDate: '2024-01-01', archived: { count: 1, originalOpeningBalance: 100000 } })
    await archive('2025-01-01')
    expect(await service.get(chq.id)).toMatchObject({ openingBalance: 97000, lastArchiveDate: '2025-01-01', archived: { count: 2, originalOpeningBalance: 100000 } })

    // Nothing new: refused, and nothing changes
    expect(await rejection(archive('2025-01-01'))).toMatchObject({ code: 'INVALID', field: 'before' })

    // The straggler is reconciled at last, and archived with an earlier date: the later archival date stays
    await reconcile(chq.id, [straggler.id])
    await archive('2023-06-01')
    expect(await service.get(chq.id)).toMatchObject({ openingBalance: 96500, lastArchiveDate: '2025-01-01', archived: { count: 3, originalOpeningBalance: 100000, highestNumber: 250 } })
  })

  it('keeps the archived cheque numbers in the next number suggested', async () => {
    const { service, t, reconcile, archive } = await ledger()
    const chq = await service.createAccount(chequing())
    const cheques = []
    for (const number of ['101', '102', '105', 'ATM']) cheques.push(await t(chq.id).create({ date: '2024-05-01', amount: -100, number }))
    await reconcile(chq.id, cheques.map(c => c.id))
    expect(await t(chq.id).nextNumber()).toBe('106')

    await archive('2025-01-01')

    expect(await t(chq.id).list()).toEqual([])
    expect(await t(chq.id).nextNumber()).toBe('106')
    await t(chq.id).create({ date: '2025-02-01', amount: -100, number: '106' })
    expect(await t(chq.id).nextNumber()).toBe('107')
  })

  it('can\'t be set by editing an account, and survives an edit', async () => {
    const { service, t, reconcile, archive } = await ledger()
    const chq = await service.createAccount(chequing())
    const old = await t(chq.id).create({ date: '2024-05-01', amount: -100 })
    await reconcile(chq.id, [old.id])
    await archive('2025-01-01')

    expect(await rejection(service.updateAccount(chq.id, { lastArchiveDate: '2020-01-01' } as never))).toMatchObject({ code: 'INVALID', field: 'lastArchiveDate' })
    expect(await rejection(service.updateAccount(chq.id, { archived: { count: 0, originalOpeningBalance: 0 } } as never))).toMatchObject({ code: 'INVALID', field: 'archived' })
    expect(await rejection(service.createAccount({ ...chequing({ name: 'New' }), lastArchiveDate: '2020-01-01' } as never))).toMatchObject({ code: 'INVALID', field: 'lastArchiveDate' })

    const renamed = await service.updateAccount(chq.id, { name: 'Everyday', openingBalance: 200000 })
    expect(renamed).toMatchObject({ name: 'Everyday', openingBalance: 200000, lastArchiveDate: '2025-01-01', archived: { count: 1, originalOpeningBalance: 100000 } })
  })
})

describe('transfers', () => {
  it('go with both sides, or stay with both', async () => {
    const { service, t, reconcile, archive, balances } = await ledger()
    const chq = await service.createAccount(chequing())
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    const sideOf = async (accountId: string, transferId: string) => (await t(accountId).list()).find(x => x.transferId === transferId)!
    const settled = await t(chq.id).create({ date: '2024-05-01', amount: -50000, transferAccountId: sav.id })
    await reconcile(chq.id, [settled.id])
    await reconcile(sav.id, [(await sideOf(sav.id, settled.transferId!)).id])
    const half = await t(chq.id).create({ date: '2024-06-01', amount: -20000, transferAccountId: sav.id })
    await reconcile(chq.id, [half.id])
    const voided = await t(chq.id).create({ date: '2024-07-01', amount: -7000, transferAccountId: sav.id })
    await t(chq.id).setVoided([voided.id], true)
    const was = await balances()

    const description = await service.archiver.describe('2025-01-01', {})
    await archive('2025-01-01')

    expect(await balances()).toEqual(was)
    const left = [...await t(chq.id).list(), ...await t(sav.id).list()]
    expect(left.map(x => x.transferId)).toEqual([half.transferId, half.transferId])
    expect(await service.get(chq.id)).toMatchObject({ openingBalance: 50000, archived: { count: 2 } })
    expect(await service.get(sav.id)).toMatchObject({ openingBalance: 50000, archived: { count: 2 } })
    expect(description?.warnings).toEqual([{
      message: `1 transaction before ${displayDate('2025-01-01')} isn’t reconciled, so it stays in the ledger.`,
      details: ['Savings 1', '1 reconciled transfer stays with them, until the other side is reconciled.', 'To archive them too, cancel, reconcile those accounts, and archive again.']
    }])
  })
})

describe('entering transactions after an archive', () => {
  /** Chequing archived before 2025-01-01, keeping an old cheque never cashed; Savings never archived. */
  async function archived() {
    const env = await ledger()
    const { service, t, reconcile, archive } = env
    const chq = await service.createAccount(chequing())
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    const old = await t(chq.id).create({ date: '2024-03-01', amount: -1000 })
    await reconcile(chq.id, [old.id])
    const cheque = await t(chq.id).create({ date: '2024-11-20', amount: -18500, number: '900' })
    const later = await t(chq.id).create({ date: '2025-02-01', amount: -500 })
    await archive('2025-01-01')
    return { ...env, chq: (await service.get(chq.id))!, sav, cheque, later }
  }
  const refusal = (name: string) => `“${name}” has been archived before ${displayDate('2025-01-01')}, so its transactions must be dated ${displayDate('2025-01-01')} or later.`

  it('refuses a new transaction dated before the account\'s last archival date, and takes one on it', async () => {
    const { t, chq } = await archived()
    expect(await rejection(t(chq.id).create({ date: '2024-12-31', amount: -100 }))).toMatchObject({ code: 'INVALID', field: 'date', message: refusal('Chequing') })
    expect(await rejection(t(chq.id).createMany([{ date: '2025-03-01', amount: -1 }, { date: '2024-06-01', amount: -2 }])))
      .toMatchObject({ code: 'INVALID', field: 'drafts[1].date', message: refusal('Chequing') })
    expect(await t(chq.id).create({ date: '2025-01-01', amount: -100 })).toMatchObject({ date: '2025-01-01' })
  })

  it('holds each side of a transfer to its own account\'s date', async () => {
    const { t, chq, sav } = await archived()
    // Savings was never archived, so only Chequing's date counts, from either side
    expect(await rejection(t(sav.id).create({ date: '2024-12-01', amount: 100, transferAccountId: chq.id }))).toMatchObject({ field: 'date', message: refusal('Chequing') })
    expect(await t(sav.id).create({ date: '2024-12-01', amount: 100 })).toMatchObject({ date: '2024-12-01' })
  })

  it('won\'t move a transaction before the date, but lets one that stayed from before it be edited, its date included', async () => {
    const { t, chq, sav, cheque, later } = await archived()
    expect(await rejection(t(chq.id).update(later.id, { date: '2024-12-15' }))).toMatchObject({ field: 'date', message: refusal('Chequing') })
    // The cheque the bank never cashed: still editable, and movable within the old period or into the new one
    expect(await t(chq.id).update(cheque.id, { date: '2024-12-02', memo: 'Cashed at last' })).toMatchObject({ date: '2024-12-02', memo: 'Cashed at last' })
    // Turned into a transfer to Savings, which has no archive date: the new side can be dated then
    expect(await t(chq.id).update(cheque.id, { transferAccountId: sav.id })).toMatchObject({ transferAccountId: sav.id })
    expect(await t(chq.id).update(cheque.id, { date: '2025-01-05' })).toMatchObject({ date: '2025-01-05' })
    expect(await rejection(t(chq.id).update(cheque.id, { date: '2024-12-02' }))).toMatchObject({ field: 'date', message: refusal('Chequing') })
  })

  it('won\'t put a new side of a transfer before the other account\'s date, or move a side there', async () => {
    const { service, t, chq, sav } = await archived()
    const onSavings = await t(sav.id).create({ date: '2024-10-01', amount: 700 })
    expect(await rejection(t(sav.id).update(onSavings.id, { transferAccountId: chq.id }))).toMatchObject({ field: 'date', message: refusal('Chequing') })
    const transfer = await t(sav.id).create({ date: '2025-01-10', amount: 300, transferAccountId: chq.id })
    // Moving Savings' side would move Chequing's, which is after the date, before it
    expect(await rejection(t(sav.id).update(transfer.id, { date: '2024-12-30' }))).toMatchObject({ field: 'date', message: refusal('Chequing') })
    expect((await service.balances(sav.id)).current).toBe(1000)
  })

  it('refuses a statement\'s charge dated before the date, named after the dialog\'s field', async () => {
    const { service, chq } = await archived()
    const err = await rejection(service.reconciliation.begin(chq.id, {
      statementDate: '2025-01-31', startingBalance: 0, statementBalance: 0, reconcilerId: 'accounts.reconcile.statement',
      serviceCharge: { amount: 400, date: '2024-12-31' }
    }))
    expect(err).toMatchObject({ code: 'INVALID', field: 'serviceCharge', message: refusal('Chequing') })
  })
})

describe('closed accounts with nothing left', () => {
  async function closedAccounts() {
    const env = await ledger()
    const { service, t, reconcile } = env
    const settle = async (accountId: string, amounts: [string, number][]) => {
      const made = []
      for (const [date, amount] of amounts) made.push(await t(accountId).create({ date, amount }))
      await reconcile(accountId, made.map(m => m.id))
    }
    const chq = await service.createAccount(chequing())
    // Left empty by the archive, with a zero balance: removed
    const oldVisa = await service.createAccount(chequing({ name: 'Old Visa', type: 'creditCard', openingBalance: -30000 }))
    await settle(oldVisa.id, [['2021-02-01', -5000], ['2021-06-30', 35000]])
    await service.closeAccount(oldVisa.id)
    const empty = await service.createAccount(chequing({ name: 'Never used', openingBalance: 0 }))
    await service.closeAccount(empty.id)
    // A balance left: stays
    const oldLoan = await service.createAccount(chequing({ name: 'Old Loan', type: 'loan', openingBalance: -100000 }))
    await settle(oldLoan.id, [['2022-01-01', 40000]])
    await service.closeAccount(oldLoan.id, { confirm: ['closeWithBalance'] })
    // Activity after the archive date: stays
    const joint = await service.createAccount(chequing({ name: 'Joint', openingBalance: 0 }))
    await settle(joint.id, [['2024-01-01', 1000], ['2026-02-01', -1000]])
    await service.closeAccount(joint.id)
    // A reconciliation under way: stays
    const paused = await service.createAccount(chequing({ name: 'Paused', openingBalance: 0 }))
    await settle(paused.id, [['2024-01-01', 1000], ['2024-02-01', -1000]])
    await service.reconciliation.begin(paused.id, { statementDate: '2024-12-31', startingBalance: 0, statementBalance: 0, reconcilerId: 'accounts.reconcile.statement' })
    await service.reconciliation.pause(paused.id)
    await service.closeAccount(paused.id)
    return { ...env, chq, oldVisa, empty, oldLoan, joint, paused }
  }

  it('are offered for removal, and the ones that stay say why', async () => {
    const { service } = await closedAccounts()
    const description = (await service.archiver.describe('2026-01-01', {}))!
    expect(description.options).toEqual([{ id: REMOVE_CLOSED, label: 'Remove closed accounts with nothing left: “Old Visa”, “Never used”', default: true }])
    expect(description.notes).toEqual([
      '“Old Loan” is closed, but stays: its balance isn’t zero.',
      '“Paused” is closed, but stays: a reconciliation of it is under way.'
    ])
    // Old Visa's two, Old Loan's one (the account stays, its history goes), Joint's first and Paused's two
    expect(description.summary).toBe('6 transactions from 4 accounts, and 2 closed accounts with nothing left')
    expect(description.count).toBe(8)
    expect((await service.archiver.describe('2026-01-01', { [REMOVE_CLOSED]: false }))!.summary).toBe('6 transactions from 4 accounts')
  })

  it('are removed with their reconciliations, leaving every total as it was', async () => {
    const { service, archive, changes, session, oldVisa, empty, oldLoan, joint, paused } = await closedAccounts()
    const totals = (await service.chart()).totals
    changes.length = 0

    await archive('2026-01-01')

    expect(await service.get(oldVisa.id)).toBeUndefined()
    expect(await service.get(empty.id)).toBeUndefined()
    for (const kept of [oldLoan, joint, paused]) expect(await service.get(kept.id)).toBeDefined()
    expect((await service.chart()).totals).toEqual(totals)
    const reconciliations = await session.database('accounts').collection<StoredReconciliation>('accounts.reconciliations').find()
    expect(reconciliations.map(r => r.accountId)).toEqual([paused.id])
    // The name is free again
    await expect(service.createAccount(chequing({ name: 'Old Visa' }))).resolves.toBeDefined()
    expect(changes[0]).toMatchObject({ deleted: expect.arrayContaining([oldVisa.id, empty.id]) })
  })

  it('stay when the user unticks the option', async () => {
    const { service, archive, oldVisa, empty } = await closedAccounts()
    const outcome = await archive('2026-01-01', { [REMOVE_CLOSED]: false })
    expect(outcome.summaries).toEqual(['6 transactions from 4 accounts'])
    expect(await service.get(oldVisa.id)).toMatchObject({ closed: true, openingBalance: 0, lastArchiveDate: '2026-01-01' })
    expect(await service.get(empty.id)).toMatchObject({ closed: true })
  })
})

describe('the Archive dialog\'s description', () => {
  it('warns about what isn\'t reconciled before the date, account by account, and says nothing when all is', async () => {
    const { service, t, reconcile } = await ledger()
    const chq = await service.createAccount(chequing())
    const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: 0 }))
    for (let i = 0; i < 3; i++) await t(chq.id).create({ date: '2024-04-01', amount: -100 })
    const cleared = await t(visa.id).create({ date: '2024-04-01', amount: -100 })
    await t(visa.id).setStatus([cleared.id], 'cleared')
    await t(chq.id).create({ date: '2026-02-01', amount: -100 })      // after the date: not counted
    const settled = await t(visa.id).create({ date: '2024-03-01', amount: -100 })
    await reconcile(visa.id, [settled.id])

    expect(await service.archiver.describe('2025-01-01', {})).toEqual({
      count: 1,
      summary: '1 transaction from 1 account',
      warnings: [{
        message: `4 transactions before ${displayDate('2025-01-01')} aren’t reconciled, so they stay in the ledger.`,
        details: ['Chequing 3 · Visa 1', 'To archive them too, cancel, reconcile those accounts, and archive again.']
      }]
    })
    expect(await service.archiver.describe('2024-04-01', {})).toEqual({ count: 1, summary: '1 transaction from 1 account' })
    expect(await service.archiver.describe('2024-01-01', {})).toEqual({ count: 0, summary: `Nothing to archive before ${displayDate('2024-01-01')}` })
  })

  it('counts what the archive removes', async () => {
    const { service, t, reconcile, archive } = await ledger()
    const chq = await service.createAccount(chequing())
    const made = []
    for (let i = 0; i < 1234; i++) made.push({ date: '2024-01-01', amount: -1 })
    const created = await t(chq.id).createMany(made)
    await reconcile(chq.id, created.map(c => c.id))
    expect((await service.archiver.describe('2025-01-01', {}))!.summary).toBe('1,234 transactions from 1 account')
    expect((await archive('2025-01-01')).count).toBe(1234)
  })
})

describe('reconciliations', () => {
  it('before the date go, except each account\'s last; one under way stays, with what it marked', async () => {
    const { service, t, archive, session } = await ledger()
    const rec = service.reconciliation
    const statement = async (accountId: string, statementDate: string, startingBalance: number, statementBalance: number, ids: string[], confirm: ('adjustBalance')[] = []) => {
      await rec.begin(accountId, { statementDate, startingBalance, statementBalance, reconcilerId: 'accounts.reconcile.statement' })
      await rec.mark(accountId, ids, true)
      return rec.finish(accountId, { confirm })
    }
    const chq = await service.createAccount(chequing({ openingDate: '2023-01-01', openingBalance: 100000 }))
    const jan = [await t(chq.id).create({ date: '2024-01-10', amount: -20000 }), await t(chq.id).create({ date: '2024-01-20', amount: 50000 })]
    await statement(chq.id, '2024-01-31', 100000, 130000, jan.map(x => x.id))
    const feb = await t(chq.id).create({ date: '2024-02-05', amount: -10000 })
    const adjusted = await statement(chq.id, '2024-02-29', 130000, 119900, [feb.id], ['adjustBalance'])
    expect(adjusted.adjustment?.amount).toBe(-100)
    const mar = await t(chq.id).create({ date: '2025-03-03', amount: -5000 })
    await statement(chq.id, '2025-03-31', 119900, 114900, [mar.id])

    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    const june = await t(sav.id).create({ date: '2024-06-01', amount: 7000 })
    await statement(sav.id, '2024-06-30', 0, 7000, [june.id])

    const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: 0 }))
    const charge = await t(visa.id).create({ date: '2024-12-15', amount: -2500 })
    await rec.begin(visa.id, { statementDate: '2024-12-31', startingBalance: 0, statementBalance: -2500, reconcilerId: 'accounts.reconcile.statement' })
    await rec.mark(visa.id, [charge.id], true)
    await rec.pause(visa.id)
    const reconciledBefore = (await service.balances(chq.id)).reconciled

    const outcome = await archive('2025-01-01')

    // January's two, February's one and its adjustment, and Savings' June
    expect(outcome.summaries).toEqual(['5 transactions from 2 accounts'])
    const left = await session.database('accounts').collection<StoredReconciliation>('accounts.reconciliations').find()
    expect(left.map(r => [r.accountId, r.statementDate, r.status]).sort()).toEqual([
      [chq.id, '2025-03-31', 'finished'], [sav.id, '2024-06-30', 'finished'], [visa.id, '2024-12-31', 'inProgress']
    ].sort())
    // The next statement starts where the last one left off
    expect((await service.balances(chq.id)).reconciled).toBe(reconciledBefore)
    expect(await service.get(chq.id)).toMatchObject({ lastReconciled: { date: '2025-03-31', balance: 114900 } })
    // The paused one carries on, with its mark
    const paused = (await rec.get(visa.id))!
    expect(paused.candidates.map(c => [c.transaction.id, c.marked])).toEqual([[charge.id, true]])
    await rec.begin(visa.id, { statementDate: '2024-12-31', startingBalance: 0, statementBalance: -2500, reconcilerId: 'accounts.reconcile.statement' })
    expect((await rec.finish(visa.id)).reconciledCount).toBe(1)
  })
})

describe('announcing, and rolling back', () => {
  it('announce one change once the ledger has committed the archive', async () => {
    const { service, t, reconcile, archive, changes, session } = await ledger()
    const chq = await service.createAccount(chequing())
    const old = await t(chq.id).create({ date: '2024-05-01', amount: -100 })
    await reconcile(chq.id, [old.id])
    const seen: AccountsChange[][] = []
    session.onDidArchive(() => seen.push([...changes]))
    changes.length = 0

    await archive('2025-01-01')

    expect(changes).toEqual([{ created: [], updated: [chq.id], deleted: [], transactions: [chq.id], balances: [chq.id], categories: false, reconciliations: [], chart: true }])
    expect(seen).toEqual([changes])      // announced before the ledger's own event
  })

  it('rolls back everything, and announces nothing, when a participant after accounts fails', async () => {
    const { service, t, reconcile, archive, changes, session, balances } = await ledger()
    const chq = await service.createAccount(chequing())
    const old = await t(chq.id).create({ date: '2024-05-01', amount: -100 })
    await reconcile(chq.id, [old.id])
    const before = { account: await service.get(chq.id), balances: await balances() }
    session.participateInArchive('import', { describe: async () => undefined, archive: async () => { throw new Error('lines') } })
    changes.length = 0

    expect(await rejection(archive('2025-01-01'))).toMatchObject({ code: 'ARCHIVE_FAILED' })

    expect(await service.get(chq.id)).toEqual(before.account)
    expect(await balances()).toEqual(before.balances)
    expect((await t(chq.id).list()).map(x => x.id)).toEqual([old.id])
    expect(changes).toEqual([])
  })

  it('refuses to archive damaged data in a way the check catches, rather than make it worse', async () => {
    const { service, archive, session, balances } = await ledger()
    const chq = await service.createAccount(chequing())
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    // Three transactions sharing one transfer id: the service never makes this, but an older bug or a hand-edited file
    // could. The plan pairs each side with the first other one it finds, and would leave the third on its own
    const stamp = '2024-01-01T00:00:00.000Z'
    await session.database('accounts').collection('accounts.transactions').insertMany([
      { accountId: chq.id, date: '2024-03-01', amount: -500, status: 'reconciled', voided: false, createdAt: stamp, updatedAt: stamp, transferId: 'x', transferAccountId: sav.id },
      { accountId: sav.id, date: '2024-03-01', amount: 500, status: 'reconciled', voided: false, createdAt: stamp, updatedAt: stamp, transferId: 'x', transferAccountId: chq.id },
      { accountId: sav.id, date: '2024-03-01', amount: 500, status: 'uncleared', voided: false, createdAt: stamp, updatedAt: stamp, transferId: 'x', transferAccountId: chq.id }
    ])
    const was = await balances()

    const err = await rejection(archive('2025-01-01'))

    expect(err).toMatchObject({ code: 'ARCHIVE_FAILED', message: 'Nothing was archived. The archive was stopped: a transfer would have lost one of its sides.' })
    expect(await balances()).toEqual(was)
    expect(await session.database('accounts').collection('accounts.transactions').count()).toBe(3)
  })

  it('lets the event loop turn during a large removal', async () => {
    let turns = 0
    const { service, archive, session } = await ledger({ turn: async () => { turns++; await new Promise(resolve => setImmediate(resolve)) } })
    const chq = await service.createAccount(chequing())
    await session.database('accounts').transaction(async tx => {
      const docs = Array.from({ length: 2500 }, () => ({ accountId: chq.id, date: '2024-01-01', amount: -1, status: 'reconciled', voided: false, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }))
      await tx.collection('accounts.transactions').insertMany(docs)
    })

    // Between reading and planning, planning and removing, at the 2,000th write, and before the check
    let ticks = 0, running = true
    const tick = () => { ticks++; if (running) setImmediate(tick) }
    setImmediate(tick)
    await archive('2025-01-01')
    running = false
    expect(turns).toBe(4)
    expect(ticks).toBeGreaterThanOrEqual(4)
  })
})

describe('the check', () => {
  function archived() {
    const chq = account({ openingBalance: 100000 })
    const sav = account({ name: 'Savings', nameKey: 'savings', openingBalance: 0 })
    const closed = account({ name: 'Old', nameKey: 'old', closed: true, openingBalance: 0 })
    const transactions = [
      txn(chq.id, { amount: -20000 }),
      txn(chq.id, { amount: 5000, status: 'uncleared' }),
      txn(chq.id, { transferId: 'x', transferAccountId: sav.id, amount: -3000 }),
      txn(sav.id, { transferId: 'x', transferAccountId: chq.id, amount: 3000 }),
      txn(closed.id, { amount: 0 }),
      // Amounts of zero, so taking them out changes no balance: only the transaction checks can catch it
      txn(chq.id, { amount: 0, status: 'uncleared' }),
      txn(chq.id, { amount: 0, date: '2025-03-01' })
    ]
    const before = data([chq, sav, closed], transactions)
    const plan = planArchive(before, '2025-01-01', { removeClosedAccounts: true })
    const removed = new Set(plan.remove)
    const after = {
      accounts: [{ ...chq, openingBalance: 77000 }, { ...sav, openingBalance: 3000 }],
      transactions: transactions.filter(x => !removed.has(x.id))
    }
    return { before, plan, after, chq, sav, transactions }
  }

  it('passes a correct archive', () => {
    const { before, plan, after } = archived()
    expect(plan.removeAccounts).toHaveLength(1)
    expect(() => verifyArchive(before, after, plan)).not.toThrow()
  })

  it('stops a wrong carry, a changed opening date, a half transfer, an unsettled removal, a removed balance and a new account', () => {
    const stopped = (change: (a: ReturnType<typeof archived>) => Pick<LedgerData, 'accounts' | 'transactions'>) => {
      const a = archived()
      try { verifyArchive(a.before, change(a), a.plan) } catch (err) { return err instanceof ArchiveCheckError ? err.message : `not a check: ${err}` }
      return 'passed'
    }
    expect(stopped(({ after, chq }) => ({ ...after, accounts: after.accounts.map(x => x.id === chq.id ? { ...x, openingBalance: 77001 } : x) })))
      .toBe('The archive was stopped: the balances of “Chequing” would have changed.')
    expect(stopped(({ after, chq }) => ({ ...after, accounts: after.accounts.map(x => x.id === chq.id ? { ...x, openingDate: '2025-01-01' } : x) })))
      .toBe('The archive was stopped: the opening date of “Chequing” would have changed.')
    expect(stopped(({ after, transactions, sav }) => ({
      accounts: after.accounts.map(x => x.id === sav.id ? { ...x, openingBalance: 0 } : x),
      transactions: [...after.transactions, transactions[3]]
    }))).toBe('The archive was stopped: a transfer would have lost one of its sides.')
    expect(stopped(({ after, transactions }) => ({ ...after, transactions: after.transactions.filter(x => x.id !== transactions[5].id) })))
      .toBe(`The archive was stopped: a transaction of ${displayDate('2024-06-01')} that isn’t reconciled would have gone.`)
    expect(stopped(({ after, transactions }) => ({ ...after, transactions: after.transactions.filter(x => x.id !== transactions[6].id) })))
      .toBe(`The archive was stopped: a transaction of ${displayDate('2025-03-01')}, on or after the archive date, would have gone.`)
    expect(stopped(({ after }) => ({ ...after, accounts: after.accounts.filter(x => x.name !== 'Savings') })))
      .toBe('The archive was stopped: “Savings” would have gone.')
    expect(stopped(({ after }) => ({ ...after, accounts: [...after.accounts, account({ name: 'Stray' })] })))
      .toBe('The archive was stopped: “Stray” would have appeared.')
  })

  it('stops a removed account that still had a balance', () => {
    const { before, plan, after } = archived()
    const withBalance = { ...before, accounts: before.accounts.map(x => x.name === 'Old' ? { ...x, openingBalance: 500 } : x) }
    expect(() => verifyArchive(withBalance, after, plan)).toThrow('“Old” would have gone with a balance.')
  })
})

// ---- Random ledgers

/** A small deterministic random source (mulberry32). */
function random(seed: number) {
  let s = seed
  const next = () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(list: readonly T[]) => list[int(list.length)]
  const date = () => {
    const day = new Date(Date.UTC(2022, 0, 1) + int(1765) * 86400000)
    return day.toISOString().slice(0, 10)
  }
  return { next, int, pick, date }
}

/**
 * A random ledger, written straight into the accounts collections: accounts in two currencies, some closed (some of
 * those with nothing but settled history and a zero balance), transactions of every status, voids, transfers with
 * independent statuses, finished reconciliations, and now and then one under way.
 */
async function randomLedger(seed: number) {
  const env = await ledger()
  const r = random(seed)
  const stamp = '2022-01-01T00:00:00.000Z'
  const accounts: StoredAccount[] = Array.from({ length: 2 + r.int(4) }, (_, i) => ({
    subLedgerId: null, name: `Account ${i}`, nameKey: `account ${i}`, type: r.pick(['chequing', 'savings', 'creditCard'] as const),
    currency: r.next() < 0.8 ? 'CAD' : 'USD', openingDate: '2021-06-01', openingBalance: r.int(200000) - 50000, closed: r.next() < 0.3, order: i,
    ...(r.next() < 0.3 && { minimumBalance: r.int(10000) })
  }))
  await env.session.database('accounts').transaction(async tx => {
    const c = collectionsOf(tx)
    const made = await c.accounts.insertMany(accounts)
    const docs: StoredTransaction[] = []
    const status = (): ClearingStatus => r.next() < 0.6 ? 'reconciled' : r.pick(['uncleared', 'electronic', 'cleared'] as const)
    for (let i = 0, n = 20 + r.int(60); i < n; i++) {
      const a = r.pick(made), date = r.date(), voided = r.next() < 0.06, amount = r.int(100000) - 60000
      const number = r.next() < 0.15 ? String(100 + r.int(400)) : undefined
      const others = made.filter(o => o.id !== a.id && o.currency === a.currency)
      if (others.length > 0 && r.next() < 0.2) {
        const b = r.pick(others), transferId = `t${seed}-${i}`
        docs.push({ accountId: a.id, date, amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, transferId, transferAccountId: b.id })
        docs.push({ accountId: b.id, date, amount: -amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, transferId, transferAccountId: a.id })
      } else {
        // Payees by position, drawing nothing from the random source, so the ledgers stay as they were before payees
        docs.push({ accountId: a.id, date, amount, status: status(), voided, createdAt: stamp, updatedAt: stamp, ...(number && { number }), ...(i % 4 !== 0 && { payeeId: `payee-${i % 7}` }) })
      }
    }
    // Half the closed accounts hold only settled history from 2022 (before every date archived to) that brings them to
    // zero: everything else of theirs goes, transfers with both sides
    const in2022 = () => new Date(Date.UTC(2022, 0, 1) + r.int(365) * 86400000).toISOString().slice(0, 10)
    for (const a of made.filter(x => x.closed && r.next() < 0.6)) {
      for (let k = docs.length - 1; k >= 0; k--) if (docs[k].accountId === a.id || docs[k].transferAccountId === a.id) docs.splice(k, 1)
      const settled = Array.from({ length: r.int(4) }, () => ({ accountId: a.id, date: in2022(), amount: r.int(20000) - 10000, status: 'reconciled' as const, voided: r.next() < 0.1, createdAt: stamp, updatedAt: stamp }))
      const rest = settled.filter(x => !x.voided).reduce((sum, x) => sum + x.amount, 0)
      settled.push({ accountId: a.id, date: in2022(), amount: -(a.openingBalance + rest), status: 'reconciled', voided: false, createdAt: stamp, updatedAt: stamp })
      docs.push(...settled)
    }
    await c.transactions.insertMany(docs)
    for (const a of made) {
      let last: string | undefined
      for (let k = 0, n = r.int(4); k < n; k++) {
        const rec = await c.reconciliations.insert({ accountId: a.id, reconcilerId: 'accounts.reconcile.statement', status: 'finished', paused: false, startedAt: stamp, statementDate: r.date(), startingBalance: 0, statementBalance: 0, original: {}, addedIds: [], reconciledIds: [] })
        last = rec.id
      }
      if (last) await c.accounts.updateOne({ id: a.id }, { $set: { lastReconciled: { date: '2024-01-01', balance: 0, reconciliationId: last } } })
      if (r.next() < 0.1) await c.reconciliations.insert({ accountId: a.id, activeFor: a.id, reconcilerId: 'accounts.reconcile.statement', status: 'inProgress', paused: true, startedAt: stamp, statementDate: '2026-10-31', startingBalance: 0, statementBalance: 0, original: {}, addedIds: [] })
    }
  })
  return { ...env, r }
}

describe('on random ledgers', () => {
  it('sums balances in one pass exactly as the register\'s aggregate does', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { session } = await randomLedger(seed)
      const c = collectionsOf(session.database('accounts'))
      expect(sumTransactions(await c.transactions.find()), `seed ${seed}`).toEqual(await sumsByAccount(c))
    }
  })

  it('never changes a balance, a running balance from the date on, a total or an opening date, nor splits a transfer', async () => {
    let archivedSome = 0
    const seen = { closedRemoved: 0, closedKeptByOption: 0, transfersKept: 0, transfersRemoved: 0 }
    for (let seed = 1; seed <= 40; seed++) {
      const { service, t, archive, balances, r, session } = await randomLedger(seed)
      const before = r.pick(['2023-01-01', '2024-01-01', '2024-07-01', '2025-01-01', '2026-01-01'])
      const removeClosed = r.next() < 0.7
      const c = collectionsOf(session.database('accounts'))
      const was = {
        accounts: new Map((await service.list()).map(a => [a.id, a])),
        balances: await balances(),
        totals: (await service.chart()).totals,
        registers: new Map<string, RegisterRow[]>(),
        transactions: await c.transactions.find()
      }
      for (const id of was.accounts.keys()) was.registers.set(id, (await t(id).register()).rows)
      const description = (await service.archiver.describe(before, { [REMOVE_CLOSED]: removeClosed }))!
      const label = `seed ${seed}, before ${before}`

      const outcome = await archive(before, { [REMOVE_CLOSED]: removeClosed }).catch(err => err as { code: string })
      if ('code' in outcome) {
        expect(outcome.code, label).toBe('INVALID')
        expect(description.count, label).toBe(0)
        continue
      }
      archivedSome++
      expect(outcome.count, label).toBe(description.count)

      const now = new Map((await service.list()).map(a => [a.id, a]))
      for (const [id, a] of was.accounts) {
        const after = now.get(id)
        if (!after) {
          // Only a closed account, left with nothing and no balance, and only with the option on
          expect(removeClosed && a.closed, label).toBe(true)
          expect(was.balances.get(id)!.current, label).toBe(0)
          seen.closedRemoved++
          continue
        }
        if (!removeClosed && description.options?.length) seen.closedKeptByOption++
        expect(money(await service.balances(id)), `${label}, ${a.name}`).toEqual(was.balances.get(id))
        expect(after.openingDate, label).toBe(a.openingDate)
        const rows = new Map((await t(id).register()).rows.map(row => [row.transaction.id, row.balance]))
        for (const row of was.registers.get(id)!) {
          if (row.transaction.date >= before) expect(rows.get(row.transaction.id), `${label}, ${a.name}, ${row.transaction.date}`).toBe(row.balance)
        }
      }
      expect((await service.chart()).totals, label).toEqual(was.totals)

      const left = new Set((await c.transactions.find()).map(x => x.id))
      const sides = new Map<string, boolean[]>()
      for (const x of was.transactions) {
        if (!left.has(x.id)) expect(x.date < before && (x.voided || x.status === 'reconciled'), `${label}: removed ${x.date} ${x.status}`).toBe(true)
        if (x.transferId) sides.set(x.transferId, [...(sides.get(x.transferId) ?? []), left.has(x.id)])
      }
      for (const kept of sides.values()) expect(new Set(kept).size, `${label}: a transfer split`).toBe(1)
      if (description.warnings?.some(w => w.details?.some(d => d.includes('reconciled transfer')))) seen.transfersKept++
      if ([...sides.values()].some(kept => !kept[0])) seen.transfersRemoved++
    }
    // The generator reaches every case: something to archive most of the time, closed accounts removed and kept by
    // the option, transfers removed whole and kept because of their other side
    expect(archivedSome).toBeGreaterThan(25)
    expect(seen.closedRemoved).toBeGreaterThan(0)
    expect(seen.closedKeptByOption).toBeGreaterThan(0)
    expect(seen.transfersKept).toBeGreaterThan(0)
    expect(seen.transfersRemoved).toBeGreaterThan(0)
  })
})

describe('what the archive shares: the totals of what it removed', () => {
  /** Every date a ledger here can hold. */
  const ALL = { from: '2000-01-01', to: '2100-12-31', includeTransfers: true }
  const key = (t: TransactionTotal) => `${t.accountId}|${t.month}|${t.categoryId}|${t.transferAccountId}`
  /** Totals added up by account, month, and category or transfer account, ignoring any other field. */
  function sum(...lists: TransactionTotal[][]) {
    const all = new Map<string, [number, number, number]>()
    for (const t of lists.flat()) {
      const [inflow, outflow, count] = all.get(key(t)) ?? [0, 0, 0]
      all.set(key(t), [inflow + t.inflow, outflow + t.outflow, count + t.count])
    }
    return all
  }
  /** A participant after accounts, as a budget is: it keeps what accounts shared. */
  function listen(session: Awaited<ReturnType<typeof ledger>>['session']) {
    const heard: { shared?: AccountsArchived } = {}
    session.participateInArchive('budget', {
      describe: async () => undefined,
      archive: async (_tx, request) => { heard.shared = request.earlier.get(ACCOUNTS_PLUGIN_ID) as AccountsArchived; return { count: 0, summary: 'Nothing' } }
    })
    return heard
  }

  it('are, with what stays, exactly what there was: on random ledgers, transfers included', async () => {
    let archived = 0, transfers = 0, removedAccounts = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { service, archive, r, session } = await randomLedger(seed)
      const heard = listen(session)
      const before = r.pick(['2023-01-01', '2024-01-01', '2024-07-01', '2025-01-01', '2026-01-01'])
      const accounts = new Map((await service.list()).map(a => [a.id, a]))
      const was = await service.transactionTotals(ALL)
      const label = `seed ${seed}, before ${before}`

      const outcome = await archive(before, { [REMOVE_CLOSED]: r.next() < 0.7 }).catch(err => err as { code: string })
      if ('code' in outcome) continue
      archived++
      const removed = heard.shared!.removedTotals!

      expect(sum(await service.transactionTotals(ALL), removed), label).toEqual(sum(was))
      // Each carries where its account was: a removed account's too
      for (const t of removed) {
        const a = accounts.get(t.accountId)!
        expect([t.currency, t.subLedgerId], label).toEqual([a.currency, a.subLedgerId])
        if (t.transferAccountId !== null) expect(t.transferSubLedgerId, label).toBe(accounts.get(t.transferAccountId)!.subLedgerId)
        else expect('transferSubLedgerId' in t, label).toBe(false)
        expect(t.inflow + t.outflow + t.count, label).toBeGreaterThan(0)
      }
      if (removed.some(t => t.transferAccountId !== null)) transfers++
      if (removed.some(t => heard.shared!.removedAccountIds.includes(t.accountId))) removedAccounts++
    }
    // The generator reaches the cases: archives, transfers archived, accounts removed with their totals kept
    expect(archived).toBeGreaterThan(25)
    expect(transfers).toBeGreaterThan(0)
    expect(removedAccounts).toBeGreaterThan(0)
  })

  it('leave voided transactions out, and count the rest by category, transfer account or none', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const heard = listen(session)
    const chq = await service.createAccount(chequing())
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', subLedgerId: null, openingBalance: 0 }))
    const rent = (await service.categories.list()).find(c => c.name === 'Rent')!.id
    const paid = await t(chq.id).create({ date: '2024-03-01', amount: -150000, categoryId: rent })
    const refund = await t(chq.id).create({ date: '2024-03-09', amount: 2000, categoryId: rent })
    const loose = await t(chq.id).create({ date: '2024-03-10', amount: -700 })
    const moved = await t(chq.id).create({ date: '2024-04-02', amount: -30000, transferAccountId: sav.id })
    const other = (await t(sav.id).list())[0]
    const voided = await t(chq.id).create({ date: '2024-03-15', amount: -99900, categoryId: rent })
    await t(chq.id).setVoided([voided.id], true)
    await reconcile(chq.id, [paid.id, refund.id, loose.id, moved.id])
    await reconcile(sav.id, [other.id])

    await archive('2025-01-01')

    const row = (accountId: string, month: string, over: Partial<ArchivedTotal>): ArchivedTotal => ({
      accountId, month, categoryId: null, transferAccountId: null, inflow: 0, outflow: 0, count: 0, currency: 'CAD', subLedgerId: null, ...over
    })
    expect(new Set(heard.shared!.removedTotals)).toEqual(new Set([
      row(chq.id, '2024-03', { categoryId: rent, inflow: 2000, outflow: 150000, count: 2 }),
      row(chq.id, '2024-03', { outflow: 700, count: 1 }),
      row(chq.id, '2024-04', { transferAccountId: sav.id, transferSubLedgerId: null, outflow: 30000, count: 1 }),
      row(sav.id, '2024-04', { transferAccountId: chq.id, transferSubLedgerId: null, inflow: 30000, count: 1 })
    ]))
    expect(heard.shared!.transactionIds).toContain(voided.id)     // removed, but not totalled
  })

  it('are worked out letting the event loop turn every so many transactions read', async () => {
    const turns: number[] = []
    const accounts = [{ id: 'A', currency: 'CAD', subLedgerId: null }] as unknown as LedgerData['accounts']
    const transactions = Array.from({ length: TOTALS_YIELD_EVERY * 2 + 10 }, (_, i) =>
      ({ id: `T${i}`, accountId: 'A', date: '2024-01-01', amount: -1, voided: false })) as unknown as LedgerData['transactions']
    const totals = await removedTotals({ accounts, transactions }, { remove: transactions.map(x => x.id) }, async () => { turns.push(turns.length) })
    expect(turns).toHaveLength(2)
    expect(totals).toEqual([{ accountId: 'A', month: '2024-01', categoryId: null, transferAccountId: null, inflow: 0, outflow: TOTALS_YIELD_EVERY * 2 + 10, count: TOTALS_YIELD_EVERY * 2 + 10, currency: 'CAD', subLedgerId: null }])
  })

  it('are right whatever order the plan lists its removals in', async () => {
    const accounts = [{ id: 'A', currency: 'CAD', subLedgerId: null }] as unknown as LedgerData['accounts']
    const transactions = ['2024-01-05', '2024-02-05', '2024-02-09', '2024-03-01'].map((date, i) =>
      ({ id: `T${i}`, accountId: 'A', date, amount: -(i + 1) * 100, voided: false, categoryId: 'C' })) as unknown as LedgerData['transactions']
    const totalsOf = async (remove: string[]) => (await removedTotals({ accounts, transactions }, { remove }, async () => {}))
      .map(t => [t.month, t.outflow, t.count]).sort()
    const expected = [['2024-01', 100, 1], ['2024-02', 500, 2]]
    expect(await totalsOf(['T0', 'T1', 'T2'])).toEqual(expected)       // in the transactions' order, as planArchive lists them
    expect(await totalsOf(['T2', 'T0', 'T1'])).toEqual(expected)       // in any other
    expect(await totalsOf([])).toEqual([])
  })
})

describe('the description and the plan', () => {
  it('describe a plan in the words the dialog shows', () => {
    const chq = account(), visa = account({ name: 'Visa', nameKey: 'visa' })
    const plan = planArchive(data([chq, visa], [txn(chq.id), txn(visa.id, { status: 'cleared' }), txn(visa.id, { status: 'uncleared' })]), '2025-01-01', { removeClosedAccounts: true })
    expect(describePlan(plan, [chq, visa])).toEqual({
      count: 1, summary: '1 transaction from 1 account',
      warnings: [{ message: `2 transactions before ${displayDate('2025-01-01')} aren’t reconciled, so they stay in the ledger.`, details: ['Visa 2', 'To archive them too, cancel, reconcile those accounts, and archive again.'] }]
    })
  })

  it('remove finished reconciliations before the date, but never an account\'s last', () => {
    const last = reconciliationDoc('', { statementDate: '2024-05-31' })
    const chq = account({ lastReconciled: { date: '2024-05-31', balance: 0, reconciliationId: last.id } })
    const recs = [
      reconciliationDoc(chq.id, { statementDate: '2024-01-31' }),
      { ...last, accountId: chq.id },
      reconciliationDoc(chq.id, { statementDate: '2025-01-31' }),
      reconciliationDoc(chq.id, { status: 'inProgress', activeFor: chq.id, statementDate: '2024-02-29' })
    ]
    const plan = planArchive(data([chq], [], recs), '2025-01-01', { removeClosedAccounts: true })
    expect(plan.removeReconciliations).toEqual([recs[0].id])
  })
})

// Types used only to describe the fixtures above
export type { Account }

// accounts-api 1.15: what an archive keeps as totals, so that reports and balances of the months archived don't change
// (docs/reporting-design.md, "Archived months").
describe('what the archive keeps: totals, and balances at past dates', () => {
  const ALL = { from: '2000-01-01', to: '2100-12-31', includeTransfers: true }
  /** Month ends from December 2021 to December 2026: every month a random ledger can hold. */
  const MONTH_ENDS = Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2022, i, 0)).toISOString().slice(0, 10))
  /** Totals added up by account, month, category or transfer account, and (for categories) payee when `byPayee`. */
  function sum(byPayee: boolean, ...lists: TransactionTotal[][]) {
    const all = new Map<string, [number, number, number]>()
    for (const t of lists.flat()) {
      const key = `${t.accountId}|${t.month}|${t.categoryId}|${t.transferAccountId}|${byPayee && t.transferAccountId === null ? t.payeeId ?? '' : ''}`
      const [inflow, outflow, count] = all.get(key) ?? [0, 0, 0]
      all.set(key, [inflow + t.inflow, outflow + t.outflow, count + t.count])
    }
    return all
  }
  const balanceMap = (points: { accountId: string, date: string, balance: number }[]) => new Map(points.map(p => [`${p.accountId}|${p.date}`, p.balance]))

  it('keeps every total, by payee too, and every balance at every month end, removed accounts included: on random ledgers', async () => {
    let archived = 0, removedAccounts = 0, withTransfers = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { service, archive, r } = await randomLedger(seed)
      const before = r.pick(['2023-01-01', '2024-01-01', '2024-07-01', '2025-01-01', '2026-01-01'])
      const label = `seed ${seed}, before ${before}`
      const was = { plain: await service.transactionTotals(ALL), byPayee: await service.transactionTotals({ ...ALL, byPayee: true }) }
      const balancesWere = await service.balanceHistory({ dates: MONTH_ENDS })
      const accountsWere = new Map((await service.list()).map(a => [a.id, a]))

      const outcome = await archive(before, { [REMOVE_CLOSED]: r.next() < 0.7 }).catch(err => err as { code: string })
      if ('code' in outcome) continue
      archived++

      // Live and archived together are what there was, without payees and with them
      const kept = await service.archivedTotals(ALL)
      expect(sum(false, await service.transactionTotals(ALL), kept), label).toEqual(sum(false, was.plain))
      expect(sum(true, await service.transactionTotals({ ...ALL, byPayee: true }), await service.archivedTotals({ ...ALL, byPayee: true })), label)
        .toEqual(sum(true, was.byPayee))
      // In the contract's order, each with where its account was and its name
      expect(kept, label).toEqual([...kept].sort(compareTotals))
      for (const t of kept) expect([t.currency, t.subLedgerId, t.accountName], label).toEqual([accountsWere.get(t.accountId)!.currency, accountsWere.get(t.accountId)!.subLedgerId, accountsWere.get(t.accountId)!.name])

      // Every balance at every month end is what it was, and so every total: an account the archive removed included
      const now = await service.balanceHistory({ dates: MONTH_ENDS })
      expect(balanceMap(now), label).toEqual(balanceMap(balancesWere))
      expect(now.every(p => p.exact), label).toBe(true)
      const gone = new Set(now.filter(p => p.removed).map(p => p.accountId))
      for (const id of gone) expect(accountsWere.has(id) && await service.get(id), label).toBeUndefined()
      if (gone.size > 0) removedAccounts++
      if (kept.some(t => t.transferAccountId !== null)) withTransfers++
    }
    // The generator reaches the cases: archives, removed accounts and archived transfers
    expect(archived).toBeGreaterThan(25)
    expect(removedAccounts).toBeGreaterThan(0)
    expect(withTransfers).toBeGreaterThan(0)
  })

  it('adds a second archive\'s totals to the month the first kept, in one document per account and month', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const chq = await service.createAccount(chequing({ openingDate: '2024-01-01' }))
    const food = (await service.categories.list()).find(c => c.name === 'Groceries')!.id
    const first = await t(chq.id).create({ date: '2024-03-05', amount: -1000, categoryId: food, payee: 'Metro' })
    const later = await t(chq.id).create({ date: '2024-03-20', amount: -400, categoryId: food, payee: 'Metro' })
    await reconcile(chq.id, [first.id])
    const was = await service.balanceHistory({ dates: ['2024-03-31'] })

    await archive('2025-01-01')
    await reconcile(chq.id, [later.id])
    await archive('2025-01-01')

    expect(await session.database('accounts').collection('accounts.archivedMonths').count()).toBe(1)
    expect(await service.archivedTotals({ ...ALL, byPayee: true })).toEqual([expect.objectContaining({ accountId: chq.id, month: '2024-03', categoryId: food, outflow: 1400, count: 2, payeeId: expect.any(String) })])
    expect(await service.balanceHistory({ dates: ['2024-03-31'] })).toEqual(was)
    expect((await service.get(chq.id))!.archived).toMatchObject({ count: 2, countWithTotals: 2 })
  })

  it('keeps nothing when the archive rolls back', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const chq = await service.createAccount(chequing())
    const old = await t(chq.id).create({ date: '2024-05-01', amount: -100 })
    await reconcile(chq.id, [old.id])
    session.participateInArchive('import', { describe: async () => undefined, archive: async () => { throw new Error('lines') } })

    expect(await rejection(archive('2025-01-01'))).toMatchObject({ code: 'ARCHIVE_FAILED' })

    expect(await service.archivedTotals(ALL)).toEqual([])
    for (const name of ['accounts.archivedMonths', 'accounts.archivedIds', 'accounts.archivedAccounts']) {
      expect(await session.database('accounts').collection(name).count(), name).toBe(0)
    }
  })

  it('gives no balance before an archive that kept no totals (as before 1.15), rather than a wrong one', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const chq = await service.createAccount(chequing({ openingDate: '2024-01-01', openingBalance: 5000 }))
    const old = await t(chq.id).create({ date: '2024-05-01', amount: -100 })
    await t(chq.id).create({ date: '2025-05-01', amount: -200 })
    await reconcile(chq.id, [old.id])
    await archive('2025-01-01')
    expect((await service.get(chq.id))!.archived).toMatchObject({ count: 1, countWithTotals: 1 })
    const dates = ['2024-12-31', '2025-06-30']
    expect((await service.balanceHistory({ dates })).map(p => [p.date, p.balance])).toEqual([['2024-12-31', 4900], ['2025-06-30', 4700]])

    // As an archive made before 1.15 left it: its count, but no totals
    const db = session.database('accounts')
    await db.collection('accounts.archivedMonths').deleteMany()
    await db.collection('accounts.accounts').updateOne({ id: chq.id }, { $unset: { 'archived.countWithTotals': true } })

    expect((await service.balanceHistory({ dates })).map(p => [p.date, p.balance])).toEqual([['2025-06-30', 4700]])
    expect(await service.archivedTotals(ALL)).toEqual([])
  })

  it('keeps what an account it removes needs: its name with its totals, and its balances, marked removed', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const chq = await service.createAccount(chequing({ openingDate: '2021-01-01' }))
    const visa = await service.createAccount(chequing({ name: 'Old Visa', type: 'creditCard', openingDate: '2021-01-01', openingBalance: -30000 }))
    const charge = await t(visa.id).create({ date: '2021-02-01', amount: -5000 })
    const paid = await t(chq.id).create({ date: '2021-06-30', amount: -35000, transferAccountId: visa.id })
    await reconcile(visa.id, [charge.id, (await t(visa.id).list()).find(x => x.transferId === paid.transferId)!.id])
    await reconcile(chq.id, [paid.id])
    await service.closeAccount(visa.id)
    const dates = ['2021-01-31', '2021-03-31', '2021-12-31']
    const was = await service.balanceHistory({ dates })

    await archive('2026-01-01')

    expect(await service.get(visa.id)).toBeUndefined()
    expect(await service.balanceHistory({ dates })).toEqual(was.map(p => p.accountId === visa.id ? { ...p, removed: true } : p))
    expect((await service.balanceHistory({ dates, accountIds: [visa.id] })).map(p => p.balance)).toEqual([-30000, -35000, 0])
    expect((await service.archivedTotals(ALL)).filter(r => r.accountId === visa.id).map(r => r.accountName)).toEqual(['Old Visa', 'Old Visa'])
    // What reports need to place it: its type and where it was, as well as its name
    expect(await service.removedAccounts()).toEqual([{
      id: visa.id, name: 'Old Visa', type: 'creditCard', currency: 'CAD', subLedgerId: null, openingDate: '2021-01-01',
      openingBalance: -30000, closedOn: '2026-11-04', removedBefore: '2026-01-01', complete: true
    }])
    expect(await session.database('accounts').collection('accounts.archivedAccounts').find()).toEqual([expect.objectContaining({
      accountId: visa.id, name: 'Old Visa', type: 'creditCard', currency: 'CAD', subLedgerId: null, openingDate: '2021-01-01',
      openingBalance: -30000, removedBefore: '2026-01-01', complete: true, closedOn: '2026-11-04'
    })])
  })

  it('moves what it kept with a deleted sub-ledger to the parent: months, transfers\' other side, and removed accounts', async () => {
    const { service, t, reconcile, archive, session } = await ledger()
    const home = await session.createSubLedger({ name: 'Home', parentId: null })
    const old = await session.createSubLedger({ name: 'Old', parentId: home.id })
    const chq = await service.createAccount(chequing({ openingDate: '2021-01-01' }))
    const gone = await service.createAccount(chequing({ name: 'Old Savings', type: 'savings', subLedgerId: old.id, openingDate: '2021-01-01', openingBalance: 0 }))
    const moved = await t(chq.id).create({ date: '2021-03-01', amount: -2500, transferAccountId: gone.id })
    const back = await t(gone.id).create({ date: '2021-09-01', amount: -2500, transferAccountId: chq.id })
    await reconcile(chq.id, (await t(chq.id).list()).map(x => x.id))
    await reconcile(gone.id, (await t(gone.id).list()).map(x => x.id))
    void moved; void back
    await service.closeAccount(gone.id)
    await archive('2026-01-01')
    const kept = () => service.archivedTotals(ALL)
    expect((await kept()).filter(r => r.accountId === chq.id).map(r => r.transferSubLedgerId)).toEqual([old.id, old.id])

    await session.deleteSubLedger(old.id)

    expect((await kept()).filter(r => r.accountId === chq.id).map(r => r.transferSubLedgerId)).toEqual([home.id, home.id])
    expect((await kept()).filter(r => r.accountId === gone.id).map(r => r.subLedgerId)).toEqual([home.id, home.id])
    expect(await session.database('accounts').collection('accounts.archivedAccounts').find()).toEqual([expect.objectContaining({ accountId: gone.id, subLedgerId: home.id })])
  })
})
