// @vitest-environment node
// When the last transaction a series entered is renamed — a bank import takes the bank's payee as the truth — the
// series is offered the new name, quietly, on its row. Nothing changes until the user takes it.
import { describe, expect, it } from 'vitest'
import { monthly, rejection, setupRecurring, template } from './harness'

async function enteredThenRenamed(to: string, over: { name?: string } = {}) {
  const env = await setupRecurring()
  const series = await env.create({ schedule: monthly('2026-11-10'), template: template({ payee: 'Hydro' }), ...over })
  const { entered } = await env.service.enter([{ seriesId: series.id }])
  await env.accounts.transactions(env.chq.id).update(entered[0].transactionId, { payee: to })
  return { ...env, series, transactionId: entered[0].transactionId }
}

const rowOf = async (env: Awaited<ReturnType<typeof enteredThenRenamed>>) =>
  (await env.service.snapshot()).rows.find(row => row.series.id === env.series.id)!

describe('the payee hint', () => {
  it('offers the name the register now uses for the last transaction the series entered', async () => {
    const env = await enteredThenRenamed('Hydro Ottawa')
    expect((await rowOf(env)).payeeHint).toEqual({ name: 'Hydro Ottawa', date: '2026-11-10' })
  })

  it('says nothing while the names agree, case and spacing aside', async () => {
    const env = await enteredThenRenamed('  hydro ')
    expect((await rowOf(env)).payeeHint).toBeUndefined()
  })

  it('says nothing for a series that has not entered anything yet', async () => {
    const env = await setupRecurring()
    const series = await env.create()
    expect((await env.service.snapshot()).rows.find(row => row.series.id === series.id)!.payeeHint).toBeUndefined()
  })

  it('says nothing once the transaction is voided', async () => {
    const env = await enteredThenRenamed('Hydro Ottawa')
    await env.accounts.transactions(env.chq.id).setVoided([env.transactionId], true)
    expect((await rowOf(env)).payeeHint).toBeUndefined()
  })
})

describe('taking it', () => {
  it('gives the series the new payee, and its name too when the name was only the old payee’s', async () => {
    const env = await enteredThenRenamed('Hydro Ottawa')
    expect(env.series.name).toBe('Hydro')
    const updated = await env.service.usePayee(env.series.id, 'Hydro Ottawa')
    expect(updated.template.payee).toBe('Hydro Ottawa')
    expect(updated.name).toBe('Hydro Ottawa')
    expect((await rowOf(env)).payeeHint).toBeUndefined()
  })

  it('keeps a name the user chose', async () => {
    const env = await enteredThenRenamed('Hydro Ottawa', { name: 'Electricity' })
    const updated = await env.service.usePayee(env.series.id, 'Hydro Ottawa')
    expect(updated.name).toBe('Electricity')
  })

  it('refuses an empty payee', async () => {
    const env = await enteredThenRenamed('Hydro Ottawa')
    expect((await rejection(env.service.usePayee(env.series.id, '  '))).code).toBe('INVALID')
  })
})
