// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { categoryLabel, type Transaction } from '@tessera/accounts-api'
import { chequing, rejection, setupAccounts } from './harness'

/** An open ledger with Chequing (1,000.00), Savings (0) and a Visa card (owing 540.00), all CAD. */
async function ledger() {
  const env = await setupAccounts()
  const chq = await env.service.createAccount(chequing())
  const sav = await env.service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
  const visa = await env.service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: -54000 }))
  const categories = await env.service.categories.list()
  const groceries = categories.find(c => categoryLabel(categories, c.id) === 'Food : Groceries')!
  const salary = categories.find(c => c.name === 'Salary')!
  env.changes.length = 0
  return { ...env, chq, sav, visa, groceries, salary, t: (id: string) => env.service.transactions(id) }
}

/** Every transfer is two transactions, in two accounts, with opposite amounts and the same date. */
async function expectTransfersWhole(env: Awaited<ReturnType<typeof ledger>>) {
  const all: Transaction[] = []
  for (const account of await env.service.list()) all.push(...await env.t(account.id).list())
  const byTransfer = new Map<string, Transaction[]>()
  for (const t of all) if (t.transferId) byTransfer.set(t.transferId, [...(byTransfer.get(t.transferId) ?? []), t])
  for (const [id, pair] of byTransfer) {
    expect(pair, `transfer ${id}`).toHaveLength(2)
    const [a, b] = pair
    expect(a.amount + b.amount).toBe(0)
    expect(a.date).toBe(b.date)
    expect(a.voided).toBe(b.voided)
    expect([a.transferAccountId, b.transferAccountId]).toEqual([b.accountId, a.accountId])
  }
}

describe('a new ledger', () => {
  it('starts with the starter categories', async () => {
    const { service } = await setupAccounts()
    const categories = await service.categories.list()
    const labels = categories.map(c => categoryLabel(categories, c.id))
    expect(labels).toEqual(expect.arrayContaining(['Salary', 'Food : Groceries', 'Housing : Rent', 'Utilities : Internet']))
    expect(categories.find(c => c.name === 'Salary')!.kind).toBe('income')
  })
})

