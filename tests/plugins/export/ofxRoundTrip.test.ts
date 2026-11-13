// OFX there and back, through the whole export and import (docs/export-design.md, "What survives a round trip" and
// "Account fields for OFX"). Back into the account it came from, the statement is known by its bank and number, the
// bank's own ids are recognised, and a line the user typed is proposed as a match: nothing is added. Into a new ledger,
// the account comes over with its number and bank number, at the same balance. What is typed in the Export dialog for
// the account is used for that file only, and the account is left as it was.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { IMPORT_DIALOGS } from '@tessera/import-api'
import type { CheckResponse, ExportDialogInput, ExportDialogResult } from '@tessera/export-api'
import { file } from '../ledger/harness'
import { sample } from '../import/harness'
import { setupExport, type ExportEnv } from './harness'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-ofx-round-trip-'))
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** The Maple Trust chequing account, imported from its bank's OFX (which gives its number and bank number). */
async function imported(env: ExportEnv) {
  env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
  await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
  const [account] = await env.accounts.list()
  return account
}

/** File › Export… of one account, saved to a real file for the import to read. */
async function exportTo(env: ExportEnv, name: string, request: Partial<ExportDialogResult> & Pick<ExportDialogResult, 'accountIds'>) {
  env.answerExport({ formatId: 'format-ofx.ofx', range: {}, options: {}, rangeState: { choice: 'all' }, ...request })
  env.saveAs(name)
  await env.run()
  const at = path.join(dir, `${Math.random().toString(36).slice(2)}-${name}`)
  fs.writeFileSync(at, env.saved.get(file(name))!)
  return { at, text: fs.readFileSync(at, 'latin1') }
}

describe('OFX there and back', () => {
  it('offers OFX, QFX and QBO, with the account’s fields to start from', async () => {
    const env = await setupExport()
    const account = await imported(env)
    env.answerExport(undefined)
    await env.run()
    const input = env.dialogs('export.dialog.export')[0].input as ExportDialogInput
    expect(input.formats.map(f => f.id)).toEqual(['format-csv.csv', 'format-qif.qif', 'format-ofx.ofx', 'format-ofx.qfx', 'format-ofx.qbo'])
    expect(input.formats[2].accountFields.map(u => u.field)).toEqual(['accountNumber', 'bankId'])
    expect(input.accounts.find(a => a.id === account.id)).toMatchObject({ accountNumber: '8812345678', bankId: '012345' })
  })

  it('adds nothing back into the account it came from: the bank’s ids are known, and what the user typed is matched', async () => {
    const env = await setupExport()
    const account = await imported(env)
    await env.accounts.transactions(account.id).create({ date: '2026-10-29', amount: -4500, payee: 'Corner Store' })
    const before = await env.accounts.transactions(account.id).list()
    const { at, text } = await exportTo(env, 'Maple.ofx', { accountIds: [account.id] })
    expect(text).toContain('<BANKID>012345')
    expect(text).toContain('<ACCTID>8812345678')

    const report = await env.manager.importFiles([at])
    // Known by its bank and number, so no question: the saved match from the first import
    expect(env.dialogs(IMPORT_DIALOGS.account)).toHaveLength(1)
    expect(report?.results.map(r => [r.outcome, r.accountName, r.counts])).toEqual([['imported', account.name, {
      lines: 18, added: 0, matched: 1, possible: 0, duplicates: 17, invalid: 0
    }]])
    expect(await env.accounts.transactions(account.id).list()).toEqual(before)
  })

  it('brings the account into a new ledger with its number and bank number, at the same balance', async () => {
    const env = await setupExport()
    const account = await imported(env)
    const balance = (await env.accounts.balances(account.id)).current
    const { at } = await exportTo(env, 'Maple.ofx', { accountIds: [account.id] })

    await env.session.create(file('Other.tessera'))
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const report = await env.manager.importFiles([at])
    expect(report?.results.map(r => [r.outcome, r.counts.added])).toEqual([['imported', 17]])
    const [moved] = await env.accounts.list()
    expect(moved).toMatchObject({ accountNumber: '8812345678', bankId: '012345', institution: 'Maple Trust Bank', type: 'chequing' })
    expect((await env.accounts.balances(moved.id)).current).toBe(balance)
  })

  it('uses what is typed in the dialog for the file, and leaves the account as it was', async () => {
    const env = await setupExport()
    const account = await imported(env)
    const { text } = await exportTo(env, 'Typed.ofx', { accountIds: [account.id], accountValues: { [account.id]: { bankId: '999', accountNumber: '11-22-33' } } })
    expect(text).toContain('<BANKID>999')
    expect(text).toContain('<ACCTID>112233')
    expect(await env.accounts.get(account.id)).toMatchObject({ bankId: '012345', accountNumber: '8812345678' })
  })

  it('writes QBO with the account’s Intuit id, and without one, warns that QuickBooks may refuse it', async () => {
    const env = await setupExport()
    const account = await imported(env)
    const without = await exportTo(env, 'No id.qbo', { formatId: 'format-ofx.qbo', accountIds: [account.id] })
    expect(without.text).not.toContain('<INTU.BID>')
    expect(env.messages().at(-1)).toMatchObject({ kind: 'warning', detail: expect.stringContaining('has no Intuit bank id, so QuickBooks may refuse this file') })

    await env.accounts.updateAccount(account.id, { intuitBankId: '2290' })
    const withId = await exportTo(env, 'With id.qbo', { formatId: 'format-ofx.qbo', accountIds: [account.id] })
    expect(withId.text).toContain('<INTU.BID>2290')
    expect(env.messages().at(-1)?.detail).not.toMatch(/Intuit bank id/)
  })

  it('refuses an account OFX can’t hold, and a bank account without its bank number', async () => {
    const env = await setupExport()
    const loan = await env.accounts.createAccount({ name: 'Car Loan', type: 'loan', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: -1000000 })
    await env.accounts.transactions(loan.id).create({ date: '2026-10-01', amount: 50000, payee: 'Payment' })
    const typed = await env.accounts.createAccount({ name: 'Typed', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, accountNumber: '555' })
    await env.accounts.transactions(typed.id).create({ date: '2026-10-01', amount: -100, payee: 'Shop' })
    const problems = async (accountId: string) => {
      const reply = await env.check<CheckResponse>({ formatId: 'format-ofx.ofx', accountIds: [accountId], range: {}, options: {} })
      return reply.ok ? reply.value.problems : reply.error
    }
    // Only that: asking for its numbers would be beside the point
    expect(await problems(loan.id)).toEqual(['This file type can’t hold loan accounts, such as “Car Loan”.'])
    expect(await problems(typed.id)).toEqual(['Enter “Typed”’s bank number: a bank statement says which bank it is from by it. It is in the bank’s own OFX files, after <BANKID>.'])
    // Typed in the dialog, it will do, for this file
    const reply = await env.check<CheckResponse>({ formatId: 'format-ofx.ofx', accountIds: [typed.id], range: {}, options: {}, accountValues: { [typed.id]: { bankId: '004' } } })
    expect(reply.ok && reply.value.problems).toEqual([])
  })
})
