// @vitest-environment node
// What the Recurring view is given: one row per series, ascending by date, with the figures the warnings are
// built from — and how the plugin follows the account manager when an account is closed or deleted.
import { describe, expect, it } from 'vitest'
import { monthly, setupRecurring, template, TODAY } from './harness'

/** Series due before, on, and after today (2026-11-13, a Friday). */
async function book() {
  const env = await setupRecurring()
  const overdue = await env.create({ name: 'Hydro', schedule: monthly('2026-09-01') })          // Sep, Oct, Nov all due
  const today = await env.create({ name: 'Rent', schedule: monthly(TODAY), template: template({ amount: -120000, payee: 'Landlord' }) })
  const soon = await env.create({ name: 'Phone', schedule: monthly('2026-11-15'), template: template({ amount: -8000, payee: 'Telco' }) })
  const later = await env.create({ name: 'Insurance', schedule: monthly('2026-12-20'), template: template({ amount: -30000, payee: 'Insurer' }) })
  return { ...env, overdue, today, soon, later }
}

describe('the snapshot', () => {
  it('lists one row per series, ascending by date, so what is late comes first', async () => {
    const { service } = await book()
    const { rows, today } = await service.snapshot()
    expect(today).toBe(TODAY)
    expect(rows.map(r => [r.series.name, r.occurrence!.date, r.state])).toEqual([
      ['Hydro', '2026-09-01', 'overdue'],
      ['Rent', '2026-11-13', 'dueToday'],
      ['Phone', '2026-11-15', 'dueSoon'],
      ['Insurance', '2026-12-20', 'upcoming']
    ])
  })

  it('shows only the first occurrence of each, and counts the rest as due', async () => {
    const { service } = await book()
    const { rows } = await service.snapshot()
    const hydro = rows.find(r => r.series.name === 'Hydro')!
    // September, October and November have all gone by: one row, three due
    expect(hydro.occurrence!.date).toBe('2026-09-01')
    expect(hydro.dueCount).toBe(3)
    expect(rows.find(r => r.series.name === 'Phone')!.dueCount).toBe(0)
    expect(rows.find(r => r.series.name === 'Rent')!.dueCount).toBe(1)
  })

  it('uses the reminder window each series was given', async () => {
    const { create, service } = await setupRecurring()
    // Default is three days: the 17th is outside it, the 15th inside
    await create({ name: 'Near', schedule: monthly('2026-11-15') })
    await create({ name: 'Far', schedule: monthly('2026-11-17') })
    await create({ name: 'Watchful', schedule: monthly('2026-11-17'), remindDays: 10 })

    const states = new Map((await service.snapshot()).rows.map(r => [r.series.name, r.state]))
    expect([states.get('Near'), states.get('Far'), states.get('Watchful')]).toEqual(['dueSoon', 'upcoming', 'dueSoon'])
  })

  it('totals what is outstanding, per currency, counting every missed occurrence', async () => {
    const { service, accounts, create } = await book()
    const euro = await accounts.createAccount({
      name: 'Euro', type: 'chequing', subBookId: null, currency: 'EUR', openingDate: '2026-01-01', openingBalance: 0
    })
    await create({ name: 'Fee', accountId: euro.id, schedule: monthly('2026-10-02'), template: template({ amount: -2500, payee: 'Bank' }) })

    const { summary } = await service.snapshot()
    expect(summary.overdueCount).toBe(2)
    // Hydro is three months of 142.00; the euro fee is two months of 25.00
    expect(summary.overdueTotals).toEqual({ CAD: -42600, EUR: -5000 })
    // Due today and due soon: rent and the phone
    expect(summary.dueSoonCount).toBe(2)
    expect(summary.dueSoonTotals).toEqual({ CAD: -128000 })
  })

  it('resolves what each row shows: the account, payee, category and schedule', async () => {
    const { create, service, accounts, chq, savings } = await setupRecurring()
    const rent = await accounts.categories.create('Housing : Rent', 'expense')
    await create({ name: 'Rent', schedule: monthly('2026-11-20'), template: template({ payee: 'Landlord', categoryId: rent.id, amount: -120000 }) })
    await service.create({
      accountId: chq.id, name: 'To savings', schedule: monthly('2026-11-21'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })

    const rows = (await service.snapshot()).rows
    expect(rows[0]).toMatchObject({
      kind: 'payment', payeeName: 'Landlord', categoryLabel: 'Housing : Rent',
      scheduleLabel: 'Monthly on the 20th',
      account: { id: chq.id, name: 'Chequing', currency: 'CAD', closed: false }
    })
    expect(rows[1]).toMatchObject({ kind: 'transfer', categoryLabel: 'Transfer to: Savings' })
    expect(rows[1].payeeName).toBeUndefined()
  })

  it('hides a series the user paused, unless it is asked for', async () => {
    const { create, service } = await setupRecurring()
    const paused = await create({ name: 'Paused', schedule: monthly('2026-11-20') })
    await create({ name: 'Live', schedule: monthly('2026-11-21') })
    await service.setPaused([paused.id], true)

    expect((await service.snapshot()).rows.map(r => r.series.name)).toEqual(['Live'])
    const shown = (await service.snapshot({ includePaused: true })).rows
    // A paused series sorts after the live ones, whatever its date
    expect(shown.map(r => [r.series.name, r.state])).toEqual([['Live', 'upcoming'], ['Paused', 'paused']])
    expect(shown.find(r => r.series.name === 'Paused')!.dueCount).toBe(0)
  })

  it('hides a finished series unless it is asked for, and sorts it last', async () => {
    const { create, service } = await setupRecurring()
    const ended = await create({ name: 'Ended', schedule: monthly('2026-11-10', { end: { kind: 'afterCount', count: 1 } }) })
    await create({ name: 'Live', schedule: monthly('2026-11-20') })
    await service.skip([ended.id])

    expect((await service.snapshot()).rows.map(r => r.series.name)).toEqual(['Live'])
    const shown = (await service.snapshot({ includeEnded: true })).rows
    expect(shown.map(r => [r.series.name, r.state])).toEqual([['Live', 'upcoming'], ['Ended', 'ended']])
    expect(shown[1].occurrence).toBeUndefined()
  })
})

describe('a series that cannot run', () => {
  it('is always shown, with the reason, even though the plugin paused it', async () => {
    const { create, service, accounts, savings } = await setupRecurring()
    const series = await create({ name: 'Savings bill', accountId: savings.id, schedule: monthly('2026-11-20') })
    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })
    await service.handleAccountsChange({ deleted: [], updated: [savings.id] })

    // Paused by the plugin, not by the user, so it stays in view: the user never asked for it to stop
    expect(await service.get(series.id)).toMatchObject({ paused: true, pausedReason: 'accountClosed' })
    const row = (await service.snapshot()).rows.find(r => r.series.id === series.id)!
    expect(row.state).toBe('paused')
    expect(row.blockedReason).toMatch(/“Savings” is closed/)
    expect((await service.snapshot()).summary.blockedCount).toBe(1)
  })

  it('says when the account it transfers to has closed', async () => {
    const { service, accounts, chq, savings } = await setupRecurring()
    const series = await service.create({
      accountId: chq.id, name: 'Move', schedule: monthly('2026-11-20'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })
    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })

    const row = (await service.snapshot()).rows.find(r => r.series.id === series.id)!
    expect(row.blockedReason).toMatch(/“Savings” is closed/)
  })
})

