// New Budget… and Budget Properties…: what a budget covers, chosen from the ledger's tree; the currency most of its
// accounts use, suggested until the user chooses; the accounts another currency leaves out; a name already taken.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BUDGET_CHANNELS, type BudgetDialogInput, type SaveBudgetRequest, type ScopeAccount } from '@tessera/budget-api'
import { mostUsedCurrency } from '@tessera/accounts-api'
import BudgetDialog, { accountsIn, currencyProblem, notCountedNote, strandedLines } from '../../../../plugins/budget/src/renderer/BudgetDialog'
import { BUDGET, budgetBridge, renderInTheme } from './fixtures'

const account = (id: string, name: string, subLedgerId: string | null, currency = 'CAD'): ScopeAccount => ({ id, name, subLedgerId, currency, closed: false })
const INPUT: BudgetDialogInput = {
  ledgerName: 'Home',
  subLedgers: [
    { id: 'personal', parentId: null, name: 'Personal', order: 0 }, { id: 'kids', parentId: 'personal', name: 'Kids', order: 0 },
    { id: 'business', parentId: null, name: 'Business', order: 1 }, { id: 'us', parentId: null, name: 'US', order: 2 }
  ],
  accounts: [
    account('pchq', 'Personal Chequing', 'personal'), account('usvisa', 'US Visa', 'personal', 'USD'), account('kid', 'Kids Savings', 'kids'),
    account('bchq', 'Business Chequing', 'business'), account('uschq', 'US Chequing', 'us', 'USD'), account('ussav', 'US Savings', 'us', 'USD'),
    account('cash', 'Cash', null)
  ],
  subLedgerId: null, yearStartMonth: 4, defaultCurrency: 'CAD'
}

function open(input: BudgetDialogInput, save: (data: SaveBudgetRequest) => unknown = data => ({ ok: true, value: { ...BUDGET, id: data.id ?? 'new', ...data.input } })) {
  const bridge = budgetBridge({ [BUDGET_CHANNELS.saveBudget]: save })
  const close = vi.fn()
  renderInTheme(<BudgetDialog input={input} close={close} setBusy={vi.fn()} />)
  return { ...bridge, close, user: userEvent.setup() }
}

describe('the budget dialog: a new budget', () => {
  it('covers a part of the ledger chosen from its tree, in the currency its accounts use, from the archive\'s year start', async () => {
    const { user, calls, close } = open(INPUT)
    await user.click(screen.getByRole('combobox', { name: 'Covers' }))
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Home (the whole ledger)', 'Personal and its sub-ledgers', 'Kids', 'Business', 'US'
    ])
    await user.click(within(list).getByRole('option', { name: 'US' }))
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('USD')
    await user.click(screen.getByRole('combobox', { name: 'Covers' }))
    await user.click(await screen.findByRole('option', { name: 'Personal and its sub-ledgers' }))
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('CAD')
    expect(screen.getByText('Not counted: US Visa, in USD')).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.paste('Household')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(calls(BUDGET_CHANNELS.saveBudget)).toEqual([{ input: { name: 'Household', subLedgerId: 'personal', currency: 'CAD', yearStartMonth: 4 } }])
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'new' }))
  })

  it('keeps a currency the user chose when the scope changes', async () => {
    const { user } = open(INPUT)
    await user.click(screen.getByRole('combobox', { name: 'Currency' }))
    await user.paste('USD')
    await user.click(await screen.findByRole('option', { name: /^USD/ }))
    expect(screen.getByText('Not counted: Business Chequing, in CAD; Cash, in CAD; Kids Savings, in CAD; Personal Chequing, in CAD')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Covers' }))
    await user.click(await screen.findByRole('option', { name: 'Business' }))
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('USD')
    expect(screen.getByText('Not counted: Business Chequing, in CAD')).toBeInTheDocument()
  })

  it('shows a name already taken on the name field, and stays open', async () => {
    const { user, close } = open(INPUT, () => ({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a budget named “Household”.', field: 'name' } }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.paste('household')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('There is already a budget named “Household”.')).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the budget dialog: properties', () => {
  it('starts from the budget, says a new scope changes its actuals, and saves the whole form against its revision', async () => {
    const { user, calls } = open({ ...INPUT, budget: { ...BUDGET, notes: 'Ours' } })
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Household')
    expect(screen.getByRole('combobox', { name: 'Covers' })).toHaveTextContent('Personal and its sub-ledgers')
    expect(document.querySelector('[data-note="scope-changed"]')).toBeNull()
    await user.click(screen.getByRole('combobox', { name: 'Covers' }))
    await user.click(await screen.findByRole('option', { name: 'Home (the whole ledger)' }))
    expect(document.querySelector('[data-note="scope-changed"]')).toHaveTextContent('A new scope or currency changes which transactions count')
    // The budget's own currency stays: only a new budget's follows the scope
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('CAD')
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.saveBudget)).toEqual([{ id: BUDGET.id, expectedRev: 1, input: { name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1 } }])
  })
})

describe('the budget dialog: what a new scope or currency would do to the lines', () => {
  const withLines = { ...INPUT, budget: { ...BUDGET, subLedgerId: 'personal' }, lineCount: 3, transferLines: [{ accountId: 'bchq', label: 'Transfers from Business Chequing' }] }

  it('refuses a currency with other decimals while the budget has lines, saying why, as the service would', async () => {
    const { user, calls } = open(withLines)
    await user.click(screen.getByRole('combobox', { name: 'Currency' }))
    await user.paste('JPY')
    await user.click(await screen.findByRole('option', { name: /^JPY/ }))
    expect(screen.getByText('Its lines are planned in CAD, which has 2 decimal places; JPY has no decimal places. Make a new budget to plan in JPY.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.saveBudget)).toEqual([])
    expect(currencyProblem({ budget: BUDGET, lineCount: 0 }, 'JPY')).toBeUndefined()           // no lines: nothing to change in value
    expect(currencyProblem({ budget: BUDGET, lineCount: 3 }, 'USD')).toBeUndefined()           // the same decimals
  })

  it('says which transfer lines a new scope would leave counting nothing', async () => {
    const { user } = open(withLines)
    expect(document.querySelector('[data-note="stranded"]')).toBeNull()
    await user.click(screen.getByRole('combobox', { name: 'Covers' }))
    await user.click(await screen.findByRole('option', { name: 'Home (the whole ledger)' }))
    // Business Chequing is now inside the budget: moving money to it or from it isn't income or spending
    expect(document.querySelector('[data-note="stranded"]')).toHaveTextContent('The line “Transfers from Business Chequing” would count nothing')
    expect(strandedLines(withLines, 'personal', 'USD')).toEqual(['Transfers from Business Chequing'])      // another currency
    expect(strandedLines(withLines, 'personal', 'CAD')).toEqual([])
  })
})

describe('the budget dialog\'s scope', () => {
  it('works out the accounts a scope covers and the currency they use', () => {
    expect(accountsIn('personal', INPUT).map(a => a.id)).toEqual(['pchq', 'usvisa', 'kid'])
    expect(accountsIn('(ledger)', INPUT)).toHaveLength(7)
    expect(mostUsedCurrency(accountsIn('us', INPUT), 'CAD')).toBe('USD')
    expect(mostUsedCurrency([], 'EUR')).toBe('EUR')
    expect(notCountedNote(accountsIn('business', INPUT), 'CAD')).toBeUndefined()
  })
})
