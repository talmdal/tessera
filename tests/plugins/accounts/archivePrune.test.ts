// @vitest-environment node
// The accounts prune: removal, the opening-balance adjustment, and the invariant that no balance changes — checked
// on the post-image inside the transaction, so a wrong adjustment rolls everything back.
// See docs/archive-design.md, "Moving the opening balance".
import { describe, expect, it } from 'vitest'
import type { Collection, Transaction as StorageTransaction } from '@tessera/types'
import type { ArchiveContext, ArchiveRequest } from '@tessera/book-api'
import { isBookError } from '@tessera/book-api'
import { scopedTransaction } from '../../../plugins/book/src/privileged/scopedDatabase'
import { collectionsOf } from '../../../plugins/accounts/src/privileged/store'
import { chequing, setupAccounts } from './harness'

const BEFORE = '2026-01-01'
const REQUEST: ArchiveRequest = { before: BEFORE, removeReconciled: true, removeVoided: true }

async function setup() {
  const env = await setupAccounts()
  /** Runs the participant's prune the way the archiver does: scoped, inside one storage transaction. */
  const prune = (context: Partial<ArchiveContext> = {}, shape: (tx: StorageTransaction) => StorageTransaction = tx => tx) =>
    env.session.unscopedDatabase().transaction(tx =>
      env.service.archiveParticipant.prune(shape(scopedTransaction(tx, 'accounts')), { request: REQUEST, removedIds: new Set(), ...context }))
  const c = () => collectionsOf(env.session.database('accounts'))
  return { ...env, prune, c }
}

async function seeded(env: Awaited<ReturnType<typeof setup>>) {
  const account = await env.service.createAccount(chequing({ openingDate: '2024-01-01', openingBalance: 100000 }))
  const transactions = env.service.transactions(account.id)
  const removable = await transactions.create({ date: '2025-03-01', amount: -1000, payee: 'Shop' })
  await transactions.setStatus([removable.id], 'reconciled', { confirm: ['reconciled'] })
  const second = await transactions.create({ date: '2025-06-01', amount: 2500, payee: 'Employer' })
  await transactions.setStatus([second.id], 'reconciled', { confirm: ['reconciled'] })
  const kept = await transactions.create({ date: '2025-09-01', amount: -700, payee: 'Shop' })        // unreconciled
  const recent = await transactions.create({ date: '2026-03-01', amount: -400, payee: 'Shop' })      // after the cut-off
  return { account, transactions, removable, second, kept, recent }
}

describe('pruning the accounts', () => {
  it('removes what the survey said and leaves every ending balance identical', async () => {
    const env = await setup()
    const { account, transactions, kept, recent } = await seeded(env)
    const before = await env.service.balances(account.id)

    const result = await env.prune()

    expect(result.documents).toBe(2)
    const after = await env.service.balances(account.id)
    expect(after).toEqual({ ...before, transactionCount: before.transactionCount - 2 })
    expect((await transactions.list()).map(t => t.id).sort()).toEqual([kept.id, recent.id].sort())
  })

  it('moves the opening balance and date, and the register still adds up from them', async () => {
    const env = await setup()
    const { account } = await seeded(env)

    await env.prune()

    const archived = (await env.service.get(account.id))!
    expect(archived.openingBalance).toBe(100000 - 1000 + 2500)
    // An unreconciled 2025 transaction stays, so the opening row keeps above it
    expect(archived.openingDate).toBe('2025-09-01')
    const register = await env.service.transactions(account.id).register()
    expect(register.rows[register.rows.length - 1].balance).toBe(100000 - 1000 + 2500 - 700 - 400)
  })

  it('does not touch an account with nothing to remove, not even its rev', async () => {
    const env = await setup()
    await seeded(env)
    const untouched = await env.service.createAccount(chequing({ name: 'Savings', type: 'savings' }))

    await env.prune()

    expect(await env.service.get(untouched.id)).toEqual(untouched)
  })

  it('removes a voided transaction without changing anything about the balances', async () => {
    const env = await setup()
    const account = await env.service.createAccount(chequing({ openingDate: '2024-01-01', openingBalance: 100000 }))
    const transactions = env.service.transactions(account.id)
    const voided = await transactions.create({ date: '2025-03-01', amount: -9999, payee: 'Mistake' })
    await transactions.setVoided([voided.id], true)
    const before = await env.service.balances(account.id)

    await env.prune()

    const after = await env.service.balances(account.id)
    expect(after).toEqual({ ...before, transactionCount: 0 })
    expect((await env.service.get(account.id))!.openingBalance).toBe(100000)
  })

  it('keeps each account’s latest reconciliation, so lastReconciled still resolves', async () => {
    const env = await setup()
    const account = await env.service.createAccount(chequing({ openingDate: '2024-01-01', openingBalance: 100000 }))
    const transactions = env.service.transactions(account.id)
    for (const date of ['2025-03-31', '2025-06-30']) {
      const made = await transactions.create({ date, amount: -1000, payee: 'Shop' })
      await env.service.reconciliation.begin(account.id, {
        reconcilerId: 'accounts.statement', statementDate: date, startingBalance: 0, statementBalance: 0
      })
      await env.service.reconciliation.mark(account.id, [made.id], true)
      await env.service.reconciliation.finish(account.id, { confirm: ['adjustBalance'] })
    }

    await env.prune()

    const lastReconciled = (await env.service.get(account.id))!.lastReconciled!
    const remaining = await env.c().reconciliations.find({})
    expect(remaining.map(r => r.id)).toContain(lastReconciled.reconciliationId)
    expect(remaining.filter(r => r.accountId === account.id)).toHaveLength(1)
  })

  it('rolls the whole prune back when an adjustment would not balance', async () => {
    const env = await setup()
    const { account } = await seeded(env)
    const before = await env.service.balances(account.id)

    // A write that quietly goes wrong: the accounts collection stores a different opening balance than asked
    const sabotaged = (tx: StorageTransaction): StorageTransaction => ({
      collection: <T extends object>(name: string): Collection<T> => {
        const real = tx.collection<T>(name)
        if (name !== 'accounts.accounts') return real
        return new Proxy(real, {
          get: (target, property, receiver) => {
            if (property !== 'updateOne') return Reflect.get(target, property, receiver)
            return (filter: object, update: { $set: Record<string, unknown> }) =>
              real.updateOne(filter as never, { $set: { ...update.$set, openingBalance: (update.$set.openingBalance as number) + 1 } } as never)
          }
        })
      }
    })

    const err = await env.prune({}, sabotaged).then(() => undefined, e => e)

    expect(isBookError(err), String(err)).toBe(true)
    expect((err as { code: string }).code).toBe('ARCHIVE_BALANCE_MISMATCH')
    expect((err as Error).message).toMatch(/would not have balanced.*current balance/)
    // Rolled back: the removable transactions are still there and nothing moved
    expect(await env.service.balances(account.id)).toEqual(before)
    expect((await env.service.get(account.id))!.openingBalance).toBe(100000)
  })

  it('is exactly what the survey promised: same ids, same count', async () => {
    const env = await setup()
    await seeded(env)
    const survey = await env.service.archiveParticipant.survey(REQUEST)

    const result = await env.prune()

    expect(result.documents).toBe(survey.documents)
    const remaining = new Set((await env.c().transactions.find({})).map(t => t.id))
    for (const id of survey.removesIds!) expect(remaining.has(id)).toBe(false)
  })
})
