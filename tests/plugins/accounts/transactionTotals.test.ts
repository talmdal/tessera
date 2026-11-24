// @vitest-environment node
// `accounts.service.transactionTotals`: transactions totalled by account, month, and category or transfer account, for
// reports and budgets. Run through the real service on a ledger session (memory engine).
// See docs/budget-design.md, "The accounts addition: transactionTotals".
import { describe, expect, it } from 'vitest'
import { displayDate } from '@tessera/ledger-api'
import type { TransactionTotal } from '@tessera/accounts-api'
import { compareTotals, sortTotals, transactionTotals } from '../../../plugins/accounts/src/privileged/transactionsCore'
import { chequing, rejection, setupAccounts } from './harness'

async function ledger() {
  const env = await setupAccounts()
  const { service } = env
  const chq = await service.createAccount(chequing())
  const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: 0 }))
  const categories = await service.categories.list()
  const category = (name: string) => categories.find(c => c.name === name)!.id
  const t = (id: string) => service.transactions(id)
  return { ...env, chq, visa, category, t }
}

/** A row as the service returns it, with only the figures that matter to a test given. */
const row = (accountId: string, month: string, over: Partial<TransactionTotal>): TransactionTotal =>
  ({ accountId, month, categoryId: null, transferAccountId: null, inflow: 0, outflow: 0, count: 0, ...over })

