// @vitest-environment node
// What the accounts plugin says archiving would remove: the rules, the per-account rows, and the warnings the user
// sees before agreeing. See docs/archive-design.md, "What is removable" and "Moving the opening balance".
import { describe, expect, it } from 'vitest'
import type { ArchiveRequest } from '@tessera/book-api'
import { collectionsOf } from '../../../plugins/accounts/src/privileged/store'
import { newOpeningDate, planAccountsArchive } from '../../../plugins/accounts/src/privileged/archiveCore'
import { chequing, setupAccounts } from './harness'

const BEFORE = '2026-01-01'
const REQUEST: ArchiveRequest = { before: BEFORE, removeReconciled: true, removeVoided: true }

async function setup() {
  const env = await setupAccounts()
  const c = () => collectionsOf(env.session.database('accounts'))
  const survey = (request: Partial<ArchiveRequest> = {}) => env.service.archiveParticipant.survey({ ...REQUEST, ...request })
  const plan = (request: Partial<ArchiveRequest> = {}) => planAccountsArchive(c(), { ...REQUEST, ...request })
  return { ...env, c, survey, plan }
}

/** An account with transactions: `[date, amount, status, voided?]`. */
async function accountWith(
  env: Awaited<ReturnType<typeof setup>>,
  name: string,
  rows: [string, number, 'uncleared' | 'cleared' | 'reconciled', boolean?][],
  over: Parameters<typeof chequing>[0] = {}
) {
  const account = await env.service.createAccount(chequing({ name, openingDate: '2024-01-01', openingBalance: 100000, ...over }))
  const transactions = env.service.transactions(account.id)
  for (const [date, amount, status, voided] of rows) {
    const made = await transactions.create({ date, amount, payee: 'Shop', ...(status === 'reconciled' ? {} : { status }) })
    if (status === 'reconciled') await transactions.setStatus([made.id], 'reconciled', { confirm: ['reconciled'] })
    if (voided) await transactions.setVoided([made.id], true, { confirm: ['reconciled'] })
  }
  return account
}

describe('what is removable', () => {
  it('removes reconciled and voided transactions from before the cut-off, and nothing else', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [
      ['2025-03-01', -1000, 'reconciled'],          // removable
      ['2025-04-01', -2000, 'cleared', true],       // removable: voided
      ['2025-05-01', -3000, 'cleared'],             // kept: not reconciled
      ['2025-06-01', -4000, 'uncleared'],           // kept: not reconciled
      ['2026-02-01', -5000, 'reconciled']           // kept: after the cut-off
    ])

    const plan = await env.plan()

    expect(plan.transactionIds).toHaveLength(2)
    expect(plan.accounts[0].removed.map(t => t.date)).toEqual(['2025-03-01', '2025-04-01'])
  })

  it('keeps everything dated on the cut-off itself: “before” is exclusive', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [[BEFORE, -1000, 'reconciled'], ['2025-12-31', -1000, 'reconciled']])

    const plan = await env.plan()
    expect(plan.accounts[0].removed.map(t => t.date)).toEqual(['2025-12-31'])
  })

  it('honours the two options separately', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled'], ['2025-04-01', -2000, 'cleared', true]])

    expect((await env.plan({ removeVoided: false })).transactionIds).toHaveLength(1)
    expect((await env.plan({ removeReconciled: false })).transactionIds).toHaveLength(1)
    expect((await env.plan({ removeReconciled: false, removeVoided: false })).transactionIds).toEqual([])
  })

  it('keeps a voided transaction that is also reconciled when voided ones are kept', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled', true]])

    expect((await env.plan({ removeVoided: false })).transactionIds).toEqual([])
    expect((await env.plan()).transactionIds).toHaveLength(1)
  })
})

