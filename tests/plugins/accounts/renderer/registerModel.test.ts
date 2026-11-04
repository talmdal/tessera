import { describe, expect, it } from 'vitest'
import type { Account, Category, RegisterRow } from '@tessera/accounts-api'
import {
  addDays, categoryChoices, draftFrom, emptyDraft, isDirty, nextAfter, stepNumber, toTransactionDraft, toggledStatus
} from '../../../../plugins/accounts/src/renderer/register/model'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 0, order: 0, closed: false, ...over
})
const categories: Category[] = [
  { id: 'food', parentId: null, name: 'Food', kind: 'expense', rev: 1 },
  { id: 'groc', parentId: 'food', name: 'Groceries', kind: 'expense', rev: 1 },
  { id: 'sal', parentId: null, name: 'Salary', kind: 'income', rev: 1 }
]
const accounts = [account(), account({ id: 's', name: 'Savings' }), account({ id: 'u', name: 'US', currency: 'USD' }), account({ id: 'o', name: 'Old', closed: true })]

describe('the register model', () => {
  it('offers categories by label, then transfers to other open accounts in the same currency', () => {
    expect(categoryChoices(categories, accounts, account()).map(c => c.label)).toEqual(['Food', 'Food : Groceries', 'Salary', 'Transfer: Savings'])
  })

  it('turns a row into a draft, the amount in its column, and back', () => {
    const choices = categoryChoices(categories, accounts, account())
    const row: RegisterRow = {
      transaction: { id: 't', rev: 3, accountId: 'c', date: '2026-10-02', amount: -5025, status: 'cleared', voided: false, number: '101', memo: 'm', categoryId: 'groc', createdAt: '', updatedAt: '' },
      balance: 0, available: 0, payeeName: 'Metro', categoryLabel: 'Food : Groceries'
    }
    const draft = draftFrom(row, account(), choices)
    expect(draft).toMatchObject({ id: 't', rev: 3, number: '101', payee: 'Metro', decrease: '50.25', increase: '', category: { kind: 'category', id: 'groc' } })
    expect(toTransactionDraft(draft, 'CAD').transaction).toEqual({ date: '2026-10-02', amount: -5025, status: 'cleared', number: '101', payee: 'Metro', memo: 'm', categoryId: 'groc' })
  })

  it('makes a transfer of a transfer choice, and an increase positive', () => {
    const draft = { ...emptyDraft({ date: '2026-10-02' }), increase: '1,000', category: { kind: 'transfer' as const, accountId: 's', label: 'Transfer: Savings' } }
    expect(toTransactionDraft(draft, 'CAD').transaction).toMatchObject({ amount: 100000, transferAccountId: 's' })
  })

  it('says what is missing or wrong, by field', () => {
    const empty = emptyDraft({ date: '' })
    expect(toTransactionDraft(empty, 'CAD').problems).toEqual({ date: 'Enter a date.', amount: 'Enter an amount.' })
    const both = { ...emptyDraft({ date: '2026-10-02' }), decrease: '1', increase: '2' }
    expect(toTransactionDraft(both, 'CAD').problems.amount).toBe('Enter the amount in one column only.')
    expect(toTransactionDraft({ ...both, increase: '', decrease: '-5' }, 'CAD').problems.amount).toContain('without a sign')
    expect(toTransactionDraft({ ...both, increase: '', decrease: '1.234' }, 'CAD').problems.amount).toBe('Use at most 2 decimal places.')
  })

  it('toggles status, steps dates and numbers, and notices changes', () => {
    expect([toggledStatus('uncleared'), toggledStatus('electronic'), toggledStatus('cleared'), toggledStatus('reconciled')])
      .toEqual(['cleared', 'cleared', 'uncleared', 'uncleared'])
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect([stepNumber('101', 1), stepNumber('ATM', 1), stepNumber('0', -1)]).toEqual(['102', 'ATM', '0'])
    expect([nextAfter('101'), nextAfter('ATM')]).toEqual(['102', ''])
    const a = emptyDraft({ date: '2026-10-02' })
    expect(isDirty(a, { ...a })).toBe(false)
    expect(isDirty(a, { ...a, memo: 'x' })).toBe(true)
  })
})
