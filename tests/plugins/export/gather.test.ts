// What an export reads (docs/export-design.md, "What is exported"): the chosen accounts in the navigator's order, their
// transactions in the range with names rather than ids, exact amounts, the balances either side as the register shows
// them, bank ids but never fingerprints, and where an archive file takes over.
import { describe, expect, it } from 'vitest'
import { gather } from '../../../plugins/export/src/privileged/gather'
import { NOW, household, setupExport } from './harness'

describe('gathering an export', () => {
  it('reads the chosen accounts in the navigator’s order, with names, paths and transfers instead of ids', async () => {
    const env = await setupExport()
    const h = await household(env)
    const { data } = await gather(env.accounts, { accountIds: [h.chequing.id, h.savings.id], range: { from: '2026-10-01', to: '2026-10-31' } }, NOW)

    expect(data.ledger.name).toBe('Home')
    expect(data.accounts.map(a => [a.name, a.location])).toEqual([['Savings', ['Family']], ['Chequing', []]])
    const chequing = data.accounts[1]
    expect(chequing).toMatchObject({ type: 'chequing', currency: 'CAD', digits: 2, institution: 'Maple Trust', accountNumber: '12-345678', closed: false })
    const byPayee = Object.fromEntries(chequing.transactions.map(t => [t.payee, t]))
    expect(byPayee.Landlord).toMatchObject({ date: '2026-10-01', amount: '-1200.00', category: ['Housing', 'Rent'], status: 'reconciled', voided: false })
    expect(byPayee['Hydro One']).toMatchObject({ number: '101', memo: 'Sept, 2026 "final"', status: 'uncleared' })
    expect(byPayee.Hydro_One).toBeUndefined()
    expect(byPayee.Transfer).toMatchObject({ amount: '-500.00', transfer: { account: 'Savings', direction: 'to' } })
    expect(byPayee.Transfer.category).toBeUndefined()
    expect(data.accounts[0].transactions[0]).toMatchObject({ amount: '500.00', transfer: { account: 'Chequing', direction: 'from' } })
    // Every category, by its path, for formats that write a list of them
    expect(data.categories).toEqual(expect.arrayContaining([{ path: ['Food', 'Groceries'], kind: 'expense' }, { path: ['Income', 'Salary'], kind: 'income' }]))
  })

  it('gives the balances either side of the range as the register shows them, voided transactions in none', async () => {
    const env = await setupExport()
    const h = await household(env)
    const { data } = await gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-10-01', to: '2026-10-07' } }, NOW)
    const [chequing] = data.accounts

    // 5,000.00 opening, less September's 10.00
    expect(chequing.opening).toEqual({ date: '2026-10-01', balance: '4990.00' })
    expect(chequing.transactions.map(t => [t.payee, t.amount, t.balance, t.voided])).toEqual([
      ['Landlord', '-1200.00', '3790.00', false],
      ['Hydro One', '-84.12', '3705.88', false],
      ['Employer Inc', '2500.00', '6205.88', false],
      ['Transfer', '-500.00', '5705.88', false]
    ])
    expect(chequing.closing).toEqual({ date: '2026-10-07', balance: '5705.88' })

    // The voided order is there, marked, and changes no balance
    const later = (await gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-10-08', to: '2026-10-08' } }, NOW)).data.accounts[0]
    expect(later.transactions).toEqual([expect.objectContaining({ payee: 'Cancelled Order', amount: '-75.00', voided: true, balance: '5705.88' })])
    expect(later.closing.balance).toBe('5705.88')
  })

  it('writes amounts exactly, with each currency’s own decimals', async () => {
    const env = await setupExport()
    const h = await household(env)
    const { data } = await gather(env.accounts, { accountIds: [h.yen.id, h.visa.id], range: {} }, NOW)
    const byName = Object.fromEntries(data.accounts.map(a => [a.name, a]))
    expect(byName.Tokyo).toMatchObject({ digits: 0, opening: { balance: '100000' }, closing: { balance: '98800' } })
    expect(byName.Tokyo.transactions[0].amount).toBe('-1200')
    expect(byName.Visa).toMatchObject({ type: 'creditCard', opening: { balance: '-250.00' }, closing: { balance: '-395.67' } })
  })

  it('fills in open ends: from the earliest start, to the later of today and the last transaction', async () => {
    const env = await setupExport()
    const h = await household(env)
    expect((await gather(env.accounts, { accountIds: [h.chequing.id, h.old.id], range: {} }, NOW)).data.range).toEqual({ from: '2025-01-01', to: '2026-11-06' })
    // A transaction dated after today moves the end with it
    await env.accounts.transactions(h.chequing.id).create({ date: '2026-12-24', amount: -5000, payee: 'Gifts' })
    const { data } = await gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-10-01' } }, NOW)
    expect(data.range).toEqual({ from: '2026-10-01', to: '2026-12-24' })
    expect(data.accounts[0].transactions.at(-1)?.payee).toBe('Gifts')
    // An account starts no earlier than it opened
    const both = await gather(env.accounts, { accountIds: [h.chequing.id, h.old.id], range: { from: '2024-06-01', to: '2026-12-31' } }, NOW)
    expect(both.data.accounts.map(a => [a.name, a.opening.date])).toEqual([['Chequing', '2026-01-01'], ['Old Account', '2025-01-01']])
    expect(both.data.range.from).toBe('2025-01-01')
  })

  it('passes on the bank’s ids, never an import’s fingerprints', async () => {
    const env = await setupExport()
    const h = await household(env)
    const { data } = await gather(env.accounts, { accountIds: [h.chequing.id], range: {} }, NOW)
    const byPayee = Object.fromEntries(data.accounts[0].transactions.map(t => [t.payee, t]))
    expect(byPayee['Employer Inc'].bankId).toBe('MT20261005-0417')
    expect(byPayee['=SUM(A1:A9)'].bankId).toBeUndefined()
    expect(byPayee.Landlord.bankId).toBeUndefined()
  })

  it('starts an archived account where its register does, and says so', async () => {
    const env = await setupExport()
    const h = await household(env)
    // The archive takes the reconciled rent of 1 October from Chequing; nothing of the Visa card's
    await env.archiveWithFile('2026-10-02')
    const { data, archived } = await gather(env.accounts, { accountIds: [h.chequing.id, h.visa.id], range: {} }, NOW)
    const byName = Object.fromEntries(data.accounts.map(a => [a.name, a]))
    expect(byName.Chequing).toMatchObject({ startsAtArchive: true, opening: { date: '2026-10-02' } })
    expect(byName.Chequing.transactions.map(t => t.payee)).not.toContain('Landlord')
    expect(byName.Visa.startsAtArchive).toBeUndefined()
    expect(archived).toEqual([{ account: 'Chequing', from: '2026-10-02' }])
    // The balances carry on as they were: the archive carried the rent into the opening balance
    expect(byName.Chequing.closing.balance).toBe('5682.43')
    // Asked for dates inside its current period, nothing is missing
    const inside = await gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-10-05' } }, NOW)
    expect(inside.archived).toEqual([])
    expect(inside.data.accounts[0].startsAtArchive).toBeUndefined()
  })

  it('refuses what can’t be exported, saying why', async () => {
    const env = await setupExport()
    const h = await household(env)
    await expect(gather(env.accounts, { accountIds: [], range: {} }, NOW)).rejects.toMatchObject({ code: 'INVALID', message: 'Choose at least one account to export.' })
    await expect(gather(env.accounts, { accountIds: ['gone'], range: {} }, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-10-31', to: '2026-10-01' } }, NOW))
      .rejects.toMatchObject({ code: 'INVALID', message: 'The start date is after the end date.' })
    await expect(gather(env.accounts, { accountIds: [h.chequing.id], range: { from: '2026-02-30' } }, NOW)).rejects.toMatchObject({ code: 'INVALID' })
  })
})