describe('transaction totals', () => {
  it('total each account\'s month by category, money in and money out apart (a refund)', async () => {
    const { service, chq, visa, category, t } = await ledger()
    const groceries = category('Groceries'), salary = category('Salary')
    await t(chq.id).create({ date: '2026-10-01', amount: 300000, categoryId: salary })
    await t(chq.id).create({ date: '2026-10-03', amount: -6500, categoryId: groceries })
    await t(chq.id).create({ date: '2026-10-17', amount: -4200, categoryId: groceries })
    await t(visa.id).create({ date: '2026-10-20', amount: -9000, categoryId: groceries })
    await t(visa.id).create({ date: '2026-10-22', amount: 1500, categoryId: groceries })      // a refund

    const totals = await service.transactionTotals({ from: '2026-10-01', to: '2026-10-31' })

    expect(totals).toEqual([
      row(chq.id, '2026-10', { categoryId: groceries, outflow: 10700, count: 2 }),
      row(chq.id, '2026-10', { categoryId: salary, inflow: 300000, count: 1 }),
      row(visa.id, '2026-10', { categoryId: groceries, inflow: 1500, outflow: 9000, count: 2 })
    ].sort(compareTotals))
  })

  it('count every clearing status, leave voided transactions out, and put uncategorised ones under null', async () => {
    const { service, chq, t } = await ledger()
    for (const [i, status] of (['uncleared', 'electronic', 'cleared'] as const).entries()) await t(chq.id).create({ date: '2026-10-05', amount: -(i + 1) * 100, status })
    const reconciled = await t(chq.id).create({ date: '2026-10-05', amount: -400 })
    await t(chq.id).setStatus([reconciled.id], 'reconciled', { confirm: ['reconciled'] })
    const gone = await t(chq.id).create({ date: '2026-10-06', amount: -99999 })
    await t(chq.id).setVoided([gone.id], true)
    await t(chq.id).create({ date: '2026-10-07', amount: 2500 })

    expect(await service.transactionTotals({ from: '2026-10-01', to: '2026-10-31' })).toEqual([
      row(chq.id, '2026-10', { inflow: 2500, outflow: 1000, count: 5 })
    ])
  })

  it('leave transfers out unless asked for, then total each side by its other account', async () => {
    const { service, chq, visa, category, t } = await ledger()
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    await t(chq.id).create({ date: '2026-10-02', amount: -50000, transferAccountId: sav.id })
    await t(chq.id).create({ date: '2026-10-25', amount: -20000, transferAccountId: visa.id })     // paying the card
    await t(sav.id).create({ date: '2026-10-28', amount: -5000, transferAccountId: chq.id })       // and some back
    await t(chq.id).create({ date: '2026-10-03', amount: -6500, categoryId: category('Groceries') })
    const october = { from: '2026-10-01', to: '2026-10-31' }

    expect((await service.transactionTotals(october)).map(r => r.categoryId)).toEqual([category('Groceries')])

    const all = await service.transactionTotals({ ...october, includeTransfers: true })
    expect(all.filter(r => r.transferAccountId !== null)).toEqual([
      row(chq.id, '2026-10', { transferAccountId: sav.id, inflow: 5000, outflow: 50000, count: 2 }),
      row(chq.id, '2026-10', { transferAccountId: visa.id, outflow: 20000, count: 1 }),
      row(sav.id, '2026-10', { transferAccountId: chq.id, inflow: 50000, outflow: 5000, count: 2 }),
      row(visa.id, '2026-10', { transferAccountId: chq.id, inflow: 20000, count: 1 })
    ].sort(compareTotals))

    // Only chequing: its side of each transfer, by the other account; the other sides aren't asked for
    const mine = await service.transactionTotals({ ...october, includeTransfers: true, accountIds: [chq.id] })
    expect(mine.every(r => r.accountId === chq.id)).toBe(true)
    expect(mine.map(r => r.transferAccountId).filter(Boolean).sort()).toEqual([sav.id, visa.id].sort())
  })

  it('split the months at their boundaries, inclusive of both dates asked for, through 29 February', async () => {
    const { service, chq, category, t } = await ledger()
    const fuel = category('Fuel')
    for (const date of ['2028-01-31', '2028-02-01', '2028-02-29', '2028-03-01']) await t(chq.id).create({ date, amount: -1000, categoryId: fuel })

    expect((await service.transactionTotals({ from: '2028-01-31', to: '2028-02-29' })).map(r => [r.month, r.count])).toEqual([
      ['2028-01', 1], ['2028-02', 2]
    ])
    expect((await service.transactionTotals({ from: '2028-02-01', to: '2028-02-01' })).map(r => [r.month, r.count])).toEqual([['2028-02', 1]])
    expect(await service.transactionTotals({ from: '2027-01-01', to: '2027-12-31' })).toEqual([])
  })

  it('come in order: month, then account, then category or transfer account', async () => {
    const { service, chq, visa, category, t } = await ledger()
    await t(visa.id).create({ date: '2026-09-10', amount: -100, categoryId: category('Fuel') })
    await t(chq.id).create({ date: '2026-10-10', amount: -100, categoryId: category('Rent') })
    await t(chq.id).create({ date: '2026-10-11', amount: -100 })
    await t(chq.id).create({ date: '2026-09-12', amount: -100, categoryId: category('Rent') })
    const totals = await service.transactionTotals({ from: '2026-09-01', to: '2026-10-31' })
    expect(totals).toEqual([...totals].sort(compareTotals))
    expect(totals.map(r => r.month)).toEqual(['2026-09', '2026-09', '2026-10', '2026-10'])
    // Uncategorised first within its account and month
    expect(totals.filter(r => r.month === '2026-10').map(r => r.categoryId)).toEqual([null, category('Rent')])
  })

  it('count closed accounts, and only the accounts asked for', async () => {
    const { service, chq, visa, category, t } = await ledger()
    await t(chq.id).create({ date: '2026-10-10', amount: -100, categoryId: category('Rent') })
    await t(visa.id).create({ date: '2026-10-10', amount: -200, categoryId: category('Fuel') })
    await t(visa.id).create({ date: '2026-10-11', amount: 200 })
    await service.closeAccount(visa.id)
    const october = { from: '2026-10-01', to: '2026-10-31' }

    expect(new Set((await service.transactionTotals(october)).map(r => r.accountId))).toEqual(new Set([chq.id, visa.id]))
    expect((await service.transactionTotals({ ...october, accountIds: [visa.id] })).map(r => r.accountId)).toEqual([visa.id, visa.id])
    expect(await service.transactionTotals({ ...october, accountIds: [] })).toEqual([])
    expect(await service.transactionTotals({ ...october, accountIds: ['no such account'] })).toEqual([])
  })

  it('drop a deleted account\'s transactions, and count the other sides of its transfers as uncategorised', async () => {
    const { service, chq, visa, category, t } = await ledger()
    await t(visa.id).create({ date: '2026-10-10', amount: -200, categoryId: category('Fuel') })
    await t(chq.id).create({ date: '2026-10-25', amount: -20000, transferAccountId: visa.id })
    await service.deleteAccount(visa.id)

    expect(await service.transactionTotals({ from: '2026-10-01', to: '2026-10-31', includeTransfers: true })).toEqual([
      row(chq.id, '2026-10', { outflow: 20000, count: 1 })
    ])
  })

  it('refuse dates that aren\'t YYYY-MM-DD, a range that ends before it starts, and accounts that aren\'t a list', async () => {
    const { service } = await ledger()
    const bad = (query: unknown) => rejection(service.transactionTotals(query as never))
    expect(await bad({ from: '2026-13-01', to: '2026-12-31' })).toMatchObject({ code: 'INVALID', field: 'from' })
    expect(await bad({ from: '2026-01-01', to: '2026-02-30' })).toMatchObject({ code: 'INVALID', field: 'to' })
    expect(await bad({ from: '2026-02-01', to: '2026-01-31' })).toMatchObject({ code: 'INVALID', field: 'to', message: `The last date, ${displayDate('2026-01-31')}, is before the first, ${displayDate('2026-02-01')}.` })
    expect(await bad({ from: '2026-01-01', to: '2026-01-31', accountIds: 'chq' })).toMatchObject({ code: 'INVALID', field: 'accountIds' })
    expect(await bad({ from: '2026-01-01', to: '2026-01-31', includeTransfers: 'yes' })).toMatchObject({ code: 'INVALID', field: 'includeTransfers' })
    expect(await bad(undefined)).toMatchObject({ code: 'INVALID', field: 'from' })
  })

  it('fail with NO_LEDGER while no ledger is open', async () => {
    const { service } = await setupAccounts({ open: false })
    expect(await rejection(service.transactionTotals({ from: '2026-01-01', to: '2026-12-31' }))).toMatchObject({ code: 'NO_LEDGER' })
  })
})

