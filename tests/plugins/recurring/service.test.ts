// @vitest-environment node
// `recurring.service`: creating and changing series, and the rules it enforces. Entering and skipping are in
// entering.test.ts; what the view sees is in snapshot.test.ts.
import { describe, expect, it } from 'vitest'
import { DEFAULT_REMIND_DAYS } from '@tessera/recurring-api'
import { monthly, rejection, setupRecurring, template } from './harness'

describe('creating a series', () => {
  it('stores it with its first occurrence worked out, and announces it', async () => {
    const { create, chq, changes } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-11-15') })

    expect(series).toMatchObject({
      accountId: chq.id, name: 'Hydro', nextIndex: 0, nextDate: '2026-11-15',
      enteredCount: 0, skippedCount: 0, paused: false, remindDays: DEFAULT_REMIND_DAYS, autoEnter: false
    })
    expect(series.endedOn).toBeUndefined()
    expect(changes.at(-1)).toMatchObject({ created: [series.id], snapshot: true })
  })

  it('names itself after the payee, the transfer, or the account, when it is not given a name', async () => {
    const { create, service, chq, savings } = await setupRecurring()
    expect((await create()).name).toBe('Hydro')
    expect((await create({ name: 'Hydro bill' })).name).toBe('Hydro bill')

    const transfer = await service.create({
      accountId: chq.id, schedule: monthly('2026-12-01'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })
    expect(transfer.name).toBe('Transfer to Savings')

    const bare = await service.create({
      accountId: chq.id, schedule: monthly('2026-12-02'), template: template({ payee: undefined, amount: -100 })
    })
    expect(bare.name).toBe('Recurring in Chequing')
  })

  it('starts at the first occurrence even when the schedule began in the past', async () => {
    const { create } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-08-15') })
    expect(series.nextDate).toBe('2026-08-15')
    expect(series.nextIndex).toBe(0)
  })

  it('refuses an account that is closed, missing, or not named', async () => {
    const { create, accounts, chq } = await setupRecurring()
    expect((await rejection(create({ accountId: 'nope' }))).code).toBe('NOT_FOUND')
    expect((await rejection(create({ accountId: '' }))).code).toBe('INVALID')

    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    const closed = await rejection(create())
    expect(closed.code).toBe('ACCOUNT_CLOSED')
    expect(closed.message).toMatch(/Chequing/)
  })

  it('refuses a transfer that cannot be made', async () => {
    const { create, service, accounts, chq, savings } = await setupRecurring()
    expect((await rejection(create({ template: template({ transferAccountId: 'gone' }) }))).code).toBe('TRANSFER_UNAVAILABLE')
    expect((await rejection(create({ template: template({ transferAccountId: chq.id }) }))).message).toMatch(/itself/)

    const euro = await accounts.createAccount({
      name: 'Euro', type: 'savings', subBookId: null, currency: 'EUR', openingDate: '2026-01-01', openingBalance: 0
    })
    expect((await rejection(create({ template: template({ transferAccountId: euro.id }) }))).message).toMatch(/EUR/)

    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })
    expect((await rejection(create({ template: template({ transferAccountId: savings.id }) }))).message).toMatch(/closed/)

    // A transfer to an open account in the same currency is fine
    const other = await accounts.createAccount(chequing2())
    await expect(service.create({ accountId: chq.id, schedule: monthly('2026-12-01'), template: template({ transferAccountId: other.id }) }))
      .resolves.toMatchObject({ name: 'Hydro' })
  })

  const chequing2 = () => ({ name: 'Second', type: 'chequing' as const, subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })

  it('checks the template\'s fields', async () => {
    const { create } = await setupRecurring()
    const why = async (over: object) => (await rejection(create({ template: { ...template(), ...over } as never }))).field

    expect(await why({ amount: 'lots' })).toBe('amount')
    expect(await why({ amount: 0 })).toBe('amount')
    // Zero is allowed when the amount varies: it is an estimate nobody has made yet
    await expect(create({ template: template({ amount: 0, estimated: true }) })).resolves.toMatchObject({ nextIndex: 0 })
    expect(await why({ categoryId: 'c', transferAccountId: 'a' })).toBe('categoryId')
    expect(await why({ payee: 'x'.repeat(200) })).toBe('payee')
    expect(await why({ memo: 'x'.repeat(2000) })).toBe('memo')
    expect(await why({ estimated: 'yes' })).toBe('estimated')
  })

  it('checks the name, the reminder window and the schedule', async () => {
    const { create } = await setupRecurring()
    // A blank name is not a mistake: it means "call it after the payee"
    expect((await create({ name: '   ' })).name).toBe('Hydro')
    expect((await rejection(create({ name: 'x'.repeat(200) }))).field).toBe('name')
    expect((await rejection(create({ remindDays: -1 }))).field).toBe('remindDays')
    expect((await rejection(create({ remindDays: 500 }))).field).toBe('remindDays')

    const badSchedule = await rejection(create({ schedule: { frequency: 'monthly', interval: 0, startDate: '2026-11-15' } }))
    expect(badSchedule.field).toBe('schedule')
    expect(badSchedule.message).toMatch(/1 or more/)
  })

  it('drops a cheque number when the account supplies one automatically', async () => {
    const { create } = await setupRecurring()
    const series = await create({ template: template({ autoNumber: true, number: '501' }) })
    expect(series.template.number).toBeUndefined()
    expect(series.template.autoNumber).toBe(true)
  })
})

