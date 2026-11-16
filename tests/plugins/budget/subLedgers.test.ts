// @vitest-environment node
// Deleting a budget's sub-ledger (docs/budget-design.md, "Sub-ledgers: when a budget's sub-ledger is deleted"): the
// budget moves with the contents, and covers the parent from then on; so do the archived months kept with it.
import { describe, expect, it } from 'vitest'
import { BUDGET_COLLECTIONS } from '@tessera/budget-api'
import { budgetInput, household, setupBudget } from './harness'

/**
 * Lets everything already queued run: on the memory engine the service's work is all promises, so once a macrotask
 * comes round, every announcement a change leads to has been made. Not a guess at a duration.
 */
const everythingQueued = () => new Promise(resolve => setTimeout(resolve, 0))

describe('deleting a sub-ledger', () => {
  it('moves a budget over it to its parent, and says so in the confirmation', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const kids = await env.session.createSubLedger({ name: 'Kids', parentId: h.personal.id })
    const one = await env.budgets.create(budgetInput({ name: 'Kids', subLedgerId: kids.id }))
    const two = await env.budgets.create(budgetInput({ name: 'Kids, lean', subLedgerId: kids.id }))
    const other = await env.budgets.create(budgetInput({ name: 'Household', subLedgerId: h.personal.id }))

    expect(await env.session.describeContents(kids.id)).toContain('2 budgets')
    expect(await env.session.describeContents(h.business.id)).not.toContain(expect.stringContaining('budget'))
    env.budgetChanges.length = 0
    await env.session.deleteSubLedger(kids.id)

    expect((await env.budgets.get(one.id))?.subLedgerId).toBe(h.personal.id)
    expect((await env.budgets.get(two.id))?.subLedgerId).toBe(h.personal.id)
    expect((await env.budgets.get(other.id))?.subLedgerId).toBe(h.personal.id)
    expect(env.budgetChanges).toContainEqual({ budgets: [one.id, two.id], deleted: [], lines: [], actuals: true })
  })

  it('says "1 budget" for one', async () => {
    const env = await setupBudget()
    const h = await household(env)
    await env.budgets.create(budgetInput({ subLedgerId: h.rentals.id }))
    expect(await env.session.describeContents(h.rentals.id)).toContain('1 budget')
  })

  it('moves the archived months kept with it, as their own sub-ledger or a transfer\'s other side', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const months = env.session.database('budget').collection(BUDGET_COLLECTIONS.archivedMonths)
    await months.insertMany([
      { accountId: 'gone', month: '2024-01', currency: 'CAD', subLedgerId: h.rentals.id, categories: { '': [0, 5, 1] }, transfers: { other: [0, 7, 1, h.rentals.id] } },
      { accountId: 'kept', month: '2024-01', currency: 'CAD', subLedgerId: h.business.id, categories: {}, transfers: { x: [1, 0, 1, h.rentals.id], y: [1, 0, 1, h.business.id] } }
    ])
    await env.session.deleteSubLedger(h.rentals.id)
    const docs = await months.find({}, { sort: { accountId: 1 } })
    expect(docs.map(d => [d.accountId, d.subLedgerId, d.transfers])).toEqual([
      ['gone', null, { other: [0, 7, 1, null] }],
      ['kept', h.business.id, { x: [1, 0, 1, null], y: [1, 0, 1, h.business.id] }]
    ])
  })

  it('rolls back with the delete when another participant fails', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput({ subLedgerId: h.rentals.id }))
    env.session.participate('zzz', { describe: async () => undefined, reparent: async () => { throw new Error('no') } })
    await expect(env.session.deleteSubLedger(h.rentals.id)).rejects.toThrow()
    expect((await env.budgets.get(b.id))?.subLedgerId).toBe(h.rentals.id)
  })

  it('announces a budget moved only once the delete is committed: not after one that rolled back', async () => {
    const env = await setupBudget()
    const h = await household(env)
    const b = await env.budgets.create(budgetInput({ name: 'Business', subLedgerId: h.business.id }))
    // Another plugin refuses the delete after the budget's part ran: the whole delete rolls back
    const refusing = env.session.participate('zzz', { describe: async () => undefined, reparent: async () => { throw new Error('no') } })
    await expect(env.session.deleteSubLedger(h.business.id)).rejects.toThrow('no')
    expect((await env.budgets.get(b.id))?.subLedgerId).toBe(h.business.id)
    env.budgetChanges.length = 0
    await env.session.createSubLedger({ name: 'Later', parentId: null })
    await everythingQueued()
    // What covers the budgets changed (the tree, and the accounts plugin's own news of it), but the budget didn't move
    expect(env.budgetChanges.length).toBeGreaterThan(0)
    expect(env.budgetChanges.filter(c => c.budgets.includes(b.id))).toEqual([])
    // Deleted for real: announced
    refusing.dispose()
    env.budgetChanges.length = 0
    await env.session.deleteSubLedger(h.business.id)
    await everythingQueued()
    expect(env.budgetChanges).toContainEqual({ budgets: [b.id], deleted: [], lines: [], actuals: true })
  })
})