// accounts-api 1.15: by payee, for reports (docs/reporting-design.md, "The accounts additions")
describe('transaction totals by payee', () => {
  it('total each category and transfer account by payee when asked, none under null, adding up to the totals without', async () => {
    const { service, chq, visa, category, t } = await ledger()
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
    const groceries = category('Groceries')
    await t(chq.id).create({ date: '2026-10-03', amount: -6500, categoryId: groceries, payee: 'Metro' })
    await t(chq.id).create({ date: '2026-10-10', amount: -4200, categoryId: groceries, payee: 'Metro' })
    await t(chq.id).create({ date: '2026-10-12', amount: -3000, categoryId: groceries, payee: 'Loblaws' })
    await t(chq.id).create({ date: '2026-10-15', amount: -800, categoryId: groceries })
    await t(visa.id).create({ date: '2026-10-20', amount: 1500, categoryId: groceries, payee: 'Metro' })      // a refund
    await t(chq.id).create({ date: '2026-10-21', amount: -700, payee: 'Metro' })                              // no category
    await t(chq.id).create({ date: '2026-10-25', amount: -50000, transferAccountId: sav.id, payee: 'Savings plan' })
    const [metro, loblaws, plan] = ['Metro', 'Loblaws', 'Savings plan'].map(name => name)
    const payees = new Map((await service.payees.search('', 100)).map(p => [p.name, p.id]))
    const october = { from: '2026-10-01', to: '2026-10-31', includeTransfers: true }

    const byPayee = await service.transactionTotals({ ...october, byPayee: true })
    expect(new Set(byPayee)).toEqual(new Set([
      row(chq.id, '2026-10', { categoryId: groceries, payeeId: payees.get(metro)!, outflow: 10700, count: 2 }),
      row(chq.id, '2026-10', { categoryId: groceries, payeeId: payees.get(loblaws)!, outflow: 3000, count: 1 }),
      row(chq.id, '2026-10', { categoryId: groceries, payeeId: null, outflow: 800, count: 1 }),
      row(chq.id, '2026-10', { payeeId: payees.get(metro)!, outflow: 700, count: 1 }),
      row(chq.id, '2026-10', { transferAccountId: sav.id, payeeId: payees.get(plan)!, outflow: 50000, count: 1 }),
      row(visa.id, '2026-10', { categoryId: groceries, payeeId: payees.get(metro)!, inflow: 1500, count: 1 }),
      row(sav.id, '2026-10', { transferAccountId: chq.id, payeeId: payees.get(plan)!, inflow: 50000, count: 1 })
    ]))
    expect(byPayee).toEqual([...byPayee].sort(compareTotals))

    // Without byPayee, no row has a payee at all, and the rows by payee add up to them exactly
    const plain = await service.transactionTotals(october)
    expect(plain.some(r => 'payeeId' in r)).toBe(false)
    const key = (r: TransactionTotal) => `${r.accountId}|${r.month}|${r.categoryId}|${r.transferAccountId}`
    const added = new Map<string, number[]>()
    for (const r of byPayee) { const s = added.get(key(r)) ?? [0, 0, 0]; added.set(key(r), [s[0] + r.inflow, s[1] + r.outflow, s[2] + r.count]) }
    expect(new Map(plain.map(r => [key(r), [r.inflow, r.outflow, r.count]]))).toEqual(added)
  })

  it('refuse byPayee that isn\'t true or false', async () => {
    const { service } = await ledger()
    expect(await rejection(service.transactionTotals({ from: '2026-01-01', to: '2026-01-31', byPayee: 'yes' as never }))).toMatchObject({ code: 'INVALID', field: 'byPayee' })
  })

  it('come in the contract\'s order, sorted by one key: on random rows, exactly compareTotals\' order', () => {
    let s = 11
    const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    const pick = (n: number, prefix: string) => `${prefix}${Math.floor(r() * n)}`
    for (let round = 0; round < 20; round++) {
      const rows: TransactionTotal[] = Array.from({ length: 300 }, () => {
        const transfer = r() < 0.2
        return row(pick(5, '01HZACCT'), `2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}`, {
          categoryId: transfer || r() < 0.1 ? null : pick(8, '01HZCAT'), transferAccountId: transfer ? pick(5, '01HZACCT') : null,
          ...(r() < 0.5 && { payeeId: r() < 0.2 ? null : pick(30, '01HZPAYEE') })
        })
      })
      expect(sortTotals(rows)).toEqual([...rows].sort(compareTotals))
    }
  })
})

