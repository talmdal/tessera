// @vitest-environment node
// What accounts.service gives importers: a bank line's id on transactions (externalId), adding many transactions at
// once, finding lines imported before, and matching a bank line to a transaction the user entered, or taking it off
// again. Each write is all or nothing, and announced once. See docs/import-manager-design.md, "Changes to accounts".
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transaction, TransactionDraft } from '@tessera/accounts-api'
import { KitCollection } from '../../../packages/storage-kit/collection'
import { translate } from '../../../plugins/accounts/src/privileged/store'
import { chequing, rejection, setupAccounts } from './harness'

/** An open ledger with Chequing (1,000.00) and Savings, both CAD, and a closed account. */
async function ledger() {
  const env = await setupAccounts()
  const chq = await env.service.createAccount(chequing())
  const sav = await env.service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
  const old = await env.service.createAccount(chequing({ name: 'Old', type: 'savings', openingBalance: 0 }))
  await env.service.closeAccount(old.id)
  const categories = await env.service.categories.list()
  env.changes.length = 0
  return { ...env, chq, sav, old, categories, t: (id: string) => env.service.transactions(id) }
}

const line = (over: Partial<TransactionDraft> = {}): TransactionDraft =>
  ({ date: '2026-10-06', amount: -8412, payee: 'COSTCO WHSE #0123', externalId: 'FIT-1', status: 'electronic', ...over })

/** Everything about a transaction that a failed write must leave as it was. */
const sameAs = (t: Transaction) => ({ id: t.id, date: t.date, amount: t.amount, status: t.status, externalId: t.externalId, rev: t.rev })

afterEach(() => { vi.restoreAllMocks() })

describe("a transaction's bank line id", () => {
  it('is kept with the transaction, and through an ordinary edit', async () => {
    const { t, chq } = await ledger()
    const created = await t(chq.id).create(line())
    expect(created.externalId).toBe('FIT-1')
    expect((await t(chq.id).get(created.id))?.externalId).toBe('FIT-1')

    const edited = await t(chq.id).update(created.id, { memo: 'Groceries for the week' })
    expect(edited.externalId).toBe('FIT-1')
  })

  it('is set by a patch, and cleared by null', async () => {
    const { t, chq } = await ledger()
    const created = await t(chq.id).create({ date: '2026-10-05', amount: -8400, payee: 'Costco' })
    expect(created.externalId).toBeUndefined()
    expect((await t(chq.id).update(created.id, { externalId: 'FIT-9' })).externalId).toBe('FIT-9')
    expect((await t(chq.id).update(created.id, { externalId: null })).externalId).toBeUndefined()
  })

  it('is unique in the account, but the same line may be in another account', async () => {
    const { t, chq, sav } = await ledger()
    await t(chq.id).create(line())
    const err = await rejection(t(chq.id).create(line({ amount: -100 })))
    expect(err).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID', field: 'externalId' })
    expect(err.message).toContain('2026-10-06')
    await expect(t(sav.id).create(line())).resolves.toMatchObject({ externalId: 'FIT-1' })

    const other = await t(chq.id).create(line({ externalId: 'FIT-2' }))
    expect(await rejection(t(chq.id).update(other.id, { externalId: 'FIT-1' }))).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID' })
  })

  it('is exactly what the bank sent: not trimmed, not empty, not too long, no control characters', async () => {
    const { t, chq } = await ledger()
    expect((await t(chq.id).create(line({ externalId: ' FIT 1 ' }))).externalId).toBe(' FIT 1 ')
    await expect(t(chq.id).create(line({ externalId: 'x'.repeat(255) }))).resolves.toBeDefined()
    for (const externalId of ['', 'x'.repeat(256), 'FIT\n1', 42 as unknown as string]) {
      expect(await rejection(t(chq.id).create(line({ externalId }))), JSON.stringify(externalId)).toMatchObject({ code: 'INVALID', field: 'externalId' })
    }
  })

  it("stays on its own side of a transfer: the other side is another account's line", async () => {
    const { t, chq, sav } = await ledger()
    const created = await t(chq.id).create(line({ transferAccountId: sav.id, payee: undefined }))
    const [other] = await t(sav.id).list()
    expect(created.externalId).toBe('FIT-1')
    expect(other.externalId).toBeUndefined()
  })

  it('is reported as a duplicate bank line, not a duplicate name, should storage catch it first', () => {
    const storage = (index: string) => Object.assign(new Error(`unique index "${index}" already has a document with accountId, externalId = x`), { code: 'UNIQUE_VIOLATION' })
    expect(translate(storage('uniqueExternalId'))).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID', field: 'externalId' })
    expect(translate(storage('uniqueName'))).toMatchObject({ code: 'DUPLICATE_NAME', field: 'name' })
  })
})

