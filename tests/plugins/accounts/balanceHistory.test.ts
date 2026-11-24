// @vitest-environment node
// `accounts.service.balanceHistory` (accounts-api 1.15): each account's balance at the end of each date, by the
// navigator's rule, for reports' Net Worth and Account Balances. Through the real service on a ledger session (memory
// engine). What archives do to it is in archive.test.ts. See docs/reporting-design.md, "The accounts additions".
import { describe, expect, it } from 'vitest'
import { BALANCE_DATES_MAX } from '@tessera/accounts-api'
import { chequing, rejection, setupAccounts } from './harness'

async function ledger() {
  const env = await setupAccounts()
  const t = (id: string) => env.service.transactions(id)
  return { ...env, t }
}

/** A small deterministic random source (mulberry32). */
function random(seed: number) {
  let s = seed
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let x = Math.imul(s ^ s >>> 15, 1 | s)
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x
    return ((x ^ x >>> 14) >>> 0) / 4294967296
  }
}

describe('balances at past dates', () => {
  it('agree with each register\'s running balance on every date, voids and transfers included', async () => {
    const { service, t } = await ledger()
    const r = random(3)
    const chq = await service.createAccount(chequing({ openingDate: '2025-01-01', openingBalance: 250000 }))
    const sav = await service.createAccount(chequing({ name: 'Savings', type: 'savings', openingDate: '2025-01-01', openingBalance: 0 }))
    const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingDate: '2025-03-15', openingBalance: -12000 }))
    const accounts = [chq, sav, visa]
    for (let i = 0; i < 120; i++) {
      const a = accounts[Math.floor(r() * 3)]
      const day = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 600) * 86400000).toISOString().slice(0, 10)
      const date = day < a.openingDate ? a.openingDate : day
      const amount = Math.round((r() - 0.6) * 50000)
      const made = r() < 0.15 && date >= visa.openingDate
        ? await t(a.id).create({ date, amount, transferAccountId: accounts[(accounts.indexOf(a) + 1) % 3].id })
        : await t(a.id).create({ date, amount })
      if (r() < 0.05) await t(a.id).setVoided([made.id], true)
    }
    const dates = Array.from({ length: 22 }, (_, i) => new Date(Date.UTC(2025, i + 1, 0)).toISOString().slice(0, 10))

    const points = await service.balanceHistory({ dates })

    let compared = 0
    for (const a of accounts) {
      const { rows } = await t(a.id).register()
      for (const p of points.filter(x => x.accountId === a.id)) {
        const last = [...rows].reverse().find(row => row.transaction.date <= p.date)
        expect(p.balance, `${a.name} ${p.date}`).toBe(last ? last.balance : a.openingBalance)
        expect(p.exact).toBe(true)
        compared++
      }
    }
    // The Visa opened in March: no point for it before
    expect(points.filter(p => p.accountId === visa.id).map(p => p.date)[0]).toBe('2025-03-31')
    expect(compared).toBe(22 + 22 + 20)
  })

  it('are the current balances at a date after every transaction, for every account, a closed one included', async () => {
    const { service, t } = await ledger()
    const chq = await service.createAccount(chequing())
    const old = await service.createAccount(chequing({ name: 'Old', openingBalance: 700 }))
    await t(chq.id).create({ date: '2026-03-01', amount: -300 })
    await t(old.id).create({ date: '2026-02-01', amount: -700 })
    await service.closeAccount(old.id)

    const points = await service.balanceHistory({ dates: ['2026-12-31'] })
    for (const a of [chq, old]) expect(points.find(p => p.accountId === a.id)!.balance).toBe((await service.balances(a.id)).current)
  })

  it('leave out what is dated after the date: a cheque written ahead counts from its own date', async () => {
    const { service, t } = await ledger()
    const chq = await service.createAccount(chequing({ openingBalance: 10000 }))
    await t(chq.id).create({ date: '2026-12-15', amount: -2500, number: '104' })
    const points = await service.balanceHistory({ dates: ['2026-11-30', '2026-12-31'] })
    expect(points.map(p => [p.date, p.balance])).toEqual([['2026-11-30', 10000], ['2026-12-31', 7500]])
  })

  it('come account by account in the navigator\'s order, then date by date, each date once; only the accounts asked for', async () => {
    const { service, session } = await ledger()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const top = await service.createAccount(chequing({ name: 'Top' }))
    const inner = await service.createAccount(chequing({ name: 'Inner', subLedgerId: personal.id }))
    const points = await service.balanceHistory({ dates: ['2026-06-30', '2026-03-31', '2026-06-30'] })
    // A sub-ledger's accounts come before the ledger's own, as in the navigator
    expect(points.map(p => [p.accountId, p.date])).toEqual([
      [inner.id, '2026-03-31'], [inner.id, '2026-06-30'], [top.id, '2026-03-31'], [top.id, '2026-06-30']
    ])
    expect((await service.balanceHistory({ dates: ['2026-03-31'], accountIds: [top.id, 'no such account'] })).map(p => p.accountId)).toEqual([top.id])
    expect(await service.balanceHistory({ dates: ['2026-03-31'], accountIds: [] })).toEqual([])
  })

  it('refuse dates that aren\'t YYYY-MM-DD, none, or too many; and fail with NO_LEDGER while no ledger is open', async () => {
    const { service } = await ledger()
    const bad = (query: unknown) => rejection(service.balanceHistory(query as never))
    expect(await bad({ dates: ['2026-13-01'] })).toMatchObject({ code: 'INVALID', field: 'dates' })
    expect(await bad({ dates: [] })).toMatchObject({ code: 'INVALID', field: 'dates' })
    expect(await bad({ dates: Array.from({ length: BALANCE_DATES_MAX + 1 }, (_, i) => new Date(Date.UTC(2000, i, 1)).toISOString().slice(0, 10)) })).toMatchObject({ code: 'INVALID', field: 'dates' })
    expect(await bad(undefined)).toMatchObject({ code: 'INVALID', field: 'dates' })
    const closed = (await setupAccounts({ open: false })).service
    expect(await rejection(closed.balanceHistory({ dates: ['2026-01-31'] }))).toMatchObject({ code: 'NO_LEDGER' })
    expect(await rejection(closed.archivedTotals({ from: '2026-01-01', to: '2026-12-31' }))).toMatchObject({ code: 'NO_LEDGER' })
    expect(await rejection(service.archivedTotals({ from: '2026-12-01', to: '2026-01-31' }))).toMatchObject({ code: 'INVALID', field: 'to' })
  })
})
