// @vitest-environment node
// Matching and review, with the ledger, accounts, import and OFX plugins activated together. A user has typed some of
// October's transactions; the bank's October file (samples/statements) is imported; the register's buttons, Accept
// All and the Change Match dialog's choices do what the design says, for proposed matches, accepted matches and rows
// added as new. Changes interrupted between their steps are put right.
import { describe, expect, it } from 'vitest'
import { IMPORT_COLLECTIONS, IMPORT_COMMANDS } from '@tessera/import-api'
import type { StoredLine } from '../../../plugins/import/src/privileged/store'
import { FIT, OCTOBER, chequing, shape, typedThenImported, type Setup } from './typed'

describe('importing into an account the user keeps by hand', () => {
  it('proposes matches for what was typed, adds the rest, and changes nothing the user entered', async () => {
    const { report, entered, get, line, byBankId, manager } = await typedThenImported()
    expect(report!.results[0].counts).toEqual({ lines: 17, added: 11, matched: 4, possible: 2, duplicates: 0, invalid: 0 })

    // Proposals are records only: the typed transactions are exactly as they were
    for (const t of Object.values(entered)) expect(shape(await get(t.id))).toEqual(shape(t))
    expect((await line(FIT.costco))).toMatchObject({ outcome: 'matched', review: 'pending', proposedId: entered.costco.id, score: expect.any(Number) })
    expect((await line(FIT.keg)).proposedId).toBe(entered.keg.id)
    expect((await line(FIT.rent)).proposedId).toBe(entered.rent.id)
    // The second coffee had no entry of its own: it was added, and so was everything the user hadn't typed
    expect((await line(FIT.coffee)).proposedId).toBe(entered.coffee.id)
    expect(await line(FIT.coffee2)).toMatchObject({ outcome: 'added', review: 'pending', transactionId: (await byBankId(FIT.coffee2)).id })
    expect(await manager.list()).toHaveLength(6 + 11)
  })

  it('doesn’t propose a transaction an earlier import is still waiting on', async () => {
    const { env, account, entered, line } = await typedThenImported()
    // A second statement from another source with the same Hydro payment: Hydro is taken, so it is added
    const report = await env.manager.importStatements([{
      account: { accountNumber: '8812345678' }, currency: 'CAD',
      lines: [{ date: '2026-10-07', amount: '-80.00', payee: 'HYDRO ONE NETWORKS', externalId: 'OTHER-1' }]
    }], { label: 'Connected bank' })
    expect(report.results[0].counts).toMatchObject({ added: 1, matched: 0, possible: 0 })
    expect((await line(FIT.hydro)).proposedId).toBe(entered.hydro.id)
    expect(account.id).toBe(report.results[0].accountId)
  })
})

