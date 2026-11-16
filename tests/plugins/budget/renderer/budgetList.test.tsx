// The Budgets tab, and the Transactions dialog: the ledger's budgets, shown by a click or the keys, their actions
// through the Budget menu's commands; and the transactions behind an actual, each with Open Register.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import { BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_EVENTS, type TransactionsDialogInput } from '@tessera/budget-api'
import BudgetList from '../../../../plugins/budget/src/renderer/BudgetList'
import TransactionsDialog from '../../../../plugins/budget/src/renderer/TransactionsDialog'
import { settle } from '../../../helpers/settle'
import { budgetBridge, renderInTheme, viewOf } from './fixtures'

describe('the Budgets tab', () => {
  it('lists the budgets with what each covers, the one shown selected', async () => {
    budgetBridge()
    renderInTheme(<BudgetList />)
    const list = await screen.findByRole('listbox', { name: 'Budgets in Home' })
    expect(within(list).getAllByRole('option').map(o => [o.textContent, o.getAttribute('aria-selected')])).toEqual([
      ['HouseholdPersonal · CAD', 'true'], ['BusinessBusiness · CAD', 'false']
    ])
  })

  it('shows a budget when clicked or moved to, and acts on it through the commands', async () => {
    const user = userEvent.setup()
    const { executed, emit } = budgetBridge()
    renderInTheme(<BudgetList />)
    await user.click(await screen.findByRole('option', { name: 'Business' }))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.show, args: [{ id: 'business' }] }))
    act(() => emit(BUDGET_EVENTS.budgets, viewOf({ shown: 'business' })))
    expect(screen.getByRole('option', { name: 'Business' })).toHaveAttribute('aria-selected', 'true')
    screen.getByRole('option', { name: 'Business' }).focus()
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.show, args: [{ id: 'household' }] }))
    act(() => emit(BUDGET_EVENTS.budgets, viewOf()))
    await user.keyboard('{F2}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.properties, args: [{ id: 'household' }] }))
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'Business' }) })
    expect((await screen.findAllByRole('menuitem')).map(i => i.textContent)).toEqual(['Show Budget', 'Properties…', 'Duplicate…', 'Delete…'])
    const before = executed().length
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    // Only the delete: the budget shown stays as it was, should the user cancel
    await waitFor(() => expect(executed().slice(before)).toEqual([{ id: C.deleteBudget, args: [{ id: 'business' }] }]))
    await user.click(screen.getByRole('button', { name: 'New budget' }))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newBudget, args: [] }))
  })

  it('offers nothing that changes a ledger open read-only', async () => {
    budgetBridge({ [BUDGET_CHANNELS.budgets]: () => viewOf({ readOnly: true, archive: true, budgets: [], shown: null }) })
    renderInTheme(<BudgetList />)
    expect(await screen.findByText('No budgets in this archive.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New budget' })).toBeDisabled()
    await settle()
  })
})

describe('the Transactions dialog', () => {
  const input: TransactionsDialogInput = {
    row: 'Groceries', period: 'March 2027', currency: 'CAD', total: 65830, actual: 107030,
    rows: [
      { transactionId: 't1', accountId: 'pchq', accountName: 'Personal Chequing', date: '2027-03-03', payee: 'Metro', label: 'Food : Groceries', amount: 59830 },
      { transactionId: 't2', accountId: 'visa', accountName: 'Visa', date: '2027-03-10', label: 'Food : Groceries', amount: 6000 }
    ],
    archived: { amount: 41200, before: '2027-03-01' }
  }

  it('lists the transactions with their total, says how much is archived, and opens a register', async () => {
    const user = userEvent.setup()
    const { executed } = budgetBridge()
    const close = vi.fn()
    renderInTheme(<TransactionsDialog input={input} close={close} setBusy={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Transactions: Groceries' })
    expect(within(table).getAllByRole('row').slice(1).map(r => [...r.querySelectorAll('td')].slice(1, 5).map(c => c.textContent))).toEqual([
      ['Personal Chequing', 'Metro', 'Food : Groceries', '598.30'], ['Visa', '', 'Food : Groceries', '60.00']
    ])
    expect(screen.getByText(/March 2027: 2 transactions, 658.30/)).toBeInTheDocument()
    expect(document.querySelector('[data-note="archived"]')).toHaveTextContent(/^412\.00 of the actual, 1,070\.30, is in the archive before .+, so it isn’t listed\.$/)
    await user.click(within(within(table).getAllByRole('row')[2]).getByRole('button', { name: 'Open Register' }))
    expect(close).toHaveBeenCalledWith()
    await waitFor(() => expect(executed()).toEqual([{ id: ACCOUNTS_COMMANDS.openRegister, args: [{ id: 'visa' }] }]))
  })
})
