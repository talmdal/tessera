// @vitest-environment node
// Duplicates across sources (docs/import-formats-design.md, phase F2), with the ledger, accounts, import and OFX plugins
// activated together, on the sample statements: a line that looks like a transaction imported before from another
// file is proposed as Already imported?, nothing is added for it, and the register offers Accept (it is the same) and
// Change… (add it after all, or match it elsewhere).
import { describe, expect, it } from 'vitest'
import type { LedgerSession } from '@tessera/ledger-api'
import { LEDGER_SESSION_SERVICE } from '@tessera/ledger-api'
import type { RegisterAnnotator, Transaction } from '@tessera/accounts-api'
import {
  IMPORT_ANNOTATOR_SERVICE, IMPORT_CHANNELS, IMPORT_COMMANDS, IMPORT_DIALOGS,
  type ImportResult, type MatchCandidatesResponse, type MatchDialogResult
} from '@tessera/import-api'
import { collectionsOf } from '../../../plugins/import/src/privileged/store'
import { describe as describeResult } from '../../../plugins/import/src/renderer/SummaryDialog'
import { sample, setupImport } from './harness'

const CONVERTED = sample('maple-trust-chequing-2026-10-converted.qbo')
const OCTOBER = sample('maple-trust-chequing-2026-10.ofx')
const NOVEMBER = sample('maple-trust-chequing-2026-11.ofx')
const CARD_MID_MONTH = sample('northwind-visa-2026-10-16-converted.qbo')
const CARD = sample('northwind-visa-2026-10.qfx')
/** November's first five lines are October's last five, with the bank's ids. */
const OVERLAP = ['MT2026102701', 'MT2026102901', 'MT2026102902', 'MT2026103101', 'MT2026103102']

const text = (parts: { text: string, emphasis?: boolean }[]) => parts.map(p => p.emphasis ? `[${p.text}]` : p.text).join('')

/**
 * October imported from a converter's QBO (its lines known by their content), optionally reconciled, then the bank's
 * November OFX (known by the bank's ids), which overlaps it by five lines.
 */
async function convertedThenNovember(options: { reconcile?: boolean } = {}) {
  const env = await setupImport()
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  await env.manager.importFiles([CONVERTED])
  const account = await env.account('Maple Trust Bank 5678')
  const manager = env.accounts.transactions(account.id)
  const october = await manager.list()
  if (options.reconcile) await manager.setStatus(october.map(t => t.id), 'reconciled', { confirm: ['reconciled'] })
  const report = await env.manager.importFiles([NOVEMBER])

  const session = env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const c = () => collectionsOf(session.database('import'))
  const annotator = env.runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)
  const line = async (importId: string) => (await c().lines.findOne({ accountId: account.id, importId }))!
  const run = (command: string, args: unknown) => env.runtime.commands.execute(command, args) as Promise<ImportResult<unknown>>
  const accept = async (importId: string) => run(IMPORT_COMMANDS.accept, { lineIds: [(await line(importId)).id] })
  const change = async (importId: string, answer: MatchDialogResult | undefined) => {
    env.answer(IMPORT_DIALOGS.match, answer)
    return run(IMPORT_COMMANDS.change, { lineId: (await line(importId)).id })
  }
  const marks = () => annotator.annotate(account.id)
  const mark = async (transactionId: string) => (await marks()).rows.find(r => r.transactionId === transactionId)
  const balance = async () => (await env.accounts.chart()).accounts.find(s => s.account.id === account.id)!.balances.current
  return { env, account, manager, october, report, c, line, run, accept, change, marks, mark, balance }
}

