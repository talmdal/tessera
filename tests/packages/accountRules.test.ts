import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, AccountsError, accountNameKey, accountNumberKey, isAccountType, isAccountsError,
  isAmount, isIsoDate, isLiability, maskAccountNumber, toAccountsResult, todayIso, validateAccountName
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
