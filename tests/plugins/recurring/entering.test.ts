// @vitest-environment node
// Entering an occurrence into a real register, skipping one, and making a series from a transaction that is
// already there. Nothing below the service is faked: the transactions these write are the account manager's.
import { describe, expect, it } from 'vitest'
import { monthly, rejection, setupRecurring, template } from './harness'

describe('entering an occurrence', () => {
  it('writes the transaction and advances the series, in one go', async () => {
    const { create, service, accounts, chq, changes } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-11-10'), template: template({ memo: 'Account 55-1' }) })
    changes.length = 0

    const result = await service.enter([{ seriesId: series.id }])
    expect(result.failed).toEqual([])
    expect(result.entered).toEqual([
      { seriesId: series.id, transactionId: expect.any(String), accountId: chq.id, date: '2026-11-10', amount: -14200 }
    ])

    // In the register, dated the day it fell due, uncleared: a scheduled transaction has not reached the bank
    const written = (await accounts.transactions(chq.id).get(result.entered[0].transactionId))!
    expect(written).toMatchObject({ date: '2026-11-10', amount: -14200, memo: 'Account 55-1', status: 'uncleared', voided: false })

    const moved = (await service.get(series.id))!
    expect(moved).toMatchObject({ nextIndex: 1, nextDate: '2026-12-10', enteredCount: 1, skippedCount: 0, lastEnteredDate: '2026-11-10' })
    expect(changes.at(-1)).toMatchObject({ updated: [series.id], accounts: [chq.id] })
  })

  it('creates the payee, and keeps the category', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const groceries = await accounts.categories.create('Food : Groceries', 'expense')
    const series = await create({ schedule: monthly('2026-11-10'), template: template({ payee: 'Metro', categoryId: groceries.id }) })

    const { entered } = await service.enter([{ seriesId: series.id }])
    const written = (await accounts.transactions(chq.id).get(entered[0].transactionId))!
    expect(written.categoryId).toBe(groceries.id)
    expect((await accounts.payees.search('Met')).map(p => p.name)).toEqual(['Metro'])
  })

  it('writes both sides of a transfer', async () => {
    const { service, accounts, chq, savings } = await setupRecurring()
    const series = await service.create({
      accountId: chq.id, schedule: monthly('2026-11-10'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })
    const { entered } = await service.enter([{ seriesId: series.id }])

    const here = (await accounts.transactions(chq.id).get(entered[0].transactionId))!
    expect(here).toMatchObject({ amount: -50000, transferAccountId: savings.id })
    const there = (await accounts.transactions(savings.id).list()).find(t => t.transferId === here.transferId)
    expect(there).toMatchObject({ amount: 50000, transferAccountId: chq.id })
  })

  it('takes the next cheque number when the series asks for one', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    await accounts.transactions(chq.id).create({ date: '2026-10-01', amount: -1000, number: '417' })
    const series = await create({ schedule: monthly('2026-11-10'), template: template({ autoNumber: true }) })

    const { entered } = await service.enter([{ seriesId: series.id }])
    expect((await accounts.transactions(chq.id).get(entered[0].transactionId))!.number).toBe('418')
  })

  it('takes an amount, a date, a number and a memo from the request', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-11-10') })
    const { entered } = await service.enter([
      { seriesId: series.id, amount: -15075, date: '2026-11-12', number: 'EFT', memo: 'Paid late' }
    ])

    expect((await accounts.transactions(chq.id).get(entered[0].transactionId))!)
      .toMatchObject({ date: '2026-11-12', amount: -15075, number: 'EFT', memo: 'Paid late' })
    // The series keeps its own amount: one entry is not a change of plan
    expect((await service.get(series.id))!.template.amount).toBe(-14200)
    expect((await service.get(series.id))!.lastEnteredDate).toBe('2026-11-12')
  })

  it('stores a new estimate only when asked to', async () => {
    const { create, service } = await setupRecurring()
    const varies = await create({ schedule: monthly('2026-11-10'), template: template({ estimated: true }) })
    await service.enter([{ seriesId: varies.id, amount: -15500 }])
    expect((await service.get(varies.id))!.template.amount).toBe(-14200)

    await service.enter([{ seriesId: varies.id, amount: -16000, updateEstimate: true }])
    expect((await service.get(varies.id))!.template.amount).toBe(-16000)
  })

  it('finishes a series whose last occurrence it just entered', async () => {
    const { create, service, today } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-11-10', { end: { kind: 'afterCount', count: 1 } }) })
    await service.enter([{ seriesId: series.id }])

    const done = (await service.get(series.id))!
    expect(done).toMatchObject({ nextDate: null, endedOn: today, enteredCount: 1 })
    // `enter` reports rather than throws: one bad occurrence must not sink the others
    expect((await service.enter([{ seriesId: series.id }])).failed)
      .toEqual([{ seriesId: series.id, code: 'SERIES_ENDED', message: expect.stringMatching(/finished/) }])
  })

  it('records what it did, so the history can be read back', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-09-10') })
    await service.enter([{ seriesId: series.id }])
    await service.skip([series.id])

    const history = await service.history(series.id)
    expect(history.map(p => [p.index, p.dueDate, p.outcome])).toEqual([
      [1, '2026-10-10', 'skipped'],
      [0, '2026-09-10', 'entered']
    ])
    expect(history[1]).toMatchObject({ amount: -14200, date: '2026-09-10', transactionId: expect.any(String) })
    expect(history[0].transactionId).toBeUndefined()
  })
})