describe('a line already imported from another file', () => {
  it('is proposed as already imported, on the transaction it looks like, and nothing is added for it', async () => {
    const { report, manager, balance, line } = await convertedThenNovember()
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { lines: 10, added: 5, duplicates: 0, alreadyImported: 5 } })
    expect(await manager.list()).toHaveLength(22)                                   // 17 + November's 5 new
    expect(await balance()).toBe(624174)                                            // the bank's November balance
    const recorded = await line(OVERLAP[0])
    expect(recorded).toMatchObject({ outcome: 'matched', review: 'pending' })
    expect(recorded.duplicateOf).toBeDefined()
    expect((await manager.get(recorded.proposedId!))!.externalId).toMatch(/^fp:/)  // October's, known by its content
  })

  it('is proposed even on a transaction reconciled since: last month’s import likely was', async () => {
    const { report, mark, line } = await convertedThenNovember({ reconcile: true })
    expect(report!.results[0].counts).toMatchObject({ added: 5, alreadyImported: 5 })
    expect((await mark((await line(OVERLAP[0])).proposedId!))).toMatchObject({ review: true, tone: 'warning' })
  })

  it('pairs two identical coffees with two, one to one', async () => {
    const { line } = await convertedThenNovember()
    const [a, b] = await Promise.all([line('MT2026102901'), line('MT2026102902')])
    expect(a.proposedId).toBeDefined()
    expect(b.proposedId).toBeDefined()
    expect(a.proposedId).not.toBe(b.proposedId)
  })

  it('is recognised by its id the next time: importing November again adds nothing', async () => {
    const { env, manager } = await convertedThenNovember()
    const again = await env.manager.importFiles([NOVEMBER])
    expect(again!.results[0].counts).toMatchObject({ added: 0, duplicates: 10 })
    expect(again!.results[0].counts).not.toHaveProperty('alreadyImported')
    expect(await manager.list()).toHaveLength(22)
  })

  it('catches a card’s pending lines once posted: other text, a day or three later', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([CARD_MID_MONTH])
    const report = await env.manager.importFiles([CARD])
    expect(report!.results[0].counts).toMatchObject({ lines: 8, added: 3, alreadyImported: 5 })
    const card = await env.account('Northwind Card Services 3456')
    expect((await env.accounts.chart()).accounts.find(s => s.account.id === card.id)!.balances.current).toBe(-46477)   // owing 464.77
  })

  it('is never proposed for two files from the same bank with its own ids: those overlap by id, as before', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([OCTOBER])
    const report = await env.manager.importFiles([NOVEMBER])
    expect(report!.results[0].counts).toMatchObject({ added: 5, duplicates: 5 })
    expect(report!.results[0].counts).not.toHaveProperty('alreadyImported')
  })

  it('is never a different purchase: another payee, or another amount, is added', async () => {
    const env = await setupImport()
    const statement = (lines: { date: string, amount: string, payee: string }[], key: string) => ({ account: { key, accountNumber: '5555' }, currency: 'CAD', lines })
    const mine = await env.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, accountNumber: '5555' })
    await env.manager.importStatements([statement([{ date: '2026-10-05', amount: '-20.00', payee: 'CORNER BAKERY' }], 'a:5555')], { label: 'Website export' })
    const report = await env.manager.importStatements([statement([
      { date: '2026-10-05', amount: '-20.00', payee: 'PINE HARDWARE' }, { date: '2026-10-05', amount: '-21.00', payee: 'CORNER BAKERY' }
    ], 'b:5555')], { label: 'Another export' })
    expect(report.results[0].counts).toMatchObject({ added: 2 })
    expect(report.results[0].counts).not.toHaveProperty('alreadyImported')
    expect(await env.transactions(mine.id)).toHaveLength(3)
  })
})

describe('in the register', () => {
  it('marks the transaction it looks like, with the bank’s line, both files, Accept and Change…', async () => {
    const { mark, line, marks } = await convertedThenNovember()
    const amazon = await line(OVERLAP[0])
    const row = (await mark(amazon.proposedId!))!
    expect(row).toMatchObject({ review: true, tone: 'warning', detail: { icon: 'ContentCopy' } })
    expect(text(row.detail.parts)).toBe('Already imported? Oct 27 · AMZN MKTP CA*2K3L91 · 23.99 in maple-trust-chequing-2026-11.ofx looks like this one, from maple-trust-chequing-2026-10-converted.qbo')
    expect(row.actions.map(a => [a.label, a.command, a.args, a.tooltip])).toEqual([
      ['Accept', IMPORT_COMMANDS.accept, { lineIds: [amazon.id] }, 'It’s the same transaction: don’t add it again'],
      ['Change…', IMPORT_COMMANDS.change, { lineId: amazon.id }, 'Add it as a new transaction after all, or match it to another']
    ])
    // One row per transaction: the mark replaces October's own "New from the bank" on it
    const all = await marks()
    expect(new Set(all.rows.map(r => r.transactionId)).size).toBe(all.rows.length)
    expect(all.summary?.message).toBe('22 imported transactions to review (17 new, 5 possibly already imported), from 2 imports.')
  })

  it('shows a line whose transaction was deleted as lost, to resolve', async () => {
    const { manager, line, marks } = await convertedThenNovember()
    await manager.delete([(await line(OVERLAP[3])).proposedId!])
    expect((await marks()).summary?.message).toContain('1 bank line lost its match')
  })
})