describe('following the account manager', () => {
  it('resumes a series when its account is reopened, but not one the user paused', async () => {
    const { create, service, accounts, savings } = await setupRecurring()
    const auto = await create({ name: 'Auto', accountId: savings.id, schedule: monthly('2026-11-20') })
    const byUser = await create({ name: 'By user', accountId: savings.id, schedule: monthly('2026-11-21') })
    await service.setPaused([byUser.id], true)

    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })
    await service.handleAccountsChange({ deleted: [], updated: [savings.id] })
    expect(await service.get(auto.id)).toMatchObject({ paused: true, pausedReason: 'accountClosed' })
    expect(await service.get(byUser.id)).toMatchObject({ paused: true, pausedReason: 'user' })

    await accounts.reopenAccount(savings.id)
    await service.handleAccountsChange({ deleted: [], updated: [savings.id] })
    expect(await service.get(auto.id)).toMatchObject({ paused: false })
    // The user's own pause survives: only the plugin's is undone
    expect(await service.get(byUser.id)).toMatchObject({ paused: true, pausedReason: 'user' })
  })

  it('deletes the series of a deleted account, and keeps the others', async () => {
    const { create, service, accounts, savings, chq } = await setupRecurring()
    const doomed = await create({ name: 'Doomed', accountId: savings.id, schedule: monthly('2026-11-20') })
    const safe = await create({ name: 'Safe', accountId: chq.id, schedule: monthly('2026-11-21') })

    await accounts.deleteAccount(savings.id)
    await service.handleAccountsChange({ deleted: [savings.id], updated: [] })

    expect(await service.get(doomed.id)).toBeUndefined()
    expect(await service.get(safe.id)).toBeDefined()
    expect(await service.history(doomed.id)).toEqual([])
  })

  it('pauses rather than guesses when the account a series transfers to is deleted', async () => {
    const { service, accounts, chq, savings } = await setupRecurring()
    const series = await service.create({
      accountId: chq.id, name: 'Move', schedule: monthly('2026-11-20'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })

    await accounts.deleteAccount(savings.id)
    await service.handleAccountsChange({ deleted: [savings.id], updated: [] })

    const orphaned = (await service.get(series.id))!
    expect(orphaned).toMatchObject({ paused: true, pausedReason: 'transferAccountGone' })
    // The transfer is cleared rather than left pointing at nothing; the user decides what it should do now
    expect(orphaned.template.transferAccountId).toBeUndefined()
  })

  it('does nothing, and never throws, when there is nothing to follow', async () => {
    const { service, chq } = await setupRecurring()
    await expect(service.handleAccountsChange({ deleted: [], updated: [] })).resolves.toBeUndefined()
    await expect(service.handleAccountsChange({ deleted: ['gone'], updated: ['gone'] })).resolves.toBeUndefined()
    await expect(service.handleAccountsChange({ deleted: [], updated: [chq.id] })).resolves.toBeUndefined()
  })
})