describe('listing series', () => {
  it('leaves out paused and finished ones unless they are asked for', async () => {
    const { create, service } = await setupRecurring()
    const live = await create({ name: 'Live' })
    const paused = await create({ name: 'Paused', schedule: monthly('2026-12-01') })
    const ended = await create({ name: 'Ended', schedule: monthly('2026-11-15', { end: { kind: 'afterCount', count: 1 } }) })
    await service.setPaused([paused.id], true)
    await service.skip([ended.id])

    expect((await service.list()).map(s => s.name)).toEqual(['Live'])
    expect((await service.list({ includePaused: true })).map(s => s.name).sort()).toEqual(['Live', 'Paused'])
    expect((await service.list({ includeEnded: true })).map(s => s.name).sort()).toEqual(['Ended', 'Live'])
    expect(await service.list({ includePaused: true, includeEnded: true })).toHaveLength(3)
    expect((await service.list({ accountId: live.accountId })).map(s => s.name)).toEqual(['Live'])
    expect(await service.list({ accountId: 'other' })).toEqual([])
  })

  it('filters by what a series does with money', async () => {
    const { create, chq, savings, service } = await setupRecurring()
    await create({ name: 'Bill' })
    await create({ name: 'Pay', template: template({ amount: 300000, payee: 'Employer' }), schedule: monthly('2026-11-20') })
    await service.create({
      accountId: chq.id, name: 'Move', schedule: monthly('2026-11-25'),
      template: template({ transferAccountId: savings.id, payee: undefined, amount: -50000 })
    })

    const named = async (kind: 'payment' | 'deposit' | 'transfer') => (await service.list({ kinds: [kind] })).map(s => s.name)
    expect(await named('payment')).toEqual(['Bill'])
    expect(await named('deposit')).toEqual(['Pay'])
    expect(await named('transfer')).toEqual(['Move'])
  })
})