describe('entering several at once', () => {
  it('enters them in the order they fell due, and reports what it did', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const later = await create({ name: 'Later', schedule: monthly('2026-11-12') })
    const earlier = await create({ name: 'Earlier', schedule: monthly('2026-11-10') })

    const result = await service.enter([{ seriesId: later.id }, { seriesId: earlier.id }])
    expect(result.failed).toEqual([])
    expect(result.entered.map(e => e.date)).toEqual(['2026-11-10', '2026-11-12'])
    expect((await accounts.transactions(chq.id).list()).map(t => t.date)).toEqual(['2026-11-10', '2026-11-12'])
  })

  it('enters what it can and reports what it cannot, rather than rolling back', async () => {
    const { create, service, accounts, savings } = await setupRecurring()
    const good = await create({ name: 'Good', schedule: monthly('2026-11-10') })
    const onClosed = await create({ name: 'Closed', accountId: savings.id, schedule: monthly('2026-11-11') })
    const paused = await create({ name: 'Paused', schedule: monthly('2026-11-12') })
    await service.setPaused([paused.id], true)
    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })

    const result = await service.enter([{ seriesId: good.id }, { seriesId: onClosed.id }, { seriesId: paused.id }, { seriesId: 'gone' }])
    expect(result.entered.map(e => e.seriesId)).toEqual([good.id])
    expect(result.failed.map(f => f.code).sort()).toEqual(['ACCOUNT_CLOSED', 'NOT_FOUND', 'SERIES_PAUSED'])
    expect(result.failed.find(f => f.seriesId === onClosed.id)!.message).toMatch(/Savings/)

    // The one that worked really went in, and only it moved on
    expect((await service.get(good.id))!.nextIndex).toBe(1)
    expect((await service.get(paused.id))!.nextIndex).toBe(0)
  })

  it('refuses an empty list', async () => {
    const { service } = await setupRecurring()
    expect((await rejection(service.enter([]))).field).toBe('requests')
  })
})

describe('what it asks before writing', () => {
  it('asks once, across every occurrence, before anything is written', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    // Already in the register, same date and amount: most likely this one was entered by hand
    await accounts.transactions(chq.id).create({ date: '2026-11-10', amount: -14200, payee: 'Hydro' })
    const duplicate = await create({ name: 'Hydro', schedule: monthly('2026-11-10') })
    const far = await create({ name: 'Far', schedule: monthly('2028-06-01') })

    const asked = await rejection(service.enter([{ seriesId: duplicate.id }, { seriesId: far.id }]))
    expect(asked.code).toBe('CONFIRMATION_REQUIRED')
    expect([...asked.reasons!].sort()).toEqual(['possibleDuplicate', 'unusualDate'])
    // Nothing was written: the question comes first
    expect(await accounts.transactions(chq.id).list()).toHaveLength(1)
    expect((await service.get(duplicate.id))!.nextIndex).toBe(0)

    const done = await service.enter([{ seriesId: duplicate.id }, { seriesId: far.id }],
      { confirm: ['possibleDuplicate', 'unusualDate'] })
    expect(done.entered).toHaveLength(2)
    expect(await accounts.transactions(chq.id).list()).toHaveLength(3)
  })

  it('does not count a voided transaction as a duplicate', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const existing = await accounts.transactions(chq.id).create({ date: '2026-11-10', amount: -14200 })
    await accounts.transactions(chq.id).setVoided([existing.id], true)
    const series = await create({ schedule: monthly('2026-11-10') })

    await expect(service.enter([{ seriesId: series.id }])).resolves.toMatchObject({ failed: [] })
  })

  it('never asks on behalf of an occurrence that could not be entered anyway', async () => {
    const { create, service, accounts, savings } = await setupRecurring()
    // Dated far ahead, but its account is closed, so it is a failure rather than a question
    const blocked = await create({ name: 'Blocked', accountId: savings.id, schedule: monthly('2028-06-01') })
    await accounts.closeAccount(savings.id, { confirm: ['closeWithBalance'] })

    const result = await service.enter([{ seriesId: blocked.id }])
    expect(result.entered).toEqual([])
    expect(result.failed[0].code).toBe('ACCOUNT_CLOSED')
  })
})

