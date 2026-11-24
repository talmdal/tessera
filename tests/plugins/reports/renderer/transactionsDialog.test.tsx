// The Transactions dialog (phase R3): what makes up a figure, in date order, each with Open Register; how much of the
// figure archived months hold; and, past the limit, how many there are.
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import type { TransactionsDialogInput } from '@tessera/reports-api'
import TransactionsDialog from '../../../../plugins/reports/src/renderer/TransactionsDialog'
import { renderInTheme, reportsBridge } from './fixtures'

const t = (id: string, date: string, amount: number, over: object = {}) =>
  ({ id, accountId: 'visa', accountName: 'Visa', date, amount, currency: 'CAD', payee: 'FreshCo', label: 'Food : Groceries', ...over })

function open(input: Partial<TransactionsDialogInput> = {}) {
  const close = vi.fn()
  const bridge = reportsBridge()
  const full: TransactionsDialogInput = {
    title: 'Food · Mar 2026', currency: 'CAD', figure: 12500,
    result: { transactions: [t('a', '2026-03-02', 5000), t('b', '2026-03-09', 7500, { accountId: 'chq', accountName: 'Chequing', payee: undefined })], total: 2 },
    ...input
  }
  renderInTheme(<TransactionsDialog input={full} close={close} setBusy={vi.fn()} />)
  return { close, bridge }
}

describe('the Transactions dialog', () => {
  it('lists them in date order with their account, payee, category and part of the figure', () => {
    open()
    expect(screen.getByText('2 transactions, 125.00 (the figure is 125.00)')).toBeInTheDocument()
    const rows = [...document.querySelectorAll('[data-transaction]')].map(r => [...r.querySelectorAll('td')].slice(0, 5).map(c => c.textContent))
    expect(rows).toEqual([
      [expect.stringMatching(/2026/), 'Visa', 'FreshCo', 'Food : Groceries', '50.00'],
      [expect.stringMatching(/2026/), 'Chequing', '', 'Food : Groceries', '75.00']
    ])
  })

  it('opens the account’s register, closing the dialog', async () => {
    const { close, bridge } = open()
    await userEvent.click(screen.getAllByRole('button', { name: 'Open Register' })[1])
    expect(close).toHaveBeenCalled()
    expect(bridge.executed()).toEqual([{ id: ACCOUNTS_COMMANDS.openRegister, args: [{ id: 'chq' }] }])
  })

  it('says how much of the figure archived months hold', () => {
    open({ figure: 53700, result: { transactions: [t('a', '2026-04-02', 12500)], total: 1, archived: { amount: 41200, before: '2026-04-01' } } })
    expect(document.querySelector('[data-note="archived"]')).toHaveTextContent(/^412\.00 of it was archived before .*2026, so it isn’t listed\.$/)
  })

  it('says how many there are past the limit, and suggests a shorter period', () => {
    open({ result: { transactions: Array.from({ length: 3 }, (_, i) => t(`x${i}`, '2026-03-01', 1)), total: 1234 } })
    expect(document.querySelector('[data-note="limit"]')).toHaveTextContent('Showing the first 3 of 1,234. Choose a shorter period to see them all.')
    expect(document.querySelector('[data-note="summary"]')).toHaveTextContent(/^1,234 transactions \(the figure is/)
  })
})
