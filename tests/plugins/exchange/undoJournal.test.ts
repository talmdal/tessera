// @vitest-environment node
// An undo that fails part-way. Each step goes through `accounts.service`, which cannot be held in one storage
// transaction, so undo journals what it has done and backs it out when a later step fails — the book ends as
// it was before Undo, never half-reversed. These tests make a real step fail and check the book afterwards.
import { describe, expect, it } from 'vitest'
import type { AccountsService, TransactionManager } from '@tessera/accounts-api'
import { document, registerOf, row, setupExchange, statement } from './harness'

type Env = Awaited<ReturnType<typeof setupExchange>>

/**
 * Makes chosen operations of the accounts service's transaction managers fail, by wrapping them. The service
 * and the test share the one `accounts` object, so the undo under test meets the failures.
 */
function faults(env: Env) {
  const failing = new Set<string>()
  const accounts = env.accounts as AccountsService & { transactions: (id: string) => TransactionManager }
  const real = accounts.transactions.bind(accounts)
  accounts.transactions = (id: string) => new Proxy(real(id), {
    get(target, name, receiver) {
      if (typeof name === 'string' && failing.has(name)) return async () => { throw new Error(`${name} failed: the disk is full`) }
      const value = Reflect.get(target, name, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return failing
}

/**
 * A statement of two rows: one merges into a transaction the user typed, the other is new. Both accepted, so
 * the batch has a merge to restore and a creation to delete.
 */
async function mergedAndCreated(env: Env) {
  const typed = await env.accounts.transactions(env.chq.id).create({ date: '2026-11-01', amount: -14200, payee: 'Hydro' })
  await env.fileOf(document({
    statements: [statement({
      transactions: [
        row({ date: '2026-11-03', amount: -14200, payee: 'Hydro', externalId: 'A' }),
        row({ date: '2026-11-04', amount: -2500, payee: 'Coffee', externalId: 'B' })
      ]
    })]
  }))
  for (let i = 0; i < 2; i += 1) {
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
  }
  const [batch] = await env.service.history()
  return { typed, batch }
}

/** The register in comparable terms, so before and after can be compared. */
const book = async (env: Env) =>
  (await registerOf(env.accounts, env.chq.id)).map(r => ({
    date: r.date, amount: r.amount, payee: r.payee, status: r.status, externalId: r.externalId
  }))

describe('an undo whose last step fails', () => {
  it('backs out the steps it had taken, leaving the book as the import left it', async () => {
    const env = await setupExchange()
    await mergedAndCreated(env)
    const before = await book(env)
    const [batch] = await env.service.history()

    const failing = faults(env)
    failing.add('delete')       // the merge is restored first, then deleting the created row fails
    await expect(env.service.undo(batch.id)).rejects.toThrow(/disk is full/)

    // The merged transaction is back as the import had it, not as it was before the import.
    expect(await book(env)).toEqual(before)
  })

  it('leaves the batch undoable, with no undo left recorded as running', async () => {
    const env = await setupExchange()
    const { batch } = await mergedAndCreated(env)
    const failing = faults(env)
    failing.add('delete')
    await expect(env.service.undo(batch.id)).rejects.toThrow()

    const [after] = await env.service.history()
    expect(after.undoneAt).toBeUndefined()
    expect(after.undoing).toBeUndefined()

    // With the fault gone, the same undo goes through, and the book is as it was before the import.
    failing.clear()
    const result = await env.service.undo(batch.id)
    expect(result).toMatchObject({ removed: 1, restored: 1 })
    expect(await book(env)).toEqual([
      { date: '2026-11-01', amount: -14200, payee: 'Hydro', status: 'uncleared', externalId: undefined }
    ])
  })
})

describe('an undo that fails after deleting created rows', () => {
  it('writes them back, and points the batch at the transactions that replace them', async () => {
    const env = await setupExchange()
    await env.fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'A' })] })] }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    const [batch] = await env.service.history()
    const before = await book(env)

    // The delete goes through, and then the call reports failure — a dropped connection, say — so the
    // deleted row really is gone when undo has to put it back.
    const accounts = env.accounts as AccountsService & { transactions: (id: string) => TransactionManager }
    const real = accounts.transactions
    accounts.transactions = (id: string) => new Proxy(real(id), {
      get(target, name, receiver) {
        if (name === 'delete') return async (ids: string[], options?: object) => {
          await target.delete(ids, options as never)
          throw new Error('the connection dropped after the delete')
        }
        const value = Reflect.get(target, name, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(env.service.undo(batch.id)).rejects.toThrow(/connection dropped/)
    accounts.transactions = real

    // Written back with the same content…
    expect(await book(env)).toEqual(before)
    // …and the batch names the transaction that replaced it, so it can still be undone.
    const [after] = await env.service.history()
    const [replacement] = await registerOf(env.accounts, env.chq.id)
    expect(after.created[0].rows.map(r => r.id)).toEqual([replacement.id])
    expect((await env.service.undo(after.id)).removed).toBe(1)
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })
})

describe('an undo that never finished', () => {
  it('is backed out first by the next undo, which then completes', async () => {
    const env = await setupExchange()
    await mergedAndCreated(env)
    const [batch] = await env.service.history()

    // The merge is restored and journalled; deleting fails; and backing out fails too, so the journal stays.
    const failing = faults(env)
    failing.add('delete')
    const accounts = env.accounts as AccountsService & { transactions: (id: string) => TransactionManager }
    const faulty = accounts.transactions
    let updates = 0
    accounts.transactions = (id: string) => new Proxy(faulty(id), {
      get(target, name, receiver) {
        // The first update is the undo's own restore; the second is the back-out putting it back
        if (name === 'update') return async (...args: unknown[]) => {
          updates += 1
          if (updates === 2) throw new Error('the back-out failed too')
          return (target.update as (...a: unknown[]) => Promise<unknown>)(...args)
        }
        return Reflect.get(target, name, receiver)
      }
    })
    await expect(env.service.undo(batch.id)).rejects.toThrow(/back-out failed/)

    // Left half-reversed — and the journal says so.
    const [stuck] = await env.service.history()
    expect(stuck.undoing?.restored).toHaveLength(1)

    // Faults cleared: the next undo backs that journal out, then undoes the import whole.
    failing.clear()
    accounts.transactions = faulty
    const result = await env.service.undo(batch.id)
    expect(result).toMatchObject({ removed: 1, restored: 1 })
    expect(await book(env)).toEqual([
      { date: '2026-11-01', amount: -14200, payee: 'Hydro', status: 'uncleared', externalId: undefined }
    ])
    const [done] = await env.service.history({ includeUndone: true })
    expect(done.undoneAt).toEqual(expect.any(String))
    expect(done.undoing).toBeUndefined()
  })
})