describe('transactions', () => {
  it('are created with their payee (made on first use, then reused ignoring case) and category', async () => {
    const { t, chq, groceries, service } = await ledger()
    const first = await t(chq.id).create({ date: '2026-10-02', amount: -5025, payee: 'Metro', categoryId: groceries.id, number: ' 101 ', memo: ' weekly ' })
    const second = await t(chq.id).create({ date: '2026-10-09', amount: -3000, payee: 'metro' })

    expect(first).toMatchObject({ accountId: chq.id, date: '2026-10-02', amount: -5025, number: '101', memo: 'weekly', status: 'uncleared', voided: false, categoryId: groceries.id })
    expect(second.payeeId).toBe(first.payeeId)
    expect((await service.payees.search('ME')).map(p => p.name)).toEqual(['Metro'])
  })

  it('name the field at fault', async () => {
    const { t, chq, salary } = await ledger()
    const fieldOf = async (draft: object) => (await rejection(t(chq.id).create({ date: '2026-10-02', amount: 100, ...draft } as never))).field
    expect(await fieldOf({ date: '2026-13-01' })).toBe('date')
    expect(await fieldOf({ amount: 1.5 })).toBe('amount')
    expect(await fieldOf({ number: 'x'.repeat(21) })).toBe('number')
    expect(await fieldOf({ memo: 'x'.repeat(501) })).toBe('memo')
    expect(await fieldOf({ categoryId: 'gone' })).toBe('category')
    expect(await fieldOf({ categoryId: salary.id, transferAccountId: 'x' })).toBe('category')
    expect(await fieldOf({ status: 'reconciled' })).toBe('status')
    expect((await rejection(t('gone').create({ date: '2026-10-02', amount: 1 }))).code).toBe('NOT_FOUND')
  })

  it('are refused in a closed account', async () => {
    const { t, service } = await ledger()
    const old = await service.createAccount(chequing({ name: 'Old', openingBalance: 0 }))
    await service.closeAccount(old.id)
    expect((await rejection(t(old.id).create({ date: '2026-10-02', amount: 1 }))).code).toBe('ACCOUNT_CLOSED')
  })

  it('edit in place, clearing optional fields given as null, and detect changes made elsewhere', async () => {
    const { t, chq, groceries } = await ledger()
    const a = await t(chq.id).create({ date: '2026-10-02', amount: -5025, payee: 'Metro', categoryId: groceries.id, memo: 'x' })
    const edited = await t(chq.id).update(a.id, { amount: -6000, memo: null, payee: null }, { expectedRev: a.rev })
    expect(edited).toMatchObject({ amount: -6000, categoryId: groceries.id })
    expect(edited).not.toHaveProperty('memo')
    expect(edited).not.toHaveProperty('payeeId')
    expect((await rejection(t(chq.id).update(a.id, { amount: 1 }, { expectedRev: a.rev }))).code).toBe('CONFLICT')
  })

  it('make the balances: voided ones count for nothing, cleared and reconciled by status', async () => {
    const { t, chq, service } = await ledger()
    await t(chq.id).create({ date: '2026-10-01', amount: -10000, status: 'cleared' })
    await t(chq.id).create({ date: '2026-10-02', amount: -2000, status: 'electronic' })
    const voided = await t(chq.id).create({ date: '2026-10-03', amount: -99900 })
    await t(chq.id).setVoided([voided.id], true)
    const reconciled = await t(chq.id).create({ date: '2026-10-04', amount: 50000 })
    await t(chq.id).setStatus([reconciled.id], 'reconciled', { confirm: ['reconciled'] })

    expect(await service.balances(chq.id)).toEqual({
      current: 100000 - 10000 - 2000 + 50000, available: 138000, cleared: 138000, reconciled: 150000, transactionCount: 4
    })
    expect((await service.chart()).totals).toEqual({ CAD: 138000 - 54000 })
  })

  it('list by date then in the order entered, with running balances and labels in the register', async () => {
    const { t, chq, sav, groceries } = await ledger()
    await t(chq.id).create({ date: '2026-10-05', amount: -100, payee: 'Late' })
    await t(chq.id).create({ date: '2026-10-01', amount: -200, payee: 'Early', categoryId: groceries.id })
    await t(chq.id).create({ date: '2026-10-05', amount: -300, payee: 'Late too', transferAccountId: sav.id })

    const { rows, balances } = await t(chq.id).register()
    // Without a minimum, the available running balance is the balance
    expect(rows.every(r => r.available === r.balance)).toBe(true)
    expect(rows.map(r => [r.payeeName, r.categoryLabel, r.balance])).toEqual([
      ['Early', 'Food : Groceries', 99800], ['Late', undefined, 99700], ['Late too', 'Transfer to: Savings', 99400]
    ])
    expect(balances.current).toBe(99400)
    expect((await t(sav.id).register()).rows[0]).toMatchObject({ categoryLabel: 'Transfer from: Chequing', balance: 300 })
    expect((await t(chq.id).list({ from: '2026-10-02', to: '2026-10-05' })).map(x => x.amount)).toEqual([-100, -300])
  })

  it('suggest the next cheque number', async () => {
    const { t, chq } = await ledger()
    expect(await t(chq.id).nextNumber()).toBeUndefined()
    await t(chq.id).create({ date: '2026-10-01', amount: -1, number: '101' })
    await t(chq.id).create({ date: '2026-10-02', amount: -1, number: 'ATM' })
    await t(chq.id).create({ date: '2026-10-03', amount: -1, number: '99' })
    expect(await t(chq.id).nextNumber()).toBe('102')
  })
})