describe('createMany', () => {
  it('adds every transaction at once, in order, announced once', async () => {
    const { t, chq, changes } = await ledger()
    const drafts = Array.from({ length: 500 }, (_, i) => line({ externalId: `FIT-${i}`, amount: -(i + 1), date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}` }))

    const created = await t(chq.id).createMany(drafts)

    expect(created.map(c => c.externalId)).toEqual(drafts.map(d => d.externalId))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ transactions: [chq.id], balances: [chq.id] })
    expect((await t(chq.id).balances()).current).toBe(100000 - (500 * 501) / 2)
  })

  it('adds nothing when any draft is wrong, and names the draft', async () => {
    const { t, chq, changes } = await ledger()
    const drafts = [line({ externalId: 'A' }), line({ externalId: 'B' }), line({ externalId: 'C' }), line({ externalId: 'D', date: '2026-02-30' })]

    expect(await rejection(t(chq.id).createMany(drafts))).toMatchObject({ code: 'INVALID', field: 'drafts[3].date' })
    expect(await t(chq.id).list()).toEqual([])
    expect(changes).toEqual([])
  })

  it("names the draft for what is only found while writing, such as a category that doesn't exist", async () => {
    const { t, chq } = await ledger()
    const drafts = [line({ externalId: 'A' }), line({ externalId: 'B' }), line({ externalId: 'C', categoryId: 'no-such-category' })]
    expect(await rejection(t(chq.id).createMany(drafts))).toMatchObject({ code: 'NOT_FOUND', field: 'drafts[2].category' })
    expect(await t(chq.id).list()).toEqual([])
  })

  it('refuses the same bank line twice, whether in the list or already in the account', async () => {
    const { t, chq } = await ledger()
    const inList = await rejection(t(chq.id).createMany([line({ externalId: 'A' }), line({ externalId: 'B' }), line({ externalId: 'A' })]))
    expect(inList).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID', field: 'drafts[2].externalId' })
    expect(inList.message).toBe('Transactions 1 and 3 are the same bank line.')

    await t(chq.id).create(line({ externalId: 'B' }))
    expect(await rejection(t(chq.id).createMany([line({ externalId: 'A' }), line({ externalId: 'B' })])))
      .toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID', field: 'drafts[1].externalId' })
    expect(await t(chq.id).list()).toHaveLength(1)
  })

  it('creates a new payee once, however many lines name it', async () => {
    const { t, chq, service } = await ledger()
    await t(chq.id).createMany([line({ externalId: 'A' }), line({ externalId: 'B', payee: 'costco whse #0123' }), line({ externalId: 'C' })])
    expect((await service.payees.search('costco')).map(p => p.name)).toEqual(['COSTCO WHSE #0123'])
  })

  it('refuses reconciled lines and closed accounts, and does nothing for an empty list', async () => {
    const { t, chq, old, changes } = await ledger()
    expect(await rejection(t(chq.id).createMany([line(), line({ externalId: 'B', status: 'reconciled' })])))
      .toMatchObject({ code: 'INVALID', field: 'drafts[1].status' })
    expect(await rejection(t(old.id).createMany([line()]))).toMatchObject({ code: 'ACCOUNT_CLOSED' })
    expect(await rejection(t(old.id).createMany([]))).toMatchObject({ code: 'ACCOUNT_CLOSED' })
    await expect(t(chq.id).createMany([])).resolves.toEqual([])
    expect(changes).toEqual([])
  })
})

describe('findByExternalIds', () => {
  it("finds this account's lines among the ids, in register order", async () => {
    const { t, chq, sav } = await ledger()
    await t(chq.id).createMany([line({ externalId: 'B', date: '2026-10-09' }), line({ externalId: 'A', date: '2026-10-01' }), line({ externalId: 'C' })])
    await t(sav.id).create(line({ externalId: 'D' }))

    const found = await t(chq.id).findByExternalIds(['A', 'B', 'D', 'nope', 'A'])
    expect(found.map(f => f.externalId)).toEqual(['A', 'B'])
    await expect(t(chq.id).findByExternalIds([])).resolves.toEqual([])
    expect(await rejection(t(chq.id).findByExternalIds('A' as unknown as string[]))).toMatchObject({ code: 'INVALID', field: 'ids' })
    expect(await rejection(t('no-such-account').findByExternalIds(['A']))).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('match', () => {
  /** What the user typed: Costco, a day earlier, 84.00; the bank says 84.12 on the 6th. */
  async function entered() {
    const env = await ledger()
    const mine = await env.t(env.chq.id).create({ date: '2026-10-05', amount: -8400, payee: 'Costco', memo: 'Weekly shop' })
    env.changes.length = 0
    return { ...env, mine }
  }

  it("takes the bank's id, date and amount, marks it electronically cleared, and keeps the user's payee and memo", async () => {
    const { t, chq, mine, changes } = await entered()

    const matched = await t(chq.id).match(mine.id, { externalId: 'FIT-1', date: '2026-10-06', amount: -8412 })

    expect(matched).toMatchObject({ id: mine.id, externalId: 'FIT-1', date: '2026-10-06', amount: -8412, status: 'electronic', memo: 'Weekly shop' })
    expect((await t(chq.id).register()).rows[0].payeeName).toBe('Costco')
    expect(changes).toHaveLength(1)
  })

  it("keeps a cleared mark, which is the user's, and takes a status it is given", async () => {
    const { t, chq, mine } = await entered()
    await t(chq.id).setStatus([mine.id], 'cleared')
    expect((await t(chq.id).match(mine.id, { externalId: 'FIT-1' })).status).toBe('cleared')

    const other = await t(chq.id).create({ date: '2026-10-07', amount: -100 })
    expect((await t(chq.id).match(other.id, { externalId: 'FIT-2', status: 'uncleared' })).status).toBe('uncleared')
    expect(await rejection(t(chq.id).match(other.id, { externalId: 'FIT-2', status: 'reconciled' }))).toMatchObject({ code: 'INVALID', field: 'status' })
  })

  it('replaces the transaction the same line was added as, in one step', async () => {
    const { t, chq, mine, changes } = await entered()
    const added = await t(chq.id).create(line())          // imported as new before the user matched it
    changes.length = 0

    const matched = await t(chq.id).match(mine.id, { externalId: 'FIT-1', date: '2026-10-06', amount: -8412, replaces: added.id })

    expect(matched.externalId).toBe('FIT-1')
    expect((await t(chq.id).list()).map(x => x.id)).toEqual([mine.id])
    expect(changes).toHaveLength(1)
  })

  it('leaves everything as it was if it fails after deleting the replaced transaction', async () => {
    const { t, chq, mine, changes } = await entered()
    const added = await t(chq.id).create(line())
    changes.length = 0
    // The match deletes the replaced transaction, then rewrites the matched one: make that second write fail
    vi.spyOn(KitCollection.prototype, 'replace').mockRejectedValueOnce(new Error('disk full'))

    await expect(t(chq.id).match(mine.id, { externalId: 'FIT-1', replaces: added.id })).rejects.toThrow('disk full')

    const after = await t(chq.id).list()
    expect(after.map(sameAs)).toEqual([sameAs(mine), sameAs(added)])
    expect(changes).toEqual([])
  })

  it('replaces only the transaction that carries the same bank line', async () => {
    const { t, chq, mine } = await entered()
    const unrelated = await t(chq.id).create(line({ externalId: 'FIT-OTHER' }))
    const typed = await t(chq.id).create({ date: '2026-10-06', amount: -500 })

    for (const replaces of [unrelated.id, typed.id, mine.id]) {
      expect(await rejection(t(chq.id).match(mine.id, { externalId: 'FIT-1', replaces })), replaces).toMatchObject({ code: 'INVALID', field: 'replaces' })
    }
    expect(await rejection(t(chq.id).match(mine.id, { externalId: 'FIT-1', replaces: 'gone' }))).toMatchObject({ code: 'NOT_FOUND', field: 'replaces' })
    expect(await t(chq.id).list()).toHaveLength(3)
  })

  it("moves both sides of a transfer to the bank's date and amount, and only this side takes the line", async () => {
    const { t, chq, sav } = await ledger()
    const out = await t(chq.id).create({ date: '2026-10-05', amount: -20000, transferAccountId: sav.id })

    await t(chq.id).match(out.id, { externalId: 'FIT-T', date: '2026-10-06', amount: -20050 })

    const [other] = await t(sav.id).list()
    expect(other).toMatchObject({ date: '2026-10-06', amount: 20050 })
    expect(other.externalId).toBeUndefined()
  })

  it('asks before changing a transfer whose other side is reconciled, and goes ahead when confirmed', async () => {
    const { t, chq, sav } = await ledger()
    const out = await t(chq.id).create({ date: '2026-10-05', amount: -20000, transferAccountId: sav.id })
    const [other] = await t(sav.id).list()
    await t(sav.id).setStatus([other.id], 'reconciled', { confirm: ['reconciled'] })

    const err = await rejection(t(chq.id).match(out.id, { externalId: 'FIT-T', amount: -20050 }))
    expect(err).toMatchObject({ code: 'CONFIRMATION_REQUIRED', reasons: ['reconciled'] })
    expect((await t(chq.id).get(out.id))?.externalId).toBeUndefined()

    await expect(t(chq.id).match(out.id, { externalId: 'FIT-T', amount: -20050 }, { confirm: ['reconciled'] }))
      .resolves.toMatchObject({ externalId: 'FIT-T', amount: -20050 })
  })

  it("refuses a closed account, a void transaction, one matched to another line, and a changed revision", async () => {
    const { t, chq, mine, service } = await entered()
    const void_ = await t(chq.id).create({ date: '2026-10-07', amount: -100 })
    await t(chq.id).setVoided([void_.id], true)
    expect(await rejection(t(chq.id).match(void_.id, { externalId: 'FIT-V' }))).toMatchObject({ code: 'INVALID', field: 'id' })

    await t(chq.id).match(mine.id, { externalId: 'FIT-1' })
    expect(await rejection(t(chq.id).match(mine.id, { externalId: 'FIT-2' }))).toMatchObject({ code: 'INVALID', field: 'id' })
    await expect(t(chq.id).match(mine.id, { externalId: 'FIT-1' })).resolves.toMatchObject({ externalId: 'FIT-1' })   // the same line again

    const fresh = await t(chq.id).create({ date: '2026-10-08', amount: -100 })
    expect(await rejection(t(chq.id).match(fresh.id, { externalId: 'FIT-3' }, { expectedRev: fresh.rev + 1 }))).toMatchObject({ code: 'CONFLICT' })
    expect(await rejection(t(chq.id).match(fresh.id, { externalId: 'FIT-1' }))).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID' })

    await service.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect(await rejection(t(chq.id).match(fresh.id, { externalId: 'FIT-3' }))).toMatchObject({ code: 'ACCOUNT_CLOSED' })
  })

  it('checks what the bank line brings', async () => {
    const { t, chq, mine } = await entered()
    expect(await rejection(t(chq.id).match(mine.id, { externalId: '' }))).toMatchObject({ code: 'INVALID', field: 'externalId' })
    expect(await rejection(t(chq.id).match(mine.id, { externalId: 'F', date: '06/10/2026' }))).toMatchObject({ code: 'INVALID', field: 'date' })
    expect(await rejection(t(chq.id).match(mine.id, { externalId: 'F', amount: 84.12 }))).toMatchObject({ code: 'INVALID', field: 'amount' })
  })
})

describe('unmatch', () => {
  /** Costco, typed as 84.00 on the 5th, then matched to the bank's 84.12 on the 6th. */
  async function matched() {
    const env = await ledger()
    const mine = await env.t(env.chq.id).create({ date: '2026-10-05', amount: -8400, payee: 'Costco' })
    const after = await env.t(env.chq.id).match(mine.id, { externalId: 'FIT-1', date: '2026-10-06', amount: -8412 })
    env.changes.length = 0
    return { ...env, mine, after }
  }

  it('takes the line off, putting back only what it is given', async () => {
    const { t, chq, mine, changes } = await matched()

    const { transaction, added } = await t(chq.id).unmatch(mine.id, { restore: { amount: -8400, status: 'uncleared' } })

    expect(transaction).toMatchObject({ id: mine.id, amount: -8400, status: 'uncleared', date: '2026-10-06' })
    expect(transaction.externalId).toBeUndefined()
    expect(added).toBeUndefined()
    expect(changes).toHaveLength(1)
  })

  it("gives the line a transaction of its own, which takes over its id, and undoes a match exactly", async () => {
    const { t, chq, mine } = await matched()

    const { transaction, added } = await t(chq.id).unmatch(mine.id, {
      restore: { date: mine.date, amount: mine.amount, status: mine.status },
      add: line({ externalId: undefined })
    })

    expect({ ...transaction, rev: 0, updatedAt: '' }).toEqual({ ...mine, rev: 0, updatedAt: '' })
    expect(added).toMatchObject({ externalId: 'FIT-1', amount: -8412, status: 'electronic' })
    expect((await t(chq.id).findByExternalIds(['FIT-1'])).map(f => f.id)).toEqual([added!.id])
  })

  it('leaves everything as it was if it fails after taking the line off', async () => {
    const { t, chq, after, changes } = await matched()
    // The unmatch rewrites the matched transaction, then adds the line's own: make that second write fail
    vi.spyOn(KitCollection.prototype, 'insertMany').mockRejectedValueOnce(new Error('disk full'))

    await expect(t(chq.id).unmatch(after.id, { restore: { amount: -8400 }, add: line({ payee: undefined }) })).rejects.toThrow('disk full')

    expect((await t(chq.id).list()).map(sameAs)).toEqual([sameAs(after)])
    expect(changes).toEqual([])
  })

  it('puts a transfer back on both sides, asking first when the other side is reconciled', async () => {
    const { t, chq, sav } = await ledger()
    const out = await t(chq.id).create({ date: '2026-10-05', amount: -20000, transferAccountId: sav.id })
    await t(chq.id).match(out.id, { externalId: 'FIT-T', date: '2026-10-06', amount: -20050 })
    const [other] = await t(sav.id).list()
    await t(sav.id).setStatus([other.id], 'reconciled', { confirm: ['reconciled'] })

    const restore = { date: '2026-10-05', amount: -20000 }
    expect(await rejection(t(chq.id).unmatch(out.id, { restore }))).toMatchObject({ code: 'CONFIRMATION_REQUIRED', reasons: ['reconciled'] })
    await t(chq.id).unmatch(out.id, { restore }, { confirm: ['reconciled'] })

    expect((await t(sav.id).list())[0]).toMatchObject({ date: '2026-10-05', amount: 20000 })
  })

  it('refuses a transaction with no line, a different id for the new one, and names what is wrong', async () => {
    const { t, chq, mine } = await matched()
    const plain = await t(chq.id).create({ date: '2026-10-07', amount: -100 })
    expect(await rejection(t(chq.id).unmatch(plain.id, {}))).toMatchObject({ code: 'INVALID', field: 'id' })
    expect(await rejection(t(chq.id).unmatch(mine.id, { add: line({ externalId: 'FIT-2' }) }))).toMatchObject({ code: 'INVALID', field: 'add.externalId' })
    expect(await rejection(t(chq.id).unmatch(mine.id, { restore: { amount: 1.5 } }))).toMatchObject({ code: 'INVALID', field: 'restore.amount' })
    expect(await rejection(t(chq.id).unmatch(mine.id, { add: line({ date: 'soon' }) }))).toMatchObject({ code: 'INVALID', field: 'add.date' })
    expect((await t(chq.id).get(mine.id))?.externalId).toBe('FIT-1')
  })
})