describe('transfers go in pairs', () => {
  it('removes both sides when both are removable', async () => {
    const env = await setup()
    const from = await accountWith(env, 'Chequing', [])
    const to = await accountWith(env, 'Savings', [])
    const transfer = await env.service.transactions(from.id).create({ date: '2025-03-01', amount: -5000, transferAccountId: to.id })
    const other = (await env.service.transactions(to.id).list())[0]
    await env.service.transactions(from.id).setStatus([transfer.id], 'reconciled', { confirm: ['reconciled'] })
    await env.service.transactions(to.id).setStatus([other.id], 'reconciled', { confirm: ['reconciled'] })

    const plan = await env.plan()

    expect(plan.transactionIds.sort()).toEqual([transfer.id, other.id].sort())
    expect(plan.accounts).toHaveLength(2)
  })

  it('keeps both sides when only one of them is removable', async () => {
    const env = await setup()
    const from = await accountWith(env, 'Chequing', [])
    const to = await accountWith(env, 'Savings', [])
    const transfer = await env.service.transactions(from.id).create({ date: '2025-03-01', amount: -5000, transferAccountId: to.id })
    // Only this side is reconciled; the other is still uncleared, so neither may go
    await env.service.transactions(from.id).setStatus([transfer.id], 'reconciled', { confirm: ['reconciled'] })

    const plan = await env.plan()

    expect(plan.transactionIds).toEqual([])
    expect(plan.accounts).toEqual([])
  })
})

describe('moving the opening balance', () => {
  it('adds what was removed to the opening balance and moves the date to the cut-off', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled'], ['2025-04-01', 2500, 'reconciled']])

    const [removal] = (await env.plan()).accounts

    expect(removal.delta).toBe(1500)
    expect(removal.openingBalance).toBe(101500)
    expect(removal.openingDate).toBe(BEFORE)
  })

  it('ignores voided transactions in the adjustment: they were never in a balance', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -9999, 'cleared', true]])

    const [removal] = (await env.plan()).accounts
    expect(removal.delta).toBe(0)
    expect(removal.openingBalance).toBe(100000)
  })

  it('leaves the opening row above a transaction that stays behind', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled'], ['2025-02-01', -500, 'uncleared']])

    const [removal] = (await env.plan()).accounts
    expect(removal.openingDate).toBe('2025-02-01')
  })

  it('never moves the opening date backwards', async () => {
    expect(newOpeningDate('2026-06-01', BEFORE, undefined)).toBe('2026-06-01')
    expect(newOpeningDate('2024-01-01', BEFORE, undefined)).toBe(BEFORE)
    expect(newOpeningDate('2024-01-01', BEFORE, '2025-02-01')).toBe('2025-02-01')
    expect(newOpeningDate('2024-01-01', BEFORE, '2026-09-01')).toBe(BEFORE)
  })

  it('says nothing about an account that loses nothing', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled']])
    await accountWith(env, 'Savings', [['2026-03-01', -1000, 'reconciled']])

    const plan = await env.plan()
    expect(plan.accounts.map(a => a.account.name)).toEqual(['Chequing'])
  })
})

describe('what the user is warned about', () => {
  it('names each account with unreconciled transactions before the cut-off, and the oldest', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [
      ['2019-03-03', -1000, 'uncleared'],
      ['2025-11-01', -1000, 'cleared'],
      ['2025-12-01', -1000, 'reconciled']
    ])

    const survey = await env.survey()

    expect(survey.warnings).toEqual([{
      kind: 'unreconciled',
      message: expect.stringMatching(/^Chequing: 2 transactions before .* are not reconciled \(oldest .*2019\)\. They stay in the book\.$/)
    }])
  })

  it('says it in the singular for one', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-11-01', -1000, 'cleared']])

    const [warning] = (await env.survey()).warnings
    expect(warning.message).toMatch(/1 transaction before .* is not reconciled .* It stays in the book\./)
  })

  it('warns about nothing when everything before the cut-off is settled', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-11-01', -1000, 'reconciled'], ['2026-05-01', -1000, 'uncleared']])

    expect((await env.survey()).warnings).toEqual([])
  })
})

