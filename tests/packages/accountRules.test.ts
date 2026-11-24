import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, AccountsError, accountNameKey, accountNumberKey, isAccountType, isAccountsError,
  isAmount, isIsoDate, isLiability, maskAccountNumber, toAccountsResult, todayIso, validateAccountName,
  accountScope, crossesScope, type AccountType
} from '@tessera/accounts-api'

describe('account rules', () => {
  it('check names, comparing them ignoring case and spaces', () => {
    expect(validateAccountName('Chequing')).toBeUndefined()
    expect(validateAccountName('Visa / Joint')).toBeUndefined()     // account names aren't file names
    expect(validateAccountName('  ')).toBe('Enter a name.')
    expect(validateAccountName(3)).toBe('Enter a name.')
    expect(validateAccountName('x'.repeat(101))).toBe('Use at most 100 characters.')
    expect(validateAccountName('a\tb')).toBe('A name can’t contain control characters.')
    expect(accountNameKey(' Visa ')).toBe(accountNameKey('visa'))
  })

  it('reduce account numbers to what identifies them, and mask them for display', () => {
    expect(accountNumberKey('12-34 56AB')).toBe('123456ab')
    expect(maskAccountNumber('4520 1234 5678 9012')).toBe('•••• 9012')
    expect(maskAccountNumber('1234')).toBe('1234')
    expect(maskAccountNumber(undefined)).toBe('')
  })

  it('know real dates, and today in the local time zone', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('26-2-1')).toBe(false)
    expect(todayIso(new Date(2026, 10, 4, 23, 59))).toBe('2026-11-04')
  })

  it('know amounts, types and which types are owed', () => {
    expect(isAmount(123)).toBe(true)
    expect(isAmount(1.5)).toBe(false)
    expect(isAmount(10 ** 16)).toBe(false)
    expect(ACCOUNT_TYPES.every(isAccountType)).toBe(true)
    expect(isAccountType('bitcoin')).toBe(false)
    expect(Object.keys(ACCOUNT_TYPE_LABELS).sort()).toEqual([...ACCOUNT_TYPES].sort())
    expect(isLiability('mortgage')).toBe(true)
    expect(isLiability('savings')).toBe(false)
  })
})