describe('reviewing it', () => {
  it('Accept: it is the same transaction; nothing in the account changes, and October’s line is acknowledged too', async () => {
    const { accept, line, manager, c } = await convertedThenNovember()
    const amazon = await line(OVERLAP[0])
    const before = await manager.list()
    expect((await accept(OVERLAP[0])).ok).toBe(true)
    expect(await line(OVERLAP[0])).toMatchObject({ outcome: 'skipped', review: 'done', duplicateOf: amazon.duplicateOf })
    expect(await c().lines.get(amazon.duplicateOf!)).toMatchObject({ outcome: 'added', review: 'done' })
    expect(await manager.list()).toEqual(before)
  })

  it('Change… › Add it as a new transaction: it is another one after all, added and acknowledged', async () => {
    const { change, line, manager, balance } = await convertedThenNovember()
    const before = await balance()
    expect((await change(OVERLAP[0], { kind: 'unmatch' })).ok).toBe(true)
    const added = await line(OVERLAP[0])
    expect(added).toMatchObject({ outcome: 'added', review: 'done' })
    expect(added.duplicateOf).toBeUndefined()
    expect((await manager.get(added.transactionId!))!).toMatchObject({ externalId: OVERLAP[0], amount: -2399 })
    expect(await balance()).toBe(before - 2399)
  })

  it('Change… › the transaction it looks like, or Don’t import: the same as Accept', async () => {
    const { change, line } = await convertedThenNovember()
    const fee = await line(OVERLAP[3])
    expect((await change(OVERLAP[3], { kind: 'match', transactionId: fee.proposedId!, rememberPayee: true })).ok).toBe(true)
    expect(await line(OVERLAP[3])).toMatchObject({ outcome: 'skipped', review: 'done' })
    expect((await change(OVERLAP[4], { kind: 'skip' })).ok).toBe(true)
    expect(await line(OVERLAP[4])).toMatchObject({ outcome: 'skipped', review: 'done' })
  })

  it('Change… › another transaction: matched to it, as any line', async () => {
    const { change, line, manager } = await convertedThenNovember()
    const typed = await manager.create({ date: '2026-10-27', amount: -2399, payee: 'Amazon' })
    expect((await change(OVERLAP[0], { kind: 'match', transactionId: typed.id, rememberPayee: false })).ok).toBe(true)
    expect(await line(OVERLAP[0])).toMatchObject({ outcome: 'matched', review: 'done', transactionId: typed.id })
    expect((await manager.get(typed.id))!.externalId).toBe(OVERLAP[0])
  })

  it('lists the transaction it looks like first in the Change Match dialog, though it is imported, and reconciled', async () => {
    const { env, line } = await convertedThenNovember({ reconcile: true })
    const amazon = await line(OVERLAP[0])
    const reply = await env.runtime.ipc.dispatch({ channel: IMPORT_CHANNELS.matchCandidates, data: { lineId: amazon.id } })
    const result = (reply as { ok: true, data: ImportResult<MatchCandidatesResponse> }).data
    expect(result.ok && result.value).toMatchObject({ state: 'duplicate', currentId: amazon.proposedId })
    const candidates = result.ok ? result.value.candidates.map(c => c.transaction as Transaction) : []
    expect(candidates[0]).toMatchObject({ id: amazon.proposedId, status: 'reconciled' })
  })

  it('Accept All… says how many are already imported, and accepts them with the rest', async () => {
    const { env, run, account, c, manager } = await convertedThenNovember()
    env.prompts.confirm.mockResolvedValueOnce(true)
    expect((await run(IMPORT_COMMANDS.acceptAll, { accountId: account.id })).ok).toBe(true)
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Accept 17 new transactions and 5 lines already imported?',
      detail: 'The 5 lines already imported from another file won’t be added again.'
    }))
    const lines = await c().lines.find({ accountId: account.id })
    expect(lines.filter(l => l.review === 'pending')).toEqual([])
    expect(lines.filter(l => l.duplicateOf !== undefined).map(l => l.outcome)).toEqual(Array(5).fill('skipped'))
    expect(await manager.list()).toHaveLength(22)
  })
})