describe('changing a series', () => {
  it('changes only what it is given, and clears a note with null', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ notes: 'The electricity bill' })
    const renamed = await service.update(series.id, { name: 'Power' })
    expect(renamed).toMatchObject({ name: 'Power', notes: 'The electricity bill', nextDate: '2026-11-15' })
    expect(renamed.template.amount).toBe(-14200)

    const cleared = await service.update(series.id, { notes: null })
    expect(cleared.notes).toBeUndefined()
    expect(cleared.name).toBe('Power')
  })

  it('keeps its place when the schedule has not changed', async () => {
    const { create, service } = await setupRecurring()
    const series = await create()
    await service.skip([series.id])
    const moved = (await service.get(series.id))!
    expect(moved.nextIndex).toBe(1)

    const changed = await service.update(series.id, { template: template({ amount: -15000 }) })
    expect(changed).toMatchObject({ nextIndex: 1, nextDate: '2026-12-15' })
  })

  it('places the next occurrence again when the schedule changes, after everything already dealt with', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-09-15') })
    await service.skip([series.id], { count: 2 })      // September and October are passed over
    expect((await service.get(series.id))!.nextDate).toBe('2026-11-15')

    // Move it to the 1st: the next one is 1 November, the first the new rule produces after 15 October — the
    // last date dealt with. 1 November has passed, so it is now overdue, which is the truth: it was never paid
    const changed = await service.update(series.id, { schedule: monthly('2026-09-01', { monthlyRule: { kind: 'dayOfMonth', day: 1 } }) })
    expect(changed).toMatchObject({ nextDate: '2026-11-01' })
  })

  it('starts again from the beginning when the schedule changes and nothing has been dealt with', async () => {
    const { create, service } = await setupRecurring()
    const series = await create()
    const changed = await service.update(series.id, { schedule: monthly('2027-03-10') })
    expect(changed).toMatchObject({ nextIndex: 0, nextDate: '2027-03-10' })
  })

  it('finishes a series whose new schedule has nothing left in it', async () => {
    const { create, service, today } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-09-15') })
    await service.skip([series.id], { count: 2 })
    const changed = await service.update(series.id, { schedule: monthly('2026-09-15', { end: { kind: 'onDate', date: '2026-10-20' } }) })
    expect(changed.nextDate).toBeNull()
    expect(changed.endedOn).toBe(today)
  })

  it('refuses a change that would break a rule, and a stale revision', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const series = await create()
    expect((await rejection(service.update(series.id, { template: template({ amount: 0 }) }))).field).toBe('amount')
    expect((await rejection(service.update('nope', { name: 'x' }))).code).toBe('NOT_FOUND')
    expect((await rejection(service.update(series.id, { name: 'x' }, { expectedRev: 99 }))).code).toBe('CONFLICT')

    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect((await rejection(service.update(series.id, { name: 'x' }))).code).toBe('ACCOUNT_CLOSED')
  })
})

describe('pausing, resuming and deleting', () => {
  it('pauses and resumes, recording that the user asked', async () => {
    const { create, service, changes } = await setupRecurring()
    const series = await create()
    await service.setPaused([series.id], true)
    expect(await service.get(series.id)).toMatchObject({ paused: true, pausedReason: 'user' })
    expect(changes.at(-1)!.updated).toEqual([series.id])

    await service.setPaused([series.id], false)
    const resumed = (await service.get(series.id))!
    expect(resumed.paused).toBe(false)
    expect(resumed.pausedReason).toBeUndefined()
  })

  it('says nothing changed when it did not', async () => {
    const { create, service, changes } = await setupRecurring()
    const series = await create()
    changes.length = 0
    await service.setPaused([series.id], false)
    expect(changes.at(-1)!.updated).toEqual([])
  })

  it('deletes a series with its history, leaving the transactions it made', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-11-10') })
    const { entered } = await service.enter([{ seriesId: series.id }])
    expect(entered).toHaveLength(1)

    await service.delete([series.id])
    expect(await service.get(series.id)).toBeUndefined()
    expect(await service.history(series.id)).toEqual([])
    // The money really moved, so the register keeps it
    const kept = await accounts.transactions(chq.id).get(entered[0].transactionId)
    expect(kept).toMatchObject({ amount: -14200 })
  })

  it('ignores ids that are already gone, and refuses a bad list', async () => {
    const { service } = await setupRecurring()
    await expect(service.delete(['nope'])).resolves.toBeUndefined()
    expect((await rejection(service.delete([42 as never]))).field).toBe('ids')
    expect((await rejection(service.skip('all' as never))).field).toBe('ids')
  })
})