describe('accounts errors', () => {
  it('are recognised by shape across plugins\' copies of the package, and become results for views', async () => {
    const copy = Object.assign(new Error('Taken'), { name: 'AccountsError', code: 'DUPLICATE_NAME' })
    expect(isAccountsError(copy)).toBe(true)
    expect(isAccountsError(new Error('x'))).toBe(false)
    expect(await toAccountsResult(async () => { throw new AccountsError('CONFIRMATION_REQUIRED', 'Balance', undefined, ['closeWithBalance']) }))
      .toEqual({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Balance', reasons: ['closeWithBalance'] } })
    expect(await toAccountsResult(async () => 1)).toEqual({ ok: true, value: 1 })
    await expect(toAccountsResult(async () => { throw new TypeError('bug') })).rejects.toThrow('bug')
  })
})

describe('which balance to show', () => {
  it('is the one above the minimum only when the account asks for it and has a minimum', async () => {
    const { showsAvailable, shownBalance, shownRunningBalance } = await import('@tessera/accounts-api')
    const balances = { current: 800000, available: 400000, cleared: 0, reconciled: 0, transactionCount: 0 }
    const row = { balance: 800000, available: 400000 }
    expect(showsAvailable({ minimumBalance: 400000, showAvailableBalance: true })).toBe(true)
    expect(showsAvailable({ minimumBalance: 400000 })).toBe(false)
    expect(showsAvailable({ showAvailableBalance: true })).toBe(false)
    expect(shownBalance({ minimumBalance: 400000, showAvailableBalance: true }, balances)).toBe(400000)
    expect(shownRunningBalance({ minimumBalance: 400000, showAvailableBalance: true }, row)).toBe(400000)
    expect(shownRunningBalance({ minimumBalance: 400000 }, row)).toBe(800000)
  })
})

describe('the current period', () => {
  it('starts on the last archival date once the account has been archived, else on the opening date', async () => {
    const { periodStart } = await import('@tessera/accounts-api')
    expect(periodStart({ openingDate: '2023-01-01' })).toBe('2023-01-01')
    expect(periodStart({ openingDate: '2023-01-01', lastArchiveDate: '2025-01-01' })).toBe('2025-01-01')
    // An account opened after the archive date: it starts when it opened
    expect(periodStart({ openingDate: '2025-06-01', lastArchiveDate: '2025-01-01' })).toBe('2025-06-01')
  })
})

// The scope a budget or a report covers, and when a transfer crosses it (accounts-api 1.15). The budget's worked cases
// (docs/budget-design.md, "Transfers across the budget's scope"), generalised to reports' scopes
// (docs/reporting-design.md, "Scope and currency").
describe('what a budget or a report covers', () => {
  const tree = [
    { id: 'personal', parentId: null, name: 'Personal', order: 0 },
    { id: 'joint', parentId: 'personal', name: 'Joint', order: 0 },
    { id: 'business', parentId: null, name: 'Business', order: 1 }
  ]
  const a = (id: string, subLedgerId: string | null, type: AccountType = 'chequing', currency = 'CAD') => ({ id, name: id, subLedgerId, type, currency })
  const accounts = [
    a('Personal Chequing', 'personal'), a('Savings', 'personal', 'savings'), a('Joint Visa', 'joint', 'creditCard'),
    a('US Visa', 'personal', 'creditCard', 'USD'), a('Business Chequing', 'business'), a('Mortgage', null, 'mortgage'), a('Cash', null, 'cash')
  ]
  const all = new Set(accounts.map(x => x.id))
  const exists = (id: string) => all.has(id)
  const transfer = (other: string | null, transferSubLedgerId?: string | null) => ({ transferAccountId: other, ...(transferSubLedgerId !== undefined && { transferSubLedgerId }) })

  it('covers a sub-ledger and everything beneath it, where each account is now, counting the currency asked for', () => {
    const scope = accountScope({ kind: 'subLedger', subLedgerId: 'personal' }, tree, accounts, 'CAD')
    expect([...scope.inside].sort()).toEqual(['Joint Visa', 'Personal Chequing', 'Savings', 'US Visa'])
    expect([...scope.counted].sort()).toEqual(['Joint Visa', 'Personal Chequing', 'Savings'])
    expect(scope.notCounted).toEqual([{ accountId: 'US Visa', name: 'US Visa', currency: 'USD' }])
    expect(scope.covers({ id: 'gone', subLedgerId: 'joint' })).toBe(true)
    expect(scope.covers({ id: 'gone', subLedgerId: null })).toBe(false)
  })

  it('counts a transfer exactly when it crosses the scope: the owner’s pay from the business, not savings', () => {
    const personal = accountScope({ kind: 'subLedger', subLedgerId: 'personal' }, tree, accounts, 'CAD')
    expect(crossesScope(transfer('Business Chequing'), personal, exists)).toBe(true)      // the owner's pay: money in
    expect(crossesScope(transfer('Savings'), personal, exists)).toBe(false)              // inside the scope
    expect(crossesScope(transfer('US Visa'), personal, exists)).toBe(false)              // inside, whatever its currency
    expect(crossesScope(transfer(null), personal, exists)).toBe(false)                   // not a transfer
    // Over the whole ledger, no transfer ever crosses
    const ledger = accountScope({ kind: 'ledger' }, tree, accounts, 'CAD')
    expect(accounts.every(x => !crossesScope(transfer(x.id), ledger, exists))).toBe(true)
    expect(ledger.counted.size).toBe(6)
  })

  it('judges an account an archive removed where it was', () => {
    const personal = accountScope({ kind: 'subLedger', subLedgerId: 'personal' }, tree, accounts, 'CAD')
    expect(crossesScope(transfer('Old Savings', 'joint'), personal, exists)).toBe(false)
    expect(crossesScope(transfer('Old Business Savings', 'business'), personal, exists)).toBe(true)
    expect(crossesScope(transfer('Old Cash', null), personal, exists)).toBe(true)
  })

  it('covers account types, in the ledger or beneath a sub-ledger: everyday accounts, in the business', () => {
    const everyday: AccountType[] = ['chequing', 'savings', 'creditCard', 'lineOfCredit']
    const ledger = accountScope({ kind: 'types', types: everyday }, tree, accounts, 'CAD')
    expect([...ledger.counted].sort()).toEqual(['Business Chequing', 'Joint Visa', 'Personal Chequing', 'Savings'])
    // Paying the mortgage, or putting money in the cash account, leaves the everyday accounts
    expect(crossesScope(transfer('Mortgage'), ledger, exists)).toBe(true)
    expect(crossesScope(transfer('Cash'), ledger, exists)).toBe(true)
    expect(crossesScope(transfer('Savings'), ledger, exists)).toBe(false)
    const business = accountScope({ kind: 'types', types: everyday, subLedgerId: 'business' }, tree, accounts, 'CAD')
    expect([...business.inside]).toEqual(['Business Chequing'])
    // An account whose type isn't known (one an archive removed) is outside a scope of types
    expect(business.covers({ id: 'gone', subLedgerId: 'business' })).toBe(false)
  })

  it('covers accounts chosen by id, an archived one’s old id included', () => {
    const chosen = accountScope({ kind: 'accounts', accountIds: ['Savings', 'Old Savings'] }, tree, accounts, 'CAD')
    expect([...chosen.inside]).toEqual(['Savings'])
    expect(crossesScope(transfer('Personal Chequing'), chosen, exists)).toBe(true)
    expect(crossesScope(transfer('Old Savings', 'personal'), chosen, exists)).toBe(false)
  })
})