describe('transfers', () => {
  it('are two transactions, one in each account, with opposite amounts', async () => {
    const env = await ledger()
    const out = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, payee: 'Me', memo: 'rainy day', number: '7', transferAccountId: env.sav.id })
    const [other] = await env.t(env.sav.id).list()
    expect(out).toMatchObject({ transferAccountId: env.sav.id, amount: -25000 })
    expect(other).toMatchObject({ accountId: env.sav.id, amount: 25000, transferAccountId: env.chq.id, payeeId: out.payeeId, memo: 'rainy day', status: 'uncleared' })
    expect(other).not.toHaveProperty('number')
    expect(env.changes.at(-1)).toMatchObject({ transactions: expect.arrayContaining([env.chq.id, env.sav.id]) })
    await expectTransfersWhole(env)
  })

  it('mirror amount, date, payee and memo; each side keeps its own number and status', async () => {
    const env = await ledger()
    const out = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, transferAccountId: env.sav.id })
    const [other] = await env.t(env.sav.id).list()
    await env.t(env.sav.id).setStatus([other.id], 'cleared')
    await env.t(env.chq.id).update(out.id, { amount: -30000, date: '2026-10-03', payee: 'Me', memo: 'more', number: '8' })

    const [mirrored] = await env.t(env.sav.id).list()
    expect(mirrored).toMatchObject({ amount: 30000, date: '2026-10-03', memo: 'more', status: 'cleared' })
    expect(mirrored).not.toHaveProperty('number')
    await expectTransfersWhole(env)
  })

  it('end when the category replaces the transfer, and move when the other account changes', async () => {
    const env = await ledger()
    const out = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, transferAccountId: env.sav.id })

    await env.t(env.chq.id).update(out.id, { transferAccountId: env.visa.id })
    expect(await env.t(env.sav.id).list()).toEqual([])
    expect((await env.t(env.visa.id).list())[0]).toMatchObject({ amount: 25000, transferAccountId: env.chq.id })

    const ended = await env.t(env.chq.id).update(out.id, { categoryId: env.groceries.id })
    expect(ended).not.toHaveProperty('transferId')
    expect(await env.t(env.visa.id).list()).toEqual([])

    await env.t(env.chq.id).update(out.id, { transferAccountId: env.sav.id })
    expect((await env.t(env.chq.id).get(out.id))).not.toHaveProperty('categoryId')
    expect(await env.t(env.sav.id).list()).toHaveLength(1)
    await expectTransfersWhole(env)
  })

  it('void and delete both sides together', async () => {
    const env = await ledger()
    const out = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, transferAccountId: env.sav.id })
    await env.t(env.chq.id).setVoided([out.id], true)
    expect((await env.t(env.sav.id).list())[0].voided).toBe(true)
    expect((await env.service.balances(env.sav.id)).current).toBe(0)
    await expectTransfersWhole(env)

    await env.t(env.sav.id).delete([(await env.t(env.sav.id).list())[0].id])
    expect(await env.t(env.chq.id).list()).toEqual([])
  })

  it('need another open account in the same currency', async () => {
    const env = await ledger()
    const usd = await env.service.createAccount(chequing({ name: 'US', currency: 'USD' }))
    const old = await env.service.createAccount(chequing({ name: 'Old', openingBalance: 0 }))
    await env.service.closeAccount(old.id)
    const t = env.t(env.chq.id)
    expect(await rejection(t.create({ date: '2026-10-02', amount: -1, transferAccountId: usd.id }))).toMatchObject({ code: 'CURRENCY_MISMATCH', field: 'category' })
    expect(await rejection(t.create({ date: '2026-10-02', amount: -1, transferAccountId: old.id }))).toMatchObject({ code: 'ACCOUNT_CLOSED', field: 'category' })
    expect(await rejection(t.create({ date: '2026-10-02', amount: -1, transferAccountId: env.chq.id }))).toMatchObject({ code: 'INVALID', field: 'category' })
  })
})

describe('reconciled transactions', () => {
  async function reconciled() {
    const env = await ledger()
    const a = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -5000, memo: 'x' })
    await env.t(env.chq.id).setStatus([a.id], 'reconciled', { confirm: ['reconciled'] })
    return { ...env, a: (await env.t(env.chq.id).get(a.id))! }
  }

  it('need confirmation before anything that changes a reconciled balance', async () => {
    const { t, chq, a } = await reconciled()
    const needs = async (work: Promise<unknown>) => (await rejection(work)).reasons
    expect(await needs(t(chq.id).update(a.id, { amount: -1 }))).toEqual(['reconciled'])
    expect(await needs(t(chq.id).update(a.id, { date: '2026-10-03' }))).toEqual(['reconciled'])
    expect(await needs(t(chq.id).setStatus([a.id], 'cleared'))).toEqual(['reconciled'])
    expect(await needs(t(chq.id).setVoided([a.id], true))).toEqual(['reconciled'])
    expect(await needs(t(chq.id).delete([a.id]))).toEqual(['reconciled'])
    // …but not for what doesn't: the memo, the payee
    await expect(t(chq.id).update(a.id, { memo: 'y', payee: 'Shop' })).resolves.toMatchObject({ memo: 'y' })
    await expect(t(chq.id).update(a.id, { amount: -1 }, { confirm: ['reconciled'] })).resolves.toMatchObject({ amount: -1 })
  })

  it('need it too when the change reaches a reconciled other side of a transfer', async () => {
    const env = await ledger()
    const out = await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, transferAccountId: env.sav.id })
    const [other] = await env.t(env.sav.id).list()
    await env.t(env.sav.id).setStatus([other.id], 'reconciled', { confirm: ['reconciled'] })
    expect((await rejection(env.t(env.chq.id).update(out.id, { amount: -1 }))).code).toBe('CONFIRMATION_REQUIRED')
    expect((await rejection(env.t(env.chq.id).delete([out.id]))).code).toBe('CONFIRMATION_REQUIRED')
    expect((await rejection(env.t(env.chq.id).update(out.id, { categoryId: env.groceries.id }))).code).toBe('CONFIRMATION_REQUIRED')
    await expect(env.t(env.chq.id).update(out.id, { memo: 'fine' })).resolves.toBeTruthy()
  })

  it('are marked reconciled by hand only with confirmation', async () => {
    const { t, chq } = await ledger()
    const a = await t(chq.id).create({ date: '2026-10-02', amount: -1 })
    expect((await rejection(t(chq.id).setStatus([a.id], 'reconciled'))).code).toBe('CONFIRMATION_REQUIRED')
  })
})