describe('the survey as the plan sees it', () => {
  it('describes what would go, with a row per account and the ids for other plugins', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled']])
    await accountWith(env, 'Savings', [['2025-04-01', -2000, 'reconciled']], { name: 'Savings' })

    const survey = await env.survey()

    expect(survey.describe).toBe('2 transactions in 2 accounts')
    expect(survey.documents).toBe(2)
    expect(survey.removesIds).toHaveLength(2)
    expect(survey.rows).toEqual([
      { id: expect.any(String), label: 'Chequing', removed: 1, detail: expect.stringMatching(/^Opening balance .* as of .*2026$/) },
      { id: expect.any(String), label: 'Savings', removed: 1, detail: expect.any(String) }
    ])
  })

  it('reports nothing to do for a book with nothing old in it', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2026-03-01', -1000, 'reconciled']])

    const survey = await env.survey()
    expect(survey).toMatchObject({ describe: '0 transactions in 0 accounts', documents: 0, rows: [] })
  })

  it('never writes anything', async () => {
    const env = await setup()
    await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled']])
    const before = await env.session.unscopedDatabase().snapshot()

    await env.survey()

    expect(await env.session.unscopedDatabase().snapshot()).toEqual(before)
  })
})

describe('a reconciliation in progress', () => {
  it('blocks archiving, naming the account', async () => {
    const env = await setup()
    const account = await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled'], ['2025-07-01', -500, 'uncleared']])
    const marked = (await env.service.transactions(account.id).list()).find(t => t.status === 'uncleared')!
    await env.service.reconciliation.begin(account.id, {
      reconcilerId: 'accounts.statement', statementDate: '2025-06-30', startingBalance: 100000, statementBalance: 99000
    })
    await env.service.reconciliation.mark(account.id, [marked.id], true)

    const survey = await env.survey()

    expect(survey.blocker).toBe('A reconciliation of “Chequing” is in progress. Finish or cancel it before archiving.')
  })

  it('holds back a transaction it is working on, even one that looks settled', async () => {
    // Reconciling only ever marks transactions that are *not* reconciled, so this can't arise through the service.
    // The guard is checked rather than assumed, so the record is written straight into the collection here.
    const env = await setup()
    const account = await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled']])
    const settled = (await env.service.transactions(account.id).list())[0]
    await env.c().reconciliations.insert({
      accountId: account.id, reconcilerId: 'accounts.statement', paused: false, startedAt: '2026-11-20T10:00:00.000Z',
      statementDate: '2025-06-30', startingBalance: 100000, statementBalance: 99000,
      status: 'inProgress', activeFor: account.id, original: { [settled.id]: 'reconciled' }
    })

    const survey = await env.survey()

    expect(survey.removesIds).not.toContain(settled.id)
    expect(survey.documents).toBe(0)
  })

  it('has no blocker once it is cancelled', async () => {
    const env = await setup()
    const account = await accountWith(env, 'Chequing', [['2025-03-01', -1000, 'reconciled']])
    await env.service.reconciliation.begin(account.id, {
      reconcilerId: 'accounts.statement', statementDate: '2025-06-30', startingBalance: 100000, statementBalance: 99000
    })
    await env.service.reconciliation.cancel(account.id)

    const survey = await env.survey()
    expect(survey.blocker).toBeUndefined()
    expect(survey.removesIds).toHaveLength(1)
  })
})

describe('reconciliations', () => {
  it('removes the finished ones from before the cut-off but keeps each account’s most recent', async () => {
    const env = await setup()
    const account = await accountWith(env, 'Chequing', [])
    const transactions = env.service.transactions(account.id)
    const statements: string[] = []
    for (const [date, amount] of [['2025-03-31', -1000], ['2025-06-30', -2000], ['2025-09-30', -3000]] as [string, number][]) {
      const made = await transactions.create({ date, amount, payee: 'Shop' })
      const balance = 100000 + statements.length * 0 - [1000, 3000, 6000][statements.length]
      await env.service.reconciliation.begin(account.id, {
        reconcilerId: 'accounts.statement', statementDate: date, startingBalance: 0, statementBalance: balance
      })
      await env.service.reconciliation.mark(account.id, [made.id], true)
      await env.service.reconciliation.finish(account.id, { confirm: ['adjustBalance'] })
      statements.push(date)
    }

    const plan = await env.plan()
    const kept = (await env.service.get(account.id))!.lastReconciled!.reconciliationId

    expect(plan.reconciliationIds).toHaveLength(2)
    expect(plan.reconciliationIds).not.toContain(kept)
  })
})
