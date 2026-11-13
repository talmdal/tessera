// What an OFX family file says the bank calls itself (BANKID, and QFX and QBO's INTU.BID), and the account number,
// kept on the account for exports (docs/export-design.md, "Account fields for OFX", Q9): a new account starts with
// them; an existing one gets those it lacks, never losing one it has, and a file that differs is only warned about.
// The account number only when the statement's account is remembered, as accounts are found by it. Never an Intuit
// id from a file whose ids look made up, which may be another bank's.
import { describe, expect, it } from 'vitest'
import { IMPORT_DIALOGS } from '@tessera/import-api'
import type { AccountInput } from '@tessera/accounts-api'
import { sample, setupImport, type ImportEnv } from './harness'

/** An account made by hand, as it would be before any import. */
const open = (env: ImportEnv, over: Partial<AccountInput> = {}) => env.accounts.createAccount({
  name: 'Everyday', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, ...over
})

describe('the bank’s ids, from an OFX family file', () => {
  it('start a new account made from the statement with both', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true }, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('lakeside-business-2026-10.qbo'), sample('northwind-visa-2026-10.qfx')])
    const accounts = await env.accounts.list()
    // The New Account form was filled in with them (the harness creates what it shows)
    expect(accounts.map(a => [a.type, a.bankId, a.intuitBankId])).toEqual([['chequing', '229000', '2290'], ['creditCard', undefined, '55501']])
  })

  it('fill in what an existing account lacks, say so, and warn when the file differs, never changing the account', async () => {
    const env = await setupImport()
    const everyday = await open(env)
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: everyday.id, remember: true })
    const report = await env.manager.importFiles([sample('lakeside-business-2026-10.qbo')])
    expect(await env.accounts.get(everyday.id)).toMatchObject({ accountNumber: '4002290117', bankId: '229000', intuitBankId: '2290' })
    expect(report?.results[0].warnings).toEqual([
      '“Everyday”’s account number was filled in from the file: •••• 0117.',
      '“Everyday”’s bank number was filled in from the file: 229000.',
      '“Everyday”’s Intuit bank id was filled in from the file: 2290.'
    ])
    // The next file adds nothing, and says nothing of them
    const next = await env.manager.importFiles([sample('lakeside-business-2026-11.qbo')])
    expect(next?.results[0].warnings.join(' ')).not.toMatch(/account number|bank number|Intuit bank id/)
  })

  it('leave an account’s own as they are, warning only about one the file gives otherwise', async () => {
    const env = await setupImport()
    const other = await open(env, { name: 'Other', accountNumber: '4002290118', bankId: '777', intuitBankId: '2290' })
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: other.id, remember: true })
    const report = await env.manager.importFiles([sample('lakeside-business-2026-10.qbo')])
    expect(await env.accounts.get(other.id)).toMatchObject({ accountNumber: '4002290118', bankId: '777', intuitBankId: '2290' })
    expect(report?.results[0].warnings).toEqual([
      'The file gives “Other”’s account number as •••• 0117; the account has •••• 0118, and keeps it.',
      'The file gives “Other”’s bank number as 229000; the account has 777, and keeps it.'
    ])
  })

  it('fill in only the last four of a masked number, as a new account would take, and take it as the same number after', async () => {
    const env = await setupImport()
    const card = await open(env, { name: 'Card', type: 'creditCard' })
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: card.id, remember: true })
    const report = await env.manager.importFiles([sample('northwind-visa-2026-10.qfx')])
    expect((await env.accounts.get(card.id))?.accountNumber).toBe('3456')
    expect(report?.results[0].warnings).toContain('“Card”’s account number was filled in from the file: 3456.')
    // The next statement finds the account by its number, and a masked number ending the same doesn't differ
    const next = await env.manager.importFiles([sample('northwind-visa-2026-11.qfx')])
    expect(next?.results[0].warnings.join(' ')).not.toMatch(/account number/)
  })

  it('warn, with the numbers whole, when two numbers differ only before their last four', async () => {
    const env = await setupImport()
    const other = await open(env, { name: 'Other', accountNumber: '5002290117' })
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: other.id, remember: true })
    const report = await env.manager.importFiles([sample('lakeside-business-2026-10.qbo')])
    expect((await env.accounts.get(other.id))?.accountNumber).toBe('5002290117')
    expect(report?.results[0].warnings).toContain('The file gives “Other”’s account number as 4002290117; the account has 5002290117, and keeps it.')
  })

  it('fill in no account number for a one-off import, which the account shouldn’t be found by next time', async () => {
    const env = await setupImport()
    const everyday = await open(env)
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: everyday.id, remember: false })
    const report = await env.manager.importFiles([sample('lakeside-business-2026-10.qbo')])
    const account = await env.accounts.get(everyday.id)
    expect(account).not.toHaveProperty('accountNumber')
    expect(account?.bankId).toBe('229000')
    expect(report?.results[0].warnings.join(' ')).not.toMatch(/account number/)
  })

  it('never take an Intuit id from a file whose bank ids look made up', async () => {
    const env = await setupImport()
    const everyday = await open(env)
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: everyday.id, remember: true })
    await env.manager.importFiles([sample('maple-trust-chequing-2026-10-converted.qbo')])
    const account = await env.accounts.get(everyday.id)
    expect(account?.bankId).toBe('012345')
    expect(account).not.toHaveProperty('intuitBankId')
  })
})