describe('the forecast', () => {
  it('gives every occurrence in a window, not just the next, ascending', async () => {
    const { create, service, chq } = await setupRecurring()
    await create({ name: 'Hydro', schedule: monthly('2026-11-15') })
    await create({ name: 'Pay', schedule: { frequency: 'semiMonthly', interval: 1, startDate: '2026-11-01' }, template: template({ amount: 200000, payee: 'Employer' }) })

    const entries = await service.forecast({ from: '2026-11-14', to: '2026-12-31' })
    expect(entries.map(e => [e.date, e.name])).toEqual([
      ['2026-11-15', 'Hydro'],
      ['2026-11-30', 'Pay'],
      ['2026-12-01', 'Pay'],
      ['2026-12-15', 'Hydro'],
      ['2026-12-31', 'Pay']
    ])
    expect(entries[0]).toMatchObject({ accountId: chq.id, currency: 'CAD', kind: 'payment', amount: -14200, estimated: false })
    expect(entries[1].kind).toBe('deposit')
  })

  it('never looks behind what has already been entered', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ name: 'Hydro', schedule: monthly('2026-09-15') })
    await service.enter([{ seriesId: series.id }], { confirm: [] })

    // September is in the register now, so the forecast starts at October even when asked from August
    const entries = await service.forecast({ from: '2026-08-01', to: '2026-11-30' })
    expect(entries.map(e => e.date)).toEqual(['2026-10-15', '2026-11-15'])
  })

  it('leaves out paused series unless asked, and refuses a silly range', async () => {
    const { create, service } = await setupRecurring()
    const paused = await create({ name: 'Paused', schedule: monthly('2026-11-20') })
    await service.setPaused([paused.id], true)

    expect(await service.forecast({ from: '2026-11-01', to: '2026-12-31' })).toEqual([])
    expect(await service.forecast({ from: '2026-11-01', to: '2026-12-31' }, { includePaused: true })).toHaveLength(2)

    await expect(service.forecast({ from: '2026-12-31', to: '2026-01-01' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(service.forecast({ from: '2020-01-01', to: '2060-01-01' })).rejects.toMatchObject({ field: 'to' })
  })
})
