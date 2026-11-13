// QIF there and back, through the whole import (docs/export-design.md, "What survives a round trip"). Standard QIF cuts
// a payee to 32 characters, so a long payee comes back another name. Back into the account it came from, nothing is
// added all the same: a line imported before is proposed as already imported, an identical one is a duplicate, and one
// the user typed is proposed as a match. Into a new ledger, the account comes over at the same balance, with the cut
// payees' whole names in their memos.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { IMPORT_DIALOGS } from '@tessera/import-api'
import { file } from '../ledger/harness'
import { household, setupExport, type ExportEnv } from './harness'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-qif-round-trip-'))
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** A bank's CSV export with three payees longer than 32 characters and a short one. */
const BANK_CSV = [
  'Date,Description,Amount',
  '2026-10-14,POS PURCHASE INTERNATIONAL BUSINESS MACHINES CORPORATION OTTAWA ON,-150.00',
  '2026-10-15,E-TRANSFER SENT TO JONATHAN ALEXANDER MACDONALD-SMITHERS,-75.00',
  '2026-10-16,PREAUTHORIZED DEBIT CANADIAN IMPERIAL INSURANCE COMPANY,-88.40',
  '2026-10-20,SHORT ONE,-10.00'
].join('\r\n') + '\r\n'

/** Chequing, imported from the bank's CSV, and one long payee the user typed themselves. */
async function ledgerWithLongPayees(env: ExportEnv) {
  const csv = path.join(dir, `bank-${Math.random().toString(36).slice(2)}.csv`)
  fs.writeFileSync(csv, BANK_CSV)
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  await env.manager.importFiles([csv])
  const [account] = await env.accounts.list()
  await env.accounts.transactions(account.id).create({ date: '2026-10-25', amount: -42000, payee: 'Revenue Agency of Canada Installment Payment Q4' })
  return account
}

/** File › Export… of one account as QIF, saved to a real file for the import to read. */
async function exportQif(env: ExportEnv, accountId: string): Promise<string> {
  env.answerExport({ formatId: 'format-qif.qif', accountIds: [accountId], range: {}, options: {}, rangeState: { choice: 'all' } })
  env.saveAs('Chequing.qif')
  await env.run()
  const at = path.join(dir, `Chequing-${Math.random().toString(36).slice(2)}.qif`)
  fs.writeFileSync(at, env.saved.get(file('Chequing.qif'))!)
  return at
}

