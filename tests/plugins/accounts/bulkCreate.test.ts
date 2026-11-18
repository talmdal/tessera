// @vitest-environment node
// `createMany` and `externalId` on a draft: the two additions to the account manager that import depends on.
// Without the reference an import cannot tell a statement it has already read; without the batch create, a
// migration import would make one round trip per transaction.
import { describe, expect, it } from 'vitest'
import { chequing, rejection, setupAccounts } from './harness'

/** The accounts service with a chequing and a savings account, which is all these tests need. */
async function setup() {
  const env = await setupAccounts()
  const chq = await env.service.createAccount(chequing())
  const savings = await env.service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
  env.changes.length = 0
  return { ...env, accounts: env.service, chq, savings }
}

describe('createMany', () => {
  it('writes every draft, in the order given', async () => {
    const { accounts, chq } = await setup()
    const written = await accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -100, payee: 'One' },
      { date: '2026-11-02', amount: -200, payee: 'Two' },
      { date: '2026-11-03', amount: 300, payee: 'Three' }
    ])

    expect(written.map(t => t.amount)).toEqual([-100, -200, 300])
    const register = await accounts.transactions(chq.id).register()
    expect(register.rows).toHaveLength(3)
    expect(register.balances.current).toBe(100000 - 100 - 200 + 300)
  })

  it('writes nothing at all when one draft is refused', async () => {
    const { accounts, chq } = await setup()
    const failure = await rejection(accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -100, payee: 'Good' },
      { date: 'not a date', amount: -200, payee: 'Bad' }
    ]))

    expect(failure.code).toBe('INVALID')
    expect((await accounts.transactions(chq.id).register()).rows).toEqual([])
  })

  it('reuses one payee for every row that names it', async () => {
    const { accounts, chq } = await setup()
    await accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -100, payee: 'Hydro Ottawa' },
      { date: '2026-11-02', amount: -200, payee: 'hydro ottawa' },
      { date: '2026-11-03', amount: -300, payee: 'HYDRO OTTAWA' }
    ])
    const payees = await accounts.payees.search('')
    expect(payees.filter(p => p.name.toLowerCase() === 'hydro ottawa')).toHaveLength(1)
  })

  it('writes both sides of a transfer, as `create` does', async () => {
    const { accounts, chq, savings } = await setup()
    await accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -50000, payee: 'Transfer', transferAccountId: savings.id }
    ])

    expect((await accounts.transactions(chq.id).register()).rows).toHaveLength(1)
    const other = (await accounts.transactions(savings.id).register()).rows
    expect(other).toHaveLength(1)
    expect(other[0].transaction.amount).toBe(50000)
  })

  it('checks the account even for an empty batch, so a closed one is reported the same way', async () => {
    const { accounts, chq } = await setup()
    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect((await rejection(accounts.transactions(chq.id).createMany([]))).code).toBe('ACCOUNT_CLOSED')
    expect((await rejection(accounts.transactions('gone').createMany([]))).code).toBe('NOT_FOUND')
  })

  it('announces every account it touched, once', async () => {
    const { accounts, chq, savings, changes } = await setup()
    changes.length = 0
    await accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -100, payee: 'One' },
      { date: '2026-11-02', amount: -50000, transferAccountId: savings.id }
    ])

    expect(changes).toHaveLength(1)
    expect(new Set(changes[0].transactions)).toEqual(new Set([chq.id, savings.id]))
    expect(new Set(changes[0].balances)).toEqual(new Set([chq.id, savings.id]))
  })
})

describe('externalId on a draft', () => {
  it('is stored, and refuses a second transaction with the same one in that account', async () => {
    const { accounts, chq } = await setup()
    const first = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, externalId: 'FIT-1' })
    expect(first.externalId).toBe('FIT-1')

    const failure = await rejection(accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -200, externalId: 'FIT-1' }))
    expect(failure.code).toBe('INVALID')
    expect(failure.field).toBe('externalId')
    expect(failure.message).toMatch(/already been imported/)
  })

  it('allows the same reference in a different account: two banks can use the same id', async () => {
    const { accounts, chq, savings } = await setup()
    await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, externalId: 'FIT-1' })
    await accounts.transactions(savings.id).create({ date: '2026-11-01', amount: -100, externalId: 'FIT-1' })
    expect((await accounts.transactions(savings.id).register()).rows).toHaveLength(1)
  })

  it('catches two rows of one batch sharing a reference, naming the row', async () => {
    const { accounts, chq } = await setup()
    const failure = await rejection(accounts.transactions(chq.id).createMany([
      { date: '2026-11-01', amount: -100, externalId: 'FIT-1' },
      { date: '2026-11-02', amount: -200, externalId: 'FIT-1' }
    ]))
    expect(failure.field).toBe('externalId')
    expect(failure.message).toMatch(/number 2/)
  })

  it('is adopted by a patch, which is how a merge claims a transaction the user typed', async () => {
    const { accounts, chq } = await setup()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, payee: 'Hydro' })
    const merged = await accounts.transactions(chq.id).update(typed.id, { externalId: 'FIT-1', status: 'electronic' })

    expect(merged).toMatchObject({ externalId: 'FIT-1', status: 'electronic' })
    // The merge claims the transaction; it does not rewrite what the user entered
    expect(merged.amount).toBe(-100)
    expect(merged.date).toBe('2026-11-01')
    expect(merged.payeeId).toBe(typed.payeeId)
  })

  it('is cleared by a patch of null, which is how an undo takes it back off', async () => {
    const { accounts, chq } = await setup()
    const imported = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, externalId: 'FIT-1' })
    const restored = await accounts.transactions(chq.id).update(imported.id, { externalId: null, status: 'uncleared' })

    expect(restored.externalId).toBeUndefined()
    expect(restored.status).toBe('uncleared')
    // And the reference is free again
    await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -200, externalId: 'FIT-1' })
  })

  it('survives an ordinary edit that does not mention it', async () => {
    const { accounts, chq } = await setup()
    const imported = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, externalId: 'FIT-1' })
    const edited = await accounts.transactions(chq.id).update(imported.id, { memo: 'a note' })
    expect(edited.externalId).toBe('FIT-1')
  })

  it('is not copied onto the other side of a transfer, which the source never reported', async () => {
    const { accounts, chq, savings } = await setup()
    await accounts.transactions(chq.id).create({
      date: '2026-11-01', amount: -50000, transferAccountId: savings.id, externalId: 'FIT-1'
    })
    const other = (await accounts.transactions(savings.id).register()).rows[0]
    expect(other.transaction.externalId).toBeUndefined()
  })
})
