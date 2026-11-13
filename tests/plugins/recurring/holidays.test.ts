// @vitest-environment node
// The book's holidays, and what a business-day rule does with them: stored per book, stepped over when a date is
// worked out, and every series' next date placed again when the list changes.
import { describe, expect, it } from 'vitest'
import { monthly, rejection, setupRecurring, template } from './harness'

describe('keeping holidays', () => {
  it('adds, lists in date order, and removes', async () => {
    const { service, changes } = await setupRecurring()
    const boxing = await service.addHoliday({ date: '2026-12-26', name: 'Boxing Day' })
    const xmas = await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    expect((await service.holidays()).map(h => h.name)).toEqual(['Christmas Day', 'Boxing Day'])
    expect(changes.at(-1)).toMatchObject({ holidays: true })

    await service.removeHoliday(boxing.id)
    expect((await service.holidays()).map(h => h.id)).toEqual([xmas.id])
  })

  it('refuses a bad date, a repeated date, and names the nameless', async () => {
    const { service } = await setupRecurring()
    expect((await rejection(service.addHoliday({ date: 'xmas', name: 'x' }))).field).toBe('date')
    await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    const again = await rejection(service.addHoliday({ date: '2026-12-25', name: 'Again' }))
    expect(again).toMatchObject({ code: 'INVALID', field: 'date' })
    expect(again.message).toMatch(/already a holiday/)
    expect((await service.addHoliday({ date: '2027-01-01', name: '   ' })).name).toBe('Holiday')
  })
})

describe('a business-day rule with the book\'s holidays', () => {
  // Christmas Day 2026 is a Friday
  const xmas = monthly('2026-11-25', { weekendRule: 'after' })

  it('moves an occurrence off a holiday when it is worked out', async () => {
    const { create, service } = await setupRecurring()
    await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    await service.addHoliday({ date: '2026-12-28', name: 'Boxing Day, observed' })

    const series = await create({ schedule: xmas })
    await service.skip([series.id])                 // past 25 November
    // Friday the 25th, Saturday, Sunday and the observed Monday are all stepped over, to Tuesday the 29th
    expect((await service.get(series.id))!.nextDate).toBe('2026-12-29')
    const row = (await service.snapshot()).rows.find(r => r.series.id === series.id)!
    expect(row.occurrence).toEqual({ index: 1, date: '2026-12-29', scheduledDate: '2026-12-25' })
  })

  it('places every series\' next date again when a holiday is added or removed', async () => {
    const { create, service } = await setupRecurring()
    const series = await create({ schedule: xmas })
    await service.skip([series.id])
    expect((await service.get(series.id))!.nextDate).toBe('2026-12-25')

    const holiday = await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    // The Friday is a holiday now, so the 25th moves on to Monday the 28th — without the series being touched
    expect((await service.get(series.id))!.nextDate).toBe('2026-12-28')
    expect((await service.get(series.id))!.nextIndex).toBe(1)

    await service.removeHoliday(holiday.id)
    expect((await service.get(series.id))!.nextDate).toBe('2026-12-25')
  })

  it('leaves a series alone whose dates the holiday does not touch, and says which ones it moved', async () => {
    const { create, service, changes } = await setupRecurring()
    const touched = await create({ name: 'Touched', schedule: xmas })
    await service.skip([touched.id])
    const untouched = await create({ name: 'Untouched', schedule: monthly('2026-12-10') })
    const plain = await create({ name: 'No rule', schedule: monthly('2026-12-25') })
    changes.length = 0

    await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    expect(changes.at(-1)!.updated).toEqual([touched.id])
    expect((await service.get(untouched.id))!.nextDate).toBe('2026-12-10')
    // Without a rule the date stays, holiday or not
    expect((await service.get(plain.id))!.nextDate).toBe('2026-12-25')
  })

  it('enters on the moved date, and records the anchor it was moved from', async () => {
    const { create, service, accounts, chq } = await setupRecurring()
    await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    const series = await create({ schedule: monthly('2026-12-25', { weekendRule: 'before' }) })
    // Thursday the 24th: the business day before the holiday
    expect((await service.get(series.id))!.nextDate).toBe('2026-12-24')

    const { entered } = await service.enter([{ seriesId: series.id }])
    expect(entered[0].date).toBe('2026-12-24')
    expect((await accounts.transactions(chq.id).get(entered[0].transactionId))!.date).toBe('2026-12-24')
    expect((await service.history(series.id))[0]).toMatchObject({ dueDate: '2026-12-24', index: 0 })
  })

  it('forecasts with the same calendar, and says where a transfer lands', async () => {
    const { create, service, chq, savings } = await setupRecurring()
    await service.addHoliday({ date: '2026-12-25', name: 'Christmas Day' })
    await create({ name: 'Bill', schedule: monthly('2026-12-25', { weekendRule: 'before' }) })
    await service.create({
      accountId: chq.id, name: 'Move', schedule: monthly('2026-12-01'),
      template: template({ payee: undefined, transferAccountId: savings.id, amount: -50000 })
    })

    const entries = await service.forecast({ from: '2026-12-01', to: '2026-12-31' })
    expect(entries.map(e => [e.name, e.date])).toEqual([['Move', '2026-12-01'], ['Bill', '2026-12-24']])
    expect(entries[0].transferAccountId).toBe(savings.id)
    expect(entries[1].transferAccountId).toBeUndefined()
  })
})