describe('payees by id', () => {
  it('are read in one go, ids that don\'t exist left out, each once', async () => {
    const { service, chq, t } = await ledger()
    await t(chq.id).create({ date: '2026-10-03', amount: -100, payee: 'Metro' })
    await t(chq.id).create({ date: '2026-10-04', amount: -100, payee: 'Loblaws' })
    const all = await service.payees.search('', 100)
    const ids = all.map(p => p.id)
    const got = await service.payees.get([...ids, ids[0], 'no such payee'])
    expect(got.map(p => p.name).sort()).toEqual(['Loblaws', 'Metro'])
    expect(got[0]).toEqual({ id: expect.any(String), name: expect.any(String), rev: expect.any(Number) })
    expect(await service.payees.get([])).toEqual([])
    expect(await rejection(service.payees.get('x' as never))).toMatchObject({ code: 'INVALID', field: 'ids' })
  })
})

describe('the pure totals', () => {
  const doc = (over: Partial<Parameters<typeof transactionTotals>[0] extends Iterable<infer T> ? T : never>) =>
    ({ accountId: 'A', date: '2026-10-01', amount: -100, voided: false, ...over })

  it('leave out a transaction whose account no longer exists, as the register never shows one', () => {
    const totals = transactionTotals([doc({}), doc({ accountId: 'ghost' })], { from: '2026-01-01', to: '2026-12-31' }, new Set(['A']))
    expect(totals).toEqual([row('A', '2026-10', { outflow: 100, count: 1 })])
  })

  it('count a zero amount, in neither money in nor money out', () => {
    expect(transactionTotals([doc({ amount: 0 })], { from: '2026-01-01', to: '2026-12-31' }, new Set(['A'])))
      .toEqual([row('A', '2026-10', { count: 1 })])
  })

  it('total a transfer by its other account even if it has a category (never made, but read safely)', () => {
    const totals = transactionTotals([doc({ transferAccountId: 'B', categoryId: 'C' })], { from: '2026-01-01', to: '2026-12-31', includeTransfers: true }, new Set(['A']))
    expect(totals).toEqual([row('A', '2026-10', { transferAccountId: 'B', outflow: 100, count: 1 })])
  })
})