describe('skipping', () => {
  it('passes over the next occurrence without writing anything', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-09-15') })
    await service.skip([series.id])

    expect(await service.get(series.id)).toMatchObject({ nextIndex: 1, nextDate: '2026-10-15', skippedCount: 1, enteredCount: 0 })
    expect(await accounts.transactions(chq.id).list()).toEqual([])
    expect((await service.history(series.id))[0]).toMatchObject({ index: 0, dueDate: '2026-09-15', outcome: 'skipped' })
  })

  it('passes over everything due at once, for a book left alone for months', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-08-15') })
    // Four are due on or before today: August to November
    await service.skip([series.id], { count: 4 })

    expect(await service.get(series.id)).toMatchObject({ nextDate: '2026-12-15', skippedCount: 4 })
    expect(await service.history(series.id)).toHaveLength(4)
  })

  it('stops at the end of a series rather than running past it', async () => {
    const { create, service, today } = await setupRecurring()
    const series = await create({ schedule: monthly('2026-09-15', { end: { kind: 'afterCount', count: 2 } }) })
    await service.skip([series.id], { count: 10 })

    expect(await service.get(series.id)).toMatchObject({ nextDate: null, endedOn: today, skippedCount: 2 })
    expect((await rejection(service.skip([series.id]))).code).toBe('SERIES_ENDED')
  })
})

describe('making a series from a transaction already in a register', () => {
  /** What the dialog is prefilled with, then saved as — the service does both halves. */
  const fromTransaction = async (
    service: Awaited<ReturnType<typeof setupRecurring>>['service'],
    accountId: string, transactionId: string, over: Partial<Parameters<typeof service.create>[0]> = {}
  ) => {
    const { template: prefill } = await service.templateFrom(accountId, transactionId)
    return service.createFromTransaction(
      { accountId, template: prefill, schedule: monthly('2026-11-01'), ...over },
      { accountId, transactionId })
  }

  it('prefills from the transaction, leaving out what does not repeat', async () => {
    const { service, accounts, chq } = await setupRecurring()
    const rent = await accounts.categories.create('Housing : Rent', 'expense')
    const paid = await accounts.transactions(chq.id).create({
      date: '2026-11-01', amount: -120000, payee: 'Landlord', categoryId: rent.id, memo: 'November', number: '0417'
    })

    const { date, template: prefill } = await service.templateFrom(chq.id, paid.id)
    expect(date).toBe('2026-11-01')
    expect(prefill).toMatchObject({ amount: -120000, payee: 'Landlord', categoryId: rent.id, memo: 'November' })
    // A cheque number does not repeat
    expect(prefill.number).toBeUndefined()
  })

  it('starts after the transaction, so nothing is entered twice', async () => {
    const { service, accounts, chq } = await setupRecurring()
    const paid = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -120000, payee: 'Landlord' })

    const series = await fromTransaction(service, chq.id, paid.id)
    expect(series).toMatchObject({
      name: 'Landlord', accountId: chq.id, nextDate: '2026-12-01', lastEnteredDate: '2026-11-01', enteredCount: 1
    })

    // The register is untouched: one transaction, the one that was already there
    expect(await accounts.transactions(chq.id).list()).toHaveLength(1)
    // …and it is recorded as the series' first entry, so it reads back as history
    expect((await service.history(series.id))[0]).toMatchObject({ transactionId: paid.id, outcome: 'entered', index: -1 })
  })

  it('stores what the user confirmed, not what the transaction said', async () => {
    const { service, accounts, chq } = await setupRecurring()
    const paid = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -120000, payee: 'Landlord' })

    // The dialog is the same one New… opens, so everything in it can be changed before saving
    const series = await fromTransaction(service, chq.id, paid.id, {
      name: 'The rent',
      template: { amount: -125000, payee: 'New Landlord', autoNumber: true, estimated: true },
      schedule: monthly('2026-11-01', { monthlyRule: { kind: 'dayOfMonth', day: 5 } })
    })

    // The first occurrence of the *edited* rule after the transaction's date: 1 November was paid, 5 November is next
    expect(series).toMatchObject({ name: 'The rent', nextDate: '2026-11-05' })
    expect(series.template).toMatchObject({ amount: -125000, payee: 'New Landlord', autoNumber: true, estimated: true })
    // The posting still records the transaction as it really was
    expect((await service.history(series.id))[0]).toMatchObject({ amount: -120000, dueDate: '2026-11-01' })
  })

  it('carries a transfer over', async () => {
    const { service, accounts, chq, savings } = await setupRecurring()
    const moved = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -50000, transferAccountId: savings.id })
    const series = await fromTransaction(service, chq.id, moved.id)

    expect(series.template.transferAccountId).toBe(savings.id)
    expect(series.name).toBe('Transfer to Savings')
  })

  it('refuses a transaction or an account that is not there', async () => {
    const { service, accounts, chq } = await setupRecurring()
    expect((await rejection(service.templateFrom(chq.id, 'nope'))).code).toBe('NOT_FOUND')
    expect((await rejection(service.templateFrom('gone', 'nope'))).code).toBe('NOT_FOUND')

    const paid = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -1000 })
    const good = { accountId: chq.id, template: template(), schedule: monthly('2026-11-01') }
    // A source that has gone, with an otherwise valid series
    expect((await rejection(service.createFromTransaction(good, { accountId: chq.id, transactionId: 'nope' }))).code).toBe('NOT_FOUND')

    await accounts.closeAccount(chq.id, { confirm: ['closeWithBalance'] })
    expect((await rejection(service.createFromTransaction(good, { accountId: chq.id, transactionId: paid.id }))).code).toBe('ACCOUNT_CLOSED')
  })
})