describe('Accept', () => {
  it('gives the transaction the bank’s date, amount and id, marks it E, keeps the user’s payee, category and memo', async () => {
    const { entered, accept, get, line, manager } = await typedThenImported()
    expect(await accept(FIT.costco)).toEqual({ ok: true, value: undefined })
    expect(manager.accountId).toBeDefined()
    const costco = await get(entered.costco.id)
    expect(shape(costco)).toEqual({ date: '2026-10-06', amount: -8412, status: 'electronic', externalId: FIT.costco })
    expect(costco.payeeId).toBe(entered.costco.payeeId)
    expect(costco.categoryId).toBe(entered.costco.categoryId)
    // What it was is kept, so Unmatch can put it back; the line is done
    expect(await line(FIT.costco)).toMatchObject({
      outcome: 'matched', review: 'done', transactionId: entered.costco.id, before: { date: '2026-10-05', amount: -8400, status: 'uncleared' }
    })
    expect((await line(FIT.costco)).proposedId).toBeUndefined()
    // The row moved to the bank's date, after what the bank posted on Oct 5
    const order = (await manager.list()).map(t => t.date)
    expect(order).toEqual([...order].sort())

    const keg = entered.keg
    await accept(FIT.keg)
    expect(await get(keg.id)).toMatchObject({ amount: -5750, date: '2026-10-03', memo: 'Dinner with Sam', categoryId: keg.categoryId })
  })

  it('keeps a cleared mark: the user’s C is stronger than the bank’s E', async () => {
    const { entered, accept, get, manager } = await typedThenImported()
    await manager.setStatus([entered.hydro.id], 'cleared')
    await accept(FIT.hydro)
    expect(shape(await get(entered.hydro.id))).toEqual({ date: '2026-10-07', amount: -8000, status: 'cleared', externalId: FIT.hydro })
  })

  it('learns how the bank writes the payee, but not from a cheque', async () => {
    const { accept, aliases } = await typedThenImported()
    await accept(FIT.costco)
    await accept(FIT.amazon)
    await accept(FIT.rent)                                                   // 'CHEQUE 101' names the cheque, not Landlord
    await accept(FIT.hydro)
    expect(await aliases()).toEqual([['costco whse', 'Costco'], ['amzn mktp', 'Amazon'], ['hydro one networks', 'Hydro One']])
  })

  it('acknowledges a row added as new, and changes nothing in it', async () => {
    const { accept, line, byBankId } = await typedThenImported()
    const before = await byBankId(FIT.loblaws)
    await accept(FIT.loblaws)
    expect((await line(FIT.loblaws)).review).toBe('done')
    expect(await byBankId(FIT.loblaws)).toEqual(before)
  })

  it('leaves the row as an ordinary one, with Change Match… in its menu', async () => {
    const { entered, accept, mark } = await typedThenImported()
    expect((await mark(entered.costco.id))!.actions.map(a => a.label)).toEqual(['Accept', 'Change…'])
    await accept(FIT.costco)
    expect(await mark(entered.costco.id)).toMatchObject({
      review: false, detail: { parts: [] }, actions: [{ label: 'Change Match…', placement: 'menu', command: IMPORT_COMMANDS.change }]
    })
  })

  it('says so when the line is gone or has nothing to accept', async () => {
    const { run, line, entered, manager } = await typedThenImported()
    expect(await run(IMPORT_COMMANDS.accept, { lineIds: ['nope'] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await run(IMPORT_COMMANDS.accept, {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await manager.delete([entered.keg.id])                                   // the proposal's transaction: the line is unresolved
    expect(await run(IMPORT_COMMANDS.accept, { lineIds: [(await line(FIT.keg)).id] }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: expect.stringContaining('Use Change…') } })
  })
})

describe('Accept All', () => {
  it('asks first, saying how many change a date or an amount, then accepts every row to review', async () => {
    const { env, account, run, c, entered, get } = await typedThenImported()
    env.prompts.confirm.mockResolvedValueOnce(true)
    expect(await run(IMPORT_COMMANDS.acceptAll, { accountId: account.id })).toEqual({ ok: true, value: undefined })
    expect(env.prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Accept 6 matches and 11 new transactions?', detail: '4 matches change a date or an amount to the bank’s.', confirmLabel: 'Accept All'
    }))
    expect(await c().lines.find({ accountId: account.id, review: 'pending' })).toEqual([])
    expect(shape(await get(entered.amazon.id))).toEqual({ date: '2026-10-27', amount: -2399, status: 'electronic', externalId: FIT.amazon })
  })

  it('does nothing when the user says no', async () => {
    const { env, account, run, c } = await typedThenImported()
    env.prompts.confirm.mockResolvedValueOnce(false)
    await run(IMPORT_COMMANDS.acceptAll, { accountId: account.id })
    expect(await c().lines.find({ accountId: account.id, review: 'pending' })).toHaveLength(17)
  })
})

describe('Change… on a proposed match', () => {
  it('to another transaction: applied at once with the bank’s date and amount; the first proposal is left alone', async () => {
    const { entered, change, get, line, manager, aliases } = await typedThenImported()
    const other = await manager.create({ date: '2026-10-06', amount: -8412, payee: 'Costco Wholesale' })
    expect(await change(FIT.costco, { kind: 'match', transactionId: other.id, rememberPayee: true })).toEqual({ ok: true, value: undefined })
    expect(shape(await get(other.id))).toEqual({ date: '2026-10-06', amount: -8412, status: 'electronic', externalId: FIT.costco })
    expect(shape(await get(entered.costco.id))).toEqual(shape(entered.costco))
    expect(await line(FIT.costco)).toMatchObject({ outcome: 'matched', review: 'done', transactionId: other.id })
    expect(await aliases()).toEqual([['costco whse', 'Costco Wholesale']])
  })

  it('learns no payee unless asked', async () => {
    const { change, manager, aliases } = await typedThenImported()
    const other = await manager.create({ date: '2026-10-06', amount: -8412, payee: 'Warehouse' })
    await change(FIT.costco, { kind: 'match', transactionId: other.id, rememberPayee: false })
    expect(await aliases()).toEqual([])
  })

  it('to the proposal itself: the same as Accept, learning the payee only if asked', async () => {
    const { entered, change, get, aliases } = await typedThenImported()
    await change(FIT.costco, { kind: 'match', transactionId: entered.costco.id, rememberPayee: false })
    expect(shape(await get(entered.costco.id))).toMatchObject({ amount: -8412, externalId: FIT.costco })
    expect(await aliases()).toEqual([])
    await change(FIT.amazon, { kind: 'match', transactionId: entered.amazon.id, rememberPayee: true })
    expect(await aliases()).toEqual([['amzn mktp', 'Amazon']])
  })

  it('Unmatch: the transaction stays as it is, and the bank line is added as its own, already acknowledged', async () => {
    const { entered, change, get, line, byBankId } = await typedThenImported()
    await change(FIT.keg, { kind: 'unmatch' })
    expect(shape(await get(entered.keg.id))).toEqual(shape(entered.keg))
    const added = await byBankId(FIT.keg)
    expect(added).toMatchObject({ date: '2026-10-03', amount: -5750, status: 'electronic' })
    expect(added.id).not.toBe(entered.keg.id)
    expect(await line(FIT.keg)).toMatchObject({ outcome: 'added', review: 'done', transactionId: added.id })
    expect((await line(FIT.keg)).proposedId).toBeUndefined()
  })

  it('Don’t import: the line is left out, and doesn’t come back on the next import', async () => {
    const { env, entered, change, get, line, byBankId } = await typedThenImported()
    await change(FIT.keg, { kind: 'skip' })
    expect(await line(FIT.keg)).toMatchObject({ outcome: 'skipped', review: 'done' })
    expect(shape(await get(entered.keg.id))).toEqual(shape(entered.keg))
    const again = await env.manager.importFiles([OCTOBER])
    expect(again!.results[0].counts).toMatchObject({ added: 0, duplicates: 17 })
    expect(await byBankId(FIT.keg)).toBeUndefined()
  })

  it('Cancel changes nothing', async () => {
    const { change, line } = await typedThenImported()
    const before = await line(FIT.keg)
    expect(await change(FIT.keg, undefined)).toEqual({ ok: true, value: undefined })
    expect(await line(FIT.keg)).toEqual(before)
  })

  it('refuses a transaction taken by another bank line, or one that can’t be this line', async () => {
    const { entered, change, manager, accept } = await typedThenImported()
    // Hydro is proposed for its own line; Costco, once accepted, carries its line
    expect(await change(FIT.keg, { kind: 'match', transactionId: entered.hydro.id, rememberPayee: false }))
      .toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringContaining('proposed for another bank line') } })
    await accept(FIT.costco)
    expect(await change(FIT.keg, { kind: 'match', transactionId: entered.costco.id, rememberPayee: false }))
      .toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringContaining('matched to another bank line') } })
    const deposit = await manager.create({ date: '2026-10-03', amount: 5750, payee: 'The Keg' })
    expect(await change(FIT.keg, { kind: 'match', transactionId: deposit.id, rememberPayee: false }))
      .toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringContaining('other way') } })
    expect(await change(FIT.keg, { kind: 'match', transactionId: 'nope', rememberPayee: false })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('Change… on an accepted match (Change Match… in the row menu)', () => {
  async function accepted() {
    const setup = await typedThenImported()
    await setup.accept(FIT.costco)
    return setup
  }

  it('to another transaction: the first goes back as it was, and the chosen one takes the line', async () => {
    const { entered, change, get, line, manager } = await accepted()
    const other = await manager.create({ date: '2026-10-06', amount: -8412, payee: 'Costco' })
    await change(FIT.costco, { kind: 'match', transactionId: other.id, rememberPayee: false })
    expect(shape(await get(entered.costco.id))).toEqual({ date: '2026-10-05', amount: -8400, status: 'uncleared', externalId: undefined })
    expect(shape(await get(other.id))).toEqual({ date: '2026-10-06', amount: -8412, status: 'electronic', externalId: FIT.costco })
    expect(await line(FIT.costco)).toMatchObject({ transactionId: other.id, before: { date: '2026-10-06', amount: -8412, status: 'uncleared' } })
  })

  it('to itself: nothing to do', async () => {
    const { entered, change, get } = await accepted()
    const before = await get(entered.costco.id)
    await change(FIT.costco, { kind: 'match', transactionId: entered.costco.id, rememberPayee: false })
    expect(await get(entered.costco.id)).toEqual(before)
  })

  it('Unmatch: the transaction gets back its own date, amount and status, and the bank line becomes its own', async () => {
    const { entered, change, get, line, byBankId } = await accepted()
    await change(FIT.costco, { kind: 'unmatch' })
    expect(shape(await get(entered.costco.id))).toEqual({ date: '2026-10-05', amount: -8400, status: 'uncleared', externalId: undefined })
    const added = await byBankId(FIT.costco)
    expect(added).toMatchObject({ date: '2026-10-06', amount: -8412, status: 'electronic' })
    expect(await line(FIT.costco)).toMatchObject({ outcome: 'added', review: 'done', transactionId: added.id })
    expect((await line(FIT.costco)).before).toBeUndefined()
  })

  it('Unmatch keeps what the user changed since accepting: only the bank’s values go back', async () => {
    const { entered, change, get, manager } = await accepted()
    const now = await get(entered.costco.id)
    await manager.update(now.id, { amount: -9000, status: 'cleared' }, { expectedRev: now.rev })
    await change(FIT.costco, { kind: 'unmatch' })
    expect(shape(await get(entered.costco.id))).toEqual({ date: '2026-10-05', amount: -9000, status: 'cleared', externalId: undefined })
  })

  it('Don’t import: the transaction goes back as it was, and nothing is added', async () => {
    const { entered, change, get, line, byBankId } = await accepted()
    await change(FIT.costco, { kind: 'skip' })
    expect(shape(await get(entered.costco.id))).toEqual({ date: '2026-10-05', amount: -8400, status: 'uncleared', externalId: undefined })
    expect(await byBankId(FIT.costco)).toBeUndefined()
    expect(await line(FIT.costco)).toMatchObject({ outcome: 'skipped', review: 'done' })
    expect((await line(FIT.costco)).transactionId).toBeUndefined()
  })

  it('asks before changing a transaction that was reconciled since, and stops if the user says no', async () => {
    const { env, entered, change, get, manager } = await accepted()
    await manager.setStatus([entered.costco.id], 'reconciled', { confirm: ['reconciled'] })
    env.prompts.confirm.mockResolvedValueOnce(false)
    expect(await change(FIT.costco, { kind: 'unmatch' })).toEqual({ ok: true, value: undefined })
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Change a reconciled transaction?', confirmLabel: 'Change It' }))
    expect((await get(entered.costco.id)).externalId).toBe(FIT.costco)

    env.prompts.confirm.mockResolvedValueOnce(true)
    await change(FIT.costco, { kind: 'unmatch' })
    expect(shape(await get(entered.costco.id))).toMatchObject({ date: '2026-10-05', amount: -8400, externalId: undefined })
  })
})

describe('Change… on a row added as new', () => {
  it('to a transaction the user entered: the added one goes, and the entered one takes the bank’s id, date and amount', async () => {
    const { change, get, line, byBankId, manager } = await typedThenImported()
    const added = await byBankId(FIT.loblaws)
    const typedLater = await manager.create({ date: '2026-10-14', amount: -14000, payee: 'Loblaws' })
    await change(FIT.loblaws, { kind: 'match', transactionId: typedLater.id, rememberPayee: false })
    expect(await get(added.id)).toBeUndefined()
    expect(shape(await get(typedLater.id))).toEqual({ date: '2026-10-15', amount: -14287, status: 'electronic', externalId: FIT.loblaws })
    expect(await line(FIT.loblaws)).toMatchObject({ outcome: 'matched', review: 'done', transactionId: typedLater.id })
  })

  it('refuses Unmatch (it is its own already) and itself', async () => {
    const { change, byBankId } = await typedThenImported()
    expect(await change(FIT.loblaws, { kind: 'unmatch' })).toMatchObject({ ok: false, error: { code: 'REFUSED' } })
    const added = await byBankId(FIT.loblaws)
    expect(await change(FIT.loblaws, { kind: 'match', transactionId: added.id, rememberPayee: false })).toMatchObject({ ok: false, error: { code: 'REFUSED' } })
  })

  it('Don’t import: the added transaction is deleted after a confirmation, and doesn’t come back', async () => {
    const { env, change, line, byBankId } = await typedThenImported()
    env.prompts.confirm.mockResolvedValueOnce(false)
    await change(FIT.atm, { kind: 'skip' })
    expect(await byBankId(FIT.atm)).toBeDefined()
    env.prompts.confirm.mockResolvedValueOnce(true)
    await change(FIT.atm, { kind: 'skip' })
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Delete the transaction added for this bank line?', destructive: true }))
    expect(await byBankId(FIT.atm)).toBeUndefined()
    expect(await line(FIT.atm)).toMatchObject({ outcome: 'skipped', review: 'done' })
    await env.manager.importFiles([OCTOBER])
    expect(await byBankId(FIT.atm)).toBeUndefined()
  })
})

describe('payee aliases', () => {
  it('name the payee of a new line, with the payee’s category, the next time the bank writes it that way', async () => {
    const { env, account, change, manager, entered } = await typedThenImported()
    // The Amazon proposal is moved to an entry called "Online shopping", remembering the bank's text for it
    const shop = await env.accounts.categories.create('Shopping', 'expense')
    const other = await manager.create({ date: '2026-10-26', amount: -2399, payee: 'Online shopping', categoryId: shop.id })
    await change(FIT.amazon, { kind: 'match', transactionId: other.id, rememberPayee: true })
    expect(entered.amazon.id).not.toBe(other.id)

    await env.manager.importStatements([{
      account: { accountNumber: '8812345678' }, currency: 'CAD',
      lines: [{ date: '2026-12-02', amount: '-51.00', payee: 'AMZN MKTP CA*9Z8Y7X', externalId: 'DEC-1' }]
    }], { label: 'Connected bank' })
    const { rows } = await env.accounts.transactions(account.id).register()
    expect(rows.find(r => r.transaction.externalId === 'DEC-1')).toMatchObject({ payeeName: 'Online shopping', categoryLabel: 'Shopping' })
  })

  it('make a payee score 1 in matching, so a match the names alone wouldn’t make is proposed', async () => {
    const { env, account, change, manager, line } = await typedThenImported()
    const other = await manager.create({ date: '2026-10-26', amount: -2399, payee: 'Online shopping' })
    await change(FIT.amazon, { kind: 'match', transactionId: other.id, rememberPayee: true })
    // 10% apart: proposed only if the payees agree, which only the alias says
    const later = await manager.create({ date: '2026-12-01', amount: -4600, payee: 'Online shopping' })
    await env.manager.importStatements([{
      account: { accountNumber: '8812345678' }, currency: 'CAD',
      lines: [{ date: '2026-12-02', amount: '-51.00', payee: 'AMZN MKTP CA*9Z8Y7X', externalId: 'DEC-1' }]
    }], { label: 'Connected bank' })
    expect((await line('DEC-1')).proposedId).toBe(later.id)
    expect(account.id).toBeDefined()
  })
})

describe('a bank line that loses its transaction', () => {
  it('when its proposal is deleted or voided: counted in the review bar, with Resolve…', async () => {
    const { entered, manager, marks, line } = await typedThenImported()
    await manager.delete([entered.keg.id])
    await manager.setVoided([entered.hydro.id], true)
    const { summary, rows } = await marks()
    expect(rows.some(r => r.transactionId === entered.hydro.id && r.review)).toBe(false)
    expect(summary!.message).toContain('2 bank lines lost their match')
    expect(summary!.outstanding).toBe(2)
    const resolve = summary!.actions.find(a => a.label === 'Resolve…')!
    expect(resolve).toMatchObject({ command: IMPORT_COMMANDS.change, args: { lineId: (await line(FIT.keg)).id } })
  })

  it('is resolved by matching it, adding it as new, or leaving it out', async () => {
    const { entered, manager, change, line, byBankId, marks, get } = await typedThenImported()
    await manager.delete([entered.keg.id])
    await manager.delete([entered.hydro.id])
    await manager.setVoided([entered.coffee.id], true)
    const retyped = await manager.create({ date: '2026-10-03', amount: -5750, payee: 'The Keg' })
    await change(FIT.keg, { kind: 'match', transactionId: retyped.id, rememberPayee: false })
    expect((await get(retyped.id)).externalId).toBe(FIT.keg)
    await change(FIT.hydro, { kind: 'unmatch' })
    expect(await byBankId(FIT.hydro)).toMatchObject({ amount: -8000, status: 'electronic' })
    expect((await line(FIT.hydro)).outcome).toBe('added')
    await change(FIT.coffee, { kind: 'skip' })
    expect((await line(FIT.coffee)).outcome).toBe('skipped')
    expect((await marks()).summary?.outstanding).toBe(0)
  })

  it('when moving an accepted match stops between putting back the first and matching the second', async () => {
    const { env, account, entered, accept, change, line, marks, manager, get } = await typedThenImported()
    await accept(FIT.costco)
    const other = await manager.create({ date: '2026-10-06', amount: -8400, payee: 'Costco' })
    // Matching the second changes its amount, which reaches its transfer's reconciled other side: the user says no
    const savings = await env.accounts.createAccount(chequing({ name: 'Savings', type: 'savings', accountNumber: undefined }))
    await manager.update(other.id, { transferAccountId: savings.id, payee: null })
    const otherSide = (await env.accounts.transactions(savings.id).list())[0]
    await env.accounts.transactions(savings.id).setStatus([otherSide.id], 'reconciled', { confirm: ['reconciled'] })
    env.prompts.confirm.mockResolvedValueOnce(false)
    await change(FIT.costco, { kind: 'match', transactionId: other.id, rememberPayee: false })

    // The first went back; the second didn't take the line: it is nowhere, and the review bar says so
    expect(shape(await get(entered.costco.id))).toMatchObject({ date: '2026-10-05', externalId: undefined })
    expect((await get(other.id)).externalId).toBeUndefined()
    const stored = await line(FIT.costco)
    expect(stored).toMatchObject({ outcome: 'matched', review: 'pending' })
    expect(stored.transactionId).toBeUndefined()
    expect(stored.intent).toBeUndefined()
    expect((await marks()).summary?.outstanding).toBe(1)
    expect(account.id).toBeDefined()
  })
})

describe('a review change interrupted', () => {
  /** A line's intent written and the accounts write made, as a change does, but stopped before the line's result. */
  async function interrupted(setup: Setup, importId: string, work: (line: StoredLine & { id: string }) => Promise<unknown>, intent: StoredLine['intent']) {
    const stored = await setup.line(importId)
    await setup.c().lines.updateOne({ id: stored.id }, { $set: { intent } as never })
    await work(stored)
  }

  it('after its accounts write: the register shows it done, and the next change records it', async () => {
    const setup = await typedThenImported()
    const { entered, manager, mark, line, run, c } = setup
    await interrupted(setup, FIT.costco, () => manager.match(entered.costco.id, { externalId: FIT.costco, date: '2026-10-06', amount: -8412 }), {
      carrier: { kind: 'id', id: entered.costco.id },
      next: { outcome: 'matched', review: 'done', transactionId: entered.costco.id, before: { date: '2026-10-05', amount: -8400, status: 'uncleared' } }
    })
    // No buttons for a match already made
    expect((await mark(entered.costco.id))!.review).toBe(false)
    // Any review command settles it for good
    await run(IMPORT_COMMANDS.accept, { lineIds: [(await line(FIT.costco)).id] })
    const settled = (await c().lines.findOne({ importId: FIT.costco }))!
    expect(settled).toMatchObject({ outcome: 'matched', review: 'done', transactionId: entered.costco.id, before: { amount: -8400 } })
    expect(settled.intent).toBeUndefined()
  })

  it('before its accounts write: the line is as it was', async () => {
    const setup = await typedThenImported()
    const { entered, mark, accept, get } = setup
    await interrupted(setup, FIT.costco, async () => {}, {
      carrier: { kind: 'id', id: entered.costco.id }, next: { outcome: 'matched', review: 'done', transactionId: entered.costco.id }
    })
    expect((await mark(entered.costco.id))!.review).toBe(true)
    await accept(FIT.costco)
    expect((await get(entered.costco.id)).externalId).toBe(FIT.costco)
  })

  it('an Unmatch that added the bank line: the line points at the new transaction', async () => {
    const setup = await typedThenImported()
    const { manager, mark, byBankId, line, accept } = setup
    await interrupted(setup, FIT.keg, () => manager.createMany([{ date: '2026-10-03', amount: -5750, payee: 'The Keg', status: 'electronic', externalId: FIT.keg }]),
      { carrier: { kind: 'new' }, next: { outcome: 'added', review: 'done' } })
    const added = await byBankId(FIT.keg)
    expect(await mark(added.id)).toMatchObject({ review: false, actions: [{ label: 'Change Match…' }] })
    await accept(FIT.coffee2)                                                  // any review command settles what it touches
    await accept(FIT.keg)
    expect(await line(FIT.keg)).toMatchObject({ outcome: 'added', transactionId: added.id })
  })

  it('is settled when the ledger opens again', async () => {
    const setup = await typedThenImported()
    const { entered, manager, c } = setup
    await interrupted(setup, FIT.costco, () => manager.match(entered.costco.id, { externalId: FIT.costco }), {
      carrier: { kind: 'id', id: entered.costco.id }, next: { outcome: 'matched', review: 'done', transactionId: entered.costco.id }
    })
    await setup.env.manager.importFiles([OCTOBER])                               // every import settles what was left first
    const settled = (await c().lines.findOne({ importId: FIT.costco }))!
    expect(settled.intent).toBeUndefined()
    expect(settled.transactionId).toBe(entered.costco.id)
    expect(IMPORT_COLLECTIONS.lines).toBe('import.lines')
  })
})