describe('deleting an account with transactions', () => {
  it('deletes its transactions and unlinks the other sides of its transfers, leaving other balances as they were', async () => {
    const env = await ledger()
    await env.t(env.chq.id).create({ date: '2026-10-01', amount: -1000 })
    await env.t(env.chq.id).create({ date: '2026-10-02', amount: -25000, transferAccountId: env.sav.id, memo: 'top up' })
    const before = await env.service.balances(env.sav.id)

    await env.service.deleteAccount(env.chq.id)

    const [kept] = await env.t(env.sav.id).list()
    expect(kept).toMatchObject({ amount: 25000, memo: 'top up (transfer with deleted account “Chequing”)' })
    expect(kept).not.toHaveProperty('transferId')
    expect(await env.service.balances(env.sav.id)).toEqual(before)
    expect(env.changes.at(-1)).toMatchObject({ deleted: [env.chq.id], transactions: expect.arrayContaining([env.chq.id, env.sav.id]) })
  })

  it('locks the currency once transactions exist', async () => {
    const { t, chq, service } = await ledger()
    await t(chq.id).create({ date: '2026-10-01', amount: -1 })
    expect(await rejection(service.updateAccount(chq.id, { currency: 'USD' }))).toMatchObject({ code: 'INVALID', field: 'currency' })
  })
})

describe('payees and categories', () => {
  it('suggest payees by prefix, with what each was last used for', async () => {
    const { t, chq, sav, groceries, service } = await ledger()
    await t(chq.id).create({ date: '2026-10-01', amount: -1000, payee: 'Metro', categoryId: groceries.id })
    await t(chq.id).create({ date: '2026-10-05', amount: -1500, payee: 'Metro', categoryId: groceries.id })
    await t(chq.id).create({ date: '2026-10-06', amount: -20000, payee: 'Me', transferAccountId: sav.id })
    const found = await service.payees.search('me')
    expect(found.map(p => [p.name, p.lastAmount, p.lastCategoryId, p.lastTransferAccountId])).toEqual([
      ['Me', -20000, undefined, sav.id], ['Metro', -1500, groceries.id, undefined]
    ])
    expect(await service.payees.search('zz')).toEqual([])
  })

  it('create a category path, its parent too, once', async () => {
    const { service, changes } = await ledger()
    const leaf = await service.categories.create('Pets : Vet', 'expense')
    const again = await service.categories.create(' pets :  vet ', 'expense')
    const all = await service.categories.list()
    expect(again.id).toBe(leaf.id)
    expect(categoryLabel(all, leaf.id)).toBe('Pets : Vet')
    expect(changes.filter(c => c.categories)).toHaveLength(1)
    expect((await rejection(service.categories.create(' : ', 'expense'))).field).toBe('category')
    expect((await rejection(service.categories.create('X', 'other' as never))).field).toBe('kind')
  })
})

describe('minimum balances', () => {
  it('make the available balance, shown when the account asks for it', async () => {
    const { service, t } = await ledger()
    const savings = await service.createAccount(chequing({ name: 'High Interest', type: 'savings', openingBalance: 300000, minimumBalance: 100000, showAvailableBalance: true }))
    await t(savings.id).create({ date: '2026-10-01', amount: -50000 })
    expect(await service.balances(savings.id)).toMatchObject({ current: 250000, available: 150000 })
    // …and each register row's running balance, above the minimum too
    expect((await t(savings.id).register()).rows.map(r => [r.balance, r.available])).toEqual([[250000, 150000]])
    // Totals add the actual balance
    expect((await service.chart()).totals.CAD).toBe(100000 - 54000 + 250000)
  })

  it('are for asset accounts, not negative, and needed before the balance above them can be shown', async () => {
    const { service } = await ledger()
    const field = async (input: object) => (await rejection(service.createAccount(chequing({ name: 'X', ...input })))).field
    expect(await field({ type: 'creditCard', minimumBalance: 100 })).toBe('minimumBalance')
    expect(await field({ minimumBalance: -1 })).toBe('minimumBalance')
    expect(await field({ showAvailableBalance: true })).toBe('minimumBalance')
  })

  it('are dropped, with the flag, when the type changes to one without', async () => {
    const { service } = await ledger()
    const a = await service.createAccount(chequing({ name: 'X', minimumBalance: 100, showAvailableBalance: true }))
    const loan = await service.updateAccount(a.id, { type: 'loan' })
    expect(loan).not.toHaveProperty('minimumBalance')
    expect(loan).not.toHaveProperty('showAvailableBalance')
    const b = await service.updateAccount((await service.createAccount(chequing({ name: 'Y', minimumBalance: 100, showAvailableBalance: true }))).id, { minimumBalance: null })
    expect(b).not.toHaveProperty('showAvailableBalance')
  })
})