describe('the samples README’s walkthrough (samples/statements, “The same transactions from another file”)', () => {
  it('goes as it says, step by step, for the chequing account', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const first = await env.manager.importFiles([CONVERTED])                                     // 1
    expect(describeResult(first!.results[0])).toBe('17 transactions added to “Maple Trust Bank 5678”.')
    const account = await env.account('Maple Trust Bank 5678')
    const manager = env.accounts.transactions(account.id)
    const run = (command: string, args: unknown) => env.runtime.commands.execute(command, args) as Promise<ImportResult<unknown>>
    env.prompts.confirm.mockResolvedValueOnce(true)
    await run(IMPORT_COMMANDS.acceptAll, { accountId: account.id })                               // 2
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Accept 17 new transactions?' }))
    const balance = async () => (await env.accounts.chart()).accounts.find(s => s.account.id === account.id)!.balances.current
    expect(await balance()).toBe(467780)
    await manager.setStatus((await manager.list()).map(t => t.id), 'reconciled', { confirm: ['reconciled'] })
    const november = await env.manager.importFiles([NOVEMBER])                                     // 3
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(1)
    expect(describeResult(november!.results[0])).toBe('5 transactions added to “Maple Trust Bank 5678”, 5 looked like transactions imported before from another file and weren’t added: check them in the register.')
    expect(await balance()).toBe(624174)
    const annotator = env.runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)          // 4
    const marks = await annotator.annotate(account.id)
    expect(marks.summary?.message).toBe('10 imported transactions to review (5 new, 5 possibly already imported), from maple-trust-chequing-2026-11.ofx.')
    const already = marks.rows.filter(r => r.detail.icon === 'ContentCopy')
    expect(already.map(r => text(r.detail.parts).replace(/ in .*$/, ''))).toEqual([
      'Already imported? Oct 27 · AMZN MKTP CA*2K3L91 · 23.99', 'Already imported? Oct 29 · TIM HORTONS #4021 · 4.75',
      'Already imported? Oct 29 · TIM HORTONS #4021 · 4.75', 'Already imported? Oct 31 · MONTHLY ACCOUNT FEE · 4.95',
      'Already imported? Oct 31 · INTEREST PAID · 0.38'
    ])
    expect(text(already[0].detail.parts)).toBe('Already imported? Oct 27 · AMZN MKTP CA*2K3L91 · 23.99 in maple-trust-chequing-2026-11.ofx looks like this one, from maple-trust-chequing-2026-10-converted.qbo')
    const lines = collectionsOf(env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE).database('import')).lines
    const line = async (importId: string) => (await lines.findOne({ accountId: account.id, importId }))!
    expect((await run(IMPORT_COMMANDS.accept, { lineIds: [(await line(OVERLAP[0])).id] })).ok).toBe(true)      // 5
    expect(await balance()).toBe(624174)
    env.answer(IMPORT_DIALOGS.match, { kind: 'unmatch' })                                           // 6
    await run(IMPORT_COMMANDS.change, { lineId: (await line(OVERLAP[3])).id })
    expect(await balance()).toBe(624174 - 495)
    env.answer(IMPORT_DIALOGS.match, { kind: 'skip' })
    env.prompts.confirm.mockResolvedValueOnce(true)
    await run(IMPORT_COMMANDS.change, { lineId: (await line(OVERLAP[3])).id })
    expect(await balance()).toBe(624174)
    env.prompts.confirm.mockResolvedValueOnce(true)                                                 // 7
    await run(IMPORT_COMMANDS.acceptAll, { accountId: account.id })
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Accept 5 new transactions and 3 lines already imported?',
      detail: 'The 3 lines already imported from another file won’t be added again.'
    }))
    const again = await env.manager.importFiles([NOVEMBER])                                         // 8
    expect(describeResult(again!.results[0])).toBe('Nothing new for “Maple Trust Bank 5678”: all 10 transactions were already imported.')
  })

  it('goes as it says for the card’s pending lines', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const midMonth = await env.manager.importFiles([CARD_MID_MONTH])                                // 1
    expect(describeResult(midMonth!.results[0])).toBe('5 transactions added to “Northwind Card Services 3456”.')
    const card = await env.account('Northwind Card Services 3456')
    const owing = async () => (await env.accounts.chart()).accounts.find(s => s.account.id === card.id)!.balances.current
    expect(card.openingBalance).toBe(-54000)
    const payees = await env.accounts.payees.search('', 100)
    expect(payees.map(p => p.name)).toEqual(expect.arrayContaining(['Canadian Tire', 'Sq Bytown Coffee']))
    expect(payees.some(p => /pending/i.test(p.name))).toBe(false)
    const month = await env.manager.importFiles([CARD])                                             // 2
    expect(describeResult(month!.results[0])).toBe('3 transactions added to “Northwind Card Services 3456”, 5 looked like transactions imported before from another file and weren’t added: check them in the register.')
    expect(await owing()).toBe(-46477)
    const annotator = env.runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)          // 3
    const rows = (await annotator.annotate(card.id)).rows.filter(r => r.detail.icon === 'ContentCopy').map(r => text(r.detail.parts).replace(/ in .*$/, ''))
    expect(rows).toEqual(expect.arrayContaining(['Already imported? [Oct 11] · CANADIAN TIRE #0385 · 214.67', 'Already imported? [Oct 19] · SQ *BYTOWN COFFEE · 17.25']))
  })
})

