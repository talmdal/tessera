// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { STATEMENT_RECONCILER } from '@tessera/accounts-api'
import { file } from '../book/harness'
import { chequing, rejection, setupAccounts } from './harness'

/**
 * Chequing opens at 1,000.00 on 2026-01-01. In October: Metro −50.25 (cleared already), Hydro −80.00, Rent −1,200.00
 * (voided), and a −20.00 cheque dated after the statement (2026-11-02).
 */
async function book() {
  const env = await setupAccounts()
  const chq = await env.service.createAccount(chequing())
  const t = env.service.transactions(chq.id)
  const metro = await t.create({ date: '2026-10-02', amount: -5025, payee: 'Metro', status: 'cleared' })
  const hydro = await t.create({ date: '2026-10-05', amount: -8000, payee: 'Hydro' })
  const rent = await t.create({ date: '2026-10-01', amount: -120000, payee: 'Landlord' })
  await t.setVoided([rent.id], true)
  const later = await t.create({ date: '2026-11-02', amount: -2000, payee: 'Cheque', number: '104' })
  env.changes.length = 0
  const r = env.service.reconciliation
  const statement = (statementBalance: number, over: object = {}) =>
    ({ statementDate: '2026-10-31', startingBalance: 100000, statementBalance, reconcilerId: STATEMENT_RECONCILER, ...over })
  return { ...env, chq, t, r, metro, hydro, rent, later, statement }
}