describe('QIF there and back', () => {
  it('cuts long payees to 32 characters, and adds nothing when read back into the account it came from', async () => {
    const env = await setupExport()
    const account = await ledgerWithLongPayees(env)
    const before = await env.accounts.transactions(account.id).list()
    const qif = await exportQif(env, account.id)
    const lines = fs.readFileSync(qif, 'latin1').split('\r\n')
    expect(lines.filter(l => l.startsWith('P') && l !== 'POpening Balance')).toEqual([
      'PInternational Business Machines', 'PE Transfer Sent To Jonathan Alex', 'PCanadian Imperial Insurance Comp', 'PShort One',
      'PRevenue Agency of Canada Install'
    ])
    expect(lines).toContain('MRevenue Agency of Canada Installment Payment Q4')

    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: account.id, remember: false })
    const report = await env.manager.importFiles([qif])
    expect(report?.results.map(r => [r.outcome, r.counts])).toEqual([['imported', {
      lines: 5, added: 0, matched: 1, possible: 0, duplicates: 1, invalid: 0, alreadyImported: 3
    }]])
    expect(await env.accounts.transactions(account.id).list()).toEqual(before)
  })

  it('brings the account into a new ledger at the same balance, each cut payee’s whole name in its memo', async () => {
    const env = await setupExport()
    const account = await ledgerWithLongPayees(env)
    const balance = (await env.accounts.balances(account.id)).current
    const qif = await exportQif(env, account.id)

    await env.session.create(file('Other.tessera'))
    expect(await env.accounts.list()).toEqual([])
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const report = await env.manager.importFiles([qif])
    expect(report?.results.map(r => [r.outcome, r.counts.added, r.error])).toEqual([['imported', 5, undefined]])
    const [moved] = await env.accounts.list()
    expect((await env.accounts.balances(moved.id)).current).toBe(balance)
    const register = (await env.accounts.transactions(moved.id).register()).rows
    const insurance = register.find(r => r.transaction.amount === -8840)!
    expect(insurance.payeeName).toBe('Canadian Imperial Insurance Comp')
    expect(insurance.transaction.memo).toBe('Canadian Imperial Insurance Company')
  })

  it('puts every transaction back in its category, in a ledger that has them, when the user takes the file’s', async () => {
    const env = await setupExport()
    const h = await household(env)
    // A category every new ledger starts with, whose name standard QIF cuts: “Mortgage interest” is “Mortgage intere”
    const mortgage = (await env.accounts.categories.list()).find(c => c.name === 'Mortgage interest')!
    await env.accounts.transactions(h.chequing.id).create({ date: '2026-10-28', amount: -90000, payee: 'Bank', categoryId: mortgage.id })
    const rows = async (accountId: string) => (await env.accounts.transactions(accountId).register()).rows
      .filter(r => !r.transaction.voided).map(r => [r.transaction.date, r.transaction.amount, r.transaction.transferAccountId ? 'a transfer' : r.categoryLabel])
    const original = await rows(h.chequing.id)
    const balance = (await env.accounts.balances(h.chequing.id)).current
    const qif = await exportQif(env, h.chequing.id)

    // A new ledger starts with Food : Groceries and Housing : Rent; Income : Salary is made first, as the user would
    await env.session.create(file('Other.tessera'))
    await env.accounts.categories.create('Income : Salary', 'income')
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    await env.manager.importFiles([qif])
    const [moved] = await env.accounts.list()
    // A transfer comes back as a line of its own, with no category: its other side is another account's. And a
    // category cut to 15 characters names none the ledger has, so its line comes back without one
    expect(await rows(moved.id)).toEqual(original.map(([date, amount, category]) =>
      [date, amount, category === 'a transfer' || category === 'Housing : Mortgage interest' ? undefined : category]))
    expect(original.map(r => r[2])).toContain('Housing : Mortgage interest')
    expect((await env.accounts.balances(moved.id)).current).toBe(balance)
  })

  it('asks about each account of a file that holds several, and brings them all over', async () => {
    const env = await setupExport()
    const h = await household(env)
    const balances = [(await env.accounts.balances(h.chequing.id)).current, (await env.accounts.balances(h.visa.id)).current]
    env.answerExport({ formatId: 'format-qif.qif', accountIds: [h.chequing.id, h.visa.id], range: {}, options: {}, rangeState: { choice: 'all' } })
    env.saveAs('Two.qif')
    await env.run()
    const qif = path.join(dir, 'Two.qif')
    fs.writeFileSync(qif, env.saved.get(file('Two.qif'))!)

    await env.session.create(file('Other.tessera'))
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true }, { kind: 'create', remember: true })
    // The categories question is asked once for each account's statement: each is a source of its own
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'file', remember: true })
    const report = await env.manager.importFiles([qif])
    const asked = env.dialogs(IMPORT_DIALOGS.account).slice(-2).map(d => [d.input.statementIndex, d.input.statementCount, d.input.statement.label])
    expect(asked).toEqual([[0, 2, 'Chequing'], [1, 2, 'Visa']])
    expect(report?.results.map(r => [r.outcome, r.accountName])).toEqual([['imported', 'Chequing'], ['imported', 'Visa']])
    const moved = await env.accounts.list()
    expect(await Promise.all(moved.map(async a => [a.name, a.type, (await env.accounts.balances(a.id)).current])))
      .toEqual([['Chequing', 'chequing', balances[0]], ['Visa', 'creditCard', balances[1]]])
  })
})