describe('reconciling an account', () => {
  it('begins with the unreconciled, non-void transactions, the later-dated flagged, and the running figures', async () => {
    const { r, chq, statement, metro, hydro, later, changes } = await book()
    const state = await r.begin(chq.id, statement(86975))
    expect(state.reconciliation).toMatchObject({ accountId: chq.id, statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86975, paused: false, reconcilerId: STATEMENT_RECONCILER })
    expect(state.candidates.map(c => [c.transaction.id, c.marked, c.afterStatement, c.payeeName])).toEqual([
      [metro.id, true, false, 'Metro'], [hydro.id, false, false, 'Hydro'], [later.id, false, true, 'Cheque']
    ])
    // Metro is already cleared, so it counts: 1,000.00 − 50.25 leaves 869.75 − 949.75 = −80.00 to find
    expect(state.summary).toEqual({ starting: 100000, marked: -5025, markedCount: 1, difference: -8000, lastReconciledBalance: 100000, adjustment: -8000 })
    expect(changes.at(-1)!.reconciliations).toEqual([chq.id])
    await expect(r.get(chq.id)).resolves.toMatchObject({ reconciliation: { id: state.reconciliation.id } })
  })

  it('marks and unmarks, saving each mark at once as the cleared status', async () => {
    const { r, t, chq, statement, hydro, metro } = await book()
    await r.begin(chq.id, statement(86975))
    const marked = await r.mark(chq.id, [hydro.id], true)
    expect(marked.summary).toMatchObject({ marked: -13025, markedCount: 2, difference: 0, adjustment: 0 })
    expect((await t.get(hydro.id))!.status).toBe('cleared')

    const unmarked = await r.mark(chq.id, [metro.id], false)
    expect(unmarked.summary.markedCount).toBe(1)
    expect((await t.get(metro.id))!.status).toBe('uncleared')
  })

  it('refuses to mark what isn\'t a candidate, or without a reconciliation under way', async () => {
    const { r, chq, statement, rent, hydro } = await book()
    expect((await rejection(r.mark(chq.id, [hydro.id], true))).code).toBe('NOT_FOUND')
    await r.begin(chq.id, statement(0))
    expect((await rejection(r.mark(chq.id, [rent.id], true))).code).toBe('INVALID')
    expect((await rejection(r.mark(chq.id, ['nope'], true))).code).toBe('NOT_FOUND')
  })

  it('checks the statement\'s figures', async () => {
    const { r, chq, statement } = await book()
    expect((await rejection(r.begin(chq.id, statement(1, { statementDate: '2026-02-30' })))).field).toBe('statementDate')
    expect((await rejection(r.begin(chq.id, statement(1.5)))).field).toBe('statementBalance')
    expect((await rejection(r.begin(chq.id, statement(1, { startingBalance: 'x' })))).field).toBe('startingBalance')
  })

  it('completes: the marked become reconciled, and the account records the statement', async () => {
    const { r, t, chq, statement, hydro, metro, later, service } = await book()
    await r.begin(chq.id, statement(86975))
    await r.mark(chq.id, [hydro.id], true)
    const result = await r.finish(chq.id)
    expect(result).toEqual({ reconciledCount: 2 })
    expect([(await t.get(metro.id))!.status, (await t.get(hydro.id))!.status, (await t.get(later.id))!.status]).toEqual(['reconciled', 'reconciled', 'uncleared'])
    expect((await service.get(chq.id))!.lastReconciled).toMatchObject({ date: '2026-10-31', balance: 86975 })
    expect((await service.balances(chq.id)).reconciled).toBe(86975)
    await expect(r.get(chq.id)).resolves.toBeUndefined()

    // The next statement starts where this one ended, and lists only what is left
    const next = await r.begin(chq.id, statement(84975, { statementDate: '2026-11-30', startingBalance: 86975 }))
    expect(next.candidates.map(c => c.transaction.id)).toEqual([later.id])
    expect(next.summary).toMatchObject({ lastReconciledBalance: 86975, difference: 0 - 2000, adjustment: -2000 })

    // Finished reconciliations keep their records without counting as under way
    await r.mark(chq.id, [later.id], true)
    await r.finish(chq.id)
    await expect(r.begin(chq.id, statement(84975, { statementDate: '2026-12-31', startingBalance: 84975 }))).resolves.toBeDefined()
  })

  it('asks before adding a balance adjustment, then adds a reconciled one on the statement date', async () => {
    const { r, t, chq, statement, service } = await book()
    await r.begin(chq.id, statement(85000))
    const err = await rejection(r.finish(chq.id))
    expect(err.code).toBe('CONFIRMATION_REQUIRED')
    expect(err.reasons).toEqual(['adjustBalance'])
    expect(err.message).toMatch(/differ by -\S*99\.75/)
    // Still under way: nothing changed
    await expect(r.get(chq.id)).resolves.toBeDefined()

    const result = await r.finish(chq.id, { confirm: ['adjustBalance'] })
    expect(result.adjustment).toMatchObject({ date: '2026-10-31', amount: -9975, status: 'reconciled', memo: 'Reconciliation adjustment' })
    expect((await service.payees.search('Balance')).map(p => p.name)).toEqual(['Balance adjustment'])
    expect((await service.balances(chq.id)).reconciled).toBe(85000)
    expect((await t.list()).filter(x => x.status === 'reconciled')).toHaveLength(2)
  })

  it('adjusts for a statement that starts elsewhere than the records, even when its own arithmetic balances', async () => {
    const { r, chq, statement, hydro } = await book()
    // The statement starts at 990.00, not 1,000.00; its own figures add up, so the difference is zero…
    const state = await r.begin(chq.id, statement(85975, { startingBalance: 99000 }))
    const marked = await r.mark(chq.id, [hydro.id], true)
    expect(marked.summary).toMatchObject({ difference: 0, adjustment: -1000 })
    // …but the book would then disagree with the statement, so completing still needs the adjustment
    expect((await rejection(r.finish(chq.id))).reasons).toEqual(['adjustBalance'])
    expect(state.summary.lastReconciledBalance).toBe(100000)
  })

  it('pauses, keeping the marks, and resumes with new figures', async () => {
    const { r, t, chq, statement, hydro, session, changes } = await book()
    const begun = await r.begin(chq.id, statement(86975))
    await r.mark(chq.id, [hydro.id], true)
    await r.pause(chq.id)
    expect((await r.get(chq.id))!.reconciliation.paused).toBe(true)
    expect((await t.get(hydro.id))!.status).toBe('cleared')
    expect(changes.at(-1)!.reconciliations).toEqual([chq.id])

    // A paused reconciliation survives closing the book
    await session.close()
    await session.open(file('Home.tessera'))
    const resumed = await r.begin(chq.id, statement(86000))
    expect(resumed.reconciliation).toMatchObject({ id: begun.reconciliation.id, paused: false, statementBalance: 86000 })
    expect(resumed.summary.markedCount).toBe(2)
  })

  it('cancels, putting back the statuses it changed, and only those', async () => {
    const { r, t, chq, statement, hydro, metro, later } = await book()
    await r.begin(chq.id, statement(0))
    await r.mark(chq.id, [hydro.id], true)
    await r.mark(chq.id, [metro.id], false)
    await r.mark(chq.id, [metro.id], true)
    // Marked by hand outside the reconciliation: not the reconciliation's to undo
    await t.setStatus([later.id], 'electronic')
    await r.cancel(chq.id)
    expect([(await t.get(metro.id))!.status, (await t.get(hydro.id))!.status, (await t.get(later.id))!.status]).toEqual(['cleared', 'uncleared', 'electronic'])
    await expect(r.get(chq.id)).resolves.toBeUndefined()
    expect((await rejection(r.cancel(chq.id))).code).toBe('NOT_FOUND')
  })

  it('keeps one reconciliation per account, and none for a closed account', async () => {
    const { r, chq, statement, service } = await book()
    const first = await r.begin(chq.id, statement(1))
    const again = await r.begin(chq.id, statement(2))
    expect(again.reconciliation.id).toBe(first.reconciliation.id)

    const savings = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    await service.closeAccount(savings.id)
    expect((await rejection(r.begin(savings.id, statement(0)))).code).toBe('ACCOUNT_CLOSED')
  })

  it('follows changes to its transactions: a corrected amount, a void', async () => {
    const { r, t, chq, statement, hydro } = await book()
    await r.begin(chq.id, statement(86975))
    await r.mark(chq.id, [hydro.id], true)
    await t.update(hydro.id, { amount: -8215 })
    expect((await r.get(chq.id))!.summary).toMatchObject({ marked: -13240, difference: 215 })
    await t.setVoided([hydro.id], true)
    const state = (await r.get(chq.id))!
    expect(state.candidates.map(c => c.transaction.id)).not.toContain(hydro.id)
    expect(state.summary.markedCount).toBe(1)
  })

  it('adds the statement\'s service charge and interest as marked transactions, in one go', async () => {
    const { r, t, chq, statement, service, changes } = await book()
    const categories = await service.categories.list()
    const fees = categories.find(c => c.name === 'Bank fees')!
    const state = await r.begin(chq.id, statement(86975, {
      serviceCharge: { amount: 495, date: '2026-10-31', categoryId: fees.id },
      interest: { amount: 12, date: '2026-10-30' }
    }))
    const added = state.reconciliation.addedIds
    expect(added).toHaveLength(2)
    const [fee, interest] = await Promise.all(added.map(id => t.get(id)))
    expect(fee).toMatchObject({ amount: -495, date: '2026-10-31', status: 'cleared', categoryId: fees.id })
    expect(interest).toMatchObject({ amount: 12, date: '2026-10-30', status: 'cleared' })
    expect((await service.payees.search('')).map(p => p.name)).toEqual(expect.arrayContaining(['Service charge', 'Interest']))
    // Metro (−50.25), the fee (−4.95) and the interest (+0.12) are marked
    expect(state.summary).toMatchObject({ markedCount: 3, marked: -5025 - 495 + 12 })
    expect(changes.at(-1)).toMatchObject({ transactions: [chq.id], balances: [chq.id], reconciliations: [chq.id] })
  })

  it('signs interest on a liability as more owed', async () => {
    const { r, service, statement } = await book()
    const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: -54000 }))
    const state = await r.begin(visa.id, statement(-60000, { startingBalance: -54000, interest: { amount: 1250, date: '2026-10-31' } }))
    expect((await service.transactions(visa.id).get(state.reconciliation.addedIds[0]))!.amount).toBe(-1250)
  })

  it('checks the charges, adding nothing when one is wrong', async () => {
    const { r, t, chq, statement } = await book()
    const before = (await t.list()).length
    expect((await rejection(r.begin(chq.id, statement(0, { serviceCharge: { amount: -5, date: '2026-10-31' } })))).field).toBe('serviceCharge')
    expect((await rejection(r.begin(chq.id, statement(0, { interest: { amount: 5, date: 'soon' } })))).field).toBe('interest')
    const err = await rejection(r.begin(chq.id, statement(0, { serviceCharge: { amount: 5, date: '2026-10-31' }, interest: { amount: 5, date: '2026-10-31', categoryId: 'gone' } })))
    expect([err.code, err.field]).toEqual(['NOT_FOUND', 'interest'])
    // All or nothing: the valid service charge wasn't kept either, nor a reconciliation begun
    expect((await t.list()).length).toBe(before)
    await expect(r.get(chq.id)).resolves.toBeUndefined()
    // Zero is no charge
    const state = await r.begin(chq.id, statement(0, { serviceCharge: { amount: 0, date: '2026-10-31' } }))
    expect(state.reconciliation.addedIds).toEqual([])
  })

  it('adds more charges on resuming, and deletes every one it added on cancelling', async () => {
    const { r, t, chq, statement, metro } = await book()
    await r.begin(chq.id, statement(0, { serviceCharge: { amount: 495, date: '2026-10-31' } }))
    await r.pause(chq.id)
    const resumed = await r.begin(chq.id, statement(0, { interest: { amount: 12, date: '2026-10-31' } }))
    expect(resumed.reconciliation.addedIds).toHaveLength(2)
    // Unmarking one it added doesn't keep it
    await r.mark(chq.id, [resumed.reconciliation.addedIds[0]], false)
    await r.cancel(chq.id)
    const left = await t.list()
    expect(left.some(x => resumed.reconciliation.addedIds.includes(x.id))).toBe(false)
    expect(left.find(x => x.id === metro.id)!.status).toBe('cleared')
  })

  it('keeps the charges it added when completed, reconciled', async () => {
    const { r, t, chq, statement } = await book()
    // 1,000.00 − 50.25 (Metro) − 4.95 = 944.80
    const state = await r.begin(chq.id, statement(94480, { serviceCharge: { amount: 495, date: '2026-10-31' } }))
    expect(state.summary.difference).toBe(0)
    await r.finish(chq.id)
    expect((await t.get(state.reconciliation.addedIds[0]))!.status).toBe('reconciled')
  })

  it('goes when its account is deleted', async () => {
    const { r, chq, statement, service } = await book()
    await r.begin(chq.id, statement(0))
    await service.deleteAccount(chq.id)
    const again = await service.createAccount(chequing())
    await expect(r.get(again.id)).resolves.toBeUndefined()
  })
})
