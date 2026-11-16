// Fill from History: the suggestions for the months before the lines start, ticked unless the budget has a line; what
// the list is based on; changing an amount, a frequency or a due date; Fill, all or none, with the service's problem
// on its row. And Duplicate Budget…'s dialog, and New Budget's *Amounts from my last 12 months*.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  BUDGET_CHANNELS, type DuplicateRequest, type FillRequest, type HistoryDialogInput, type LineSuggestion
} from '@tessera/budget-api'
import DuplicateDialog from '../../../../plugins/budget/src/renderer/DuplicateDialog'
import HistoryDialog, { lineOf, rowsOf } from '../../../../plugins/budget/src/renderer/HistoryDialog'
import BudgetDialog from '../../../../plugins/budget/src/renderer/BudgetDialog'
import { BUDGET, budgetBridge, renderInTheme } from './fixtures'

const SUGGESTIONS: LineSuggestion[] = [
  { target: { kind: 'category', categoryId: 'salary' }, group: 'income', label: 'Salary', total: 5473848, average: 456154, amount: 456000, frequency: 'monthly', due: '2027-03' },
  { target: { kind: 'transfer', accountId: 'bchq', direction: 'in' }, group: 'income', label: 'Business Chequing', total: 3600000, average: 300000, amount: 300000, frequency: 'monthly', due: '2027-03' },
  { target: { kind: 'category', categoryId: 'groceries' }, group: 'expense', label: 'Food : Groceries', total: 733524, average: 61127, amount: 62000, frequency: 'monthly', due: '2027-03' },
  { target: { kind: 'category', categoryId: 'insurance' }, group: 'expense', label: 'Housing : Home insurance', total: 118700, average: 9892, amount: 119000, frequency: 'yearly', due: '2026-03' },
  {
    target: { kind: 'category', categoryId: 'internet' }, group: 'expense', label: 'Utilities : Internet', total: 95988, average: 7999, amount: 8000, frequency: 'monthly', due: '2027-03',
    existingLineId: 'l-internet', existingPlan: { from: '2027-01', amount: 7500, frequency: 'monthly', due: '2027-01' }
  }
]
const INPUT: HistoryDialogInput = { budget: BUDGET, start: '2027-03', months: 12, roundTo: 10 }

function open(answers: Parameters<typeof budgetBridge>[0] = {}) {
  const bridge = budgetBridge({
    [BUDGET_CHANNELS.suggest]: () => ({ ok: true, value: SUGGESTIONS }),
    [BUDGET_CHANNELS.fill]: (data: FillRequest) => ({ ok: true, value: data.lines.map((l, i) => ({ id: `l${i}`, budgetId: BUDGET.id, target: l.target, plans: [l.plan], rev: 1 })) }),
    ...answers
  })
  const close = vi.fn()
  renderInTheme(<HistoryDialog input={INPUT} close={close} setBusy={vi.fn()} />)
  return { ...bridge, close, user: userEvent.setup() }
}
const row = (key: string) => document.querySelector(`[data-suggestion="${key}"]`) as HTMLElement

describe('Fill from History', () => {
  it('lists what the months before suggest, ticked unless the budget has a line, and fills what is ticked', async () => {
    const { user, calls, close } = open()
    await screen.findByRole('table', { name: 'Suggested lines' })
    expect(calls(BUDGET_CHANNELS.suggest)).toEqual([{ budgetId: BUDGET.id, months: 12, start: '2027-03', step: 1000 }])
    expect(document.querySelector('[data-history-range]')).toHaveTextContent('whole months: March 2026 to February 2027')
    const ticks = within(screen.getByRole('table')).getAllByRole('checkbox').slice(1)
    expect(ticks.map(t => [t.getAttribute('aria-label'), (t as HTMLInputElement).checked])).toEqual([
      ['Salary', true], ['Transfers from Business Chequing', true], ['Food : Groceries', true], ['Housing : Home insurance', true],
      ['Utilities : Internet', false]
    ])
    expect(row('c:internet').querySelector('[data-existing]')).toHaveTextContent('Has a line: 75.00 every month')
    expect(row('c:insurance')).toHaveTextContent('once, March 2026')
    expect(row('c:insurance')).toHaveTextContent('in March')
    expect(row('c:groceries')).toHaveTextContent('611.27')
    expect(screen.getByRole('button', { name: 'Fill 4 Lines' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Fill 4 Lines' }))
    expect(calls(BUDGET_CHANNELS.fill)).toEqual([{ budgetId: BUDGET.id, lines: [
      { target: { kind: 'category', categoryId: 'salary' }, plan: { from: '2027-03', amount: 456000, frequency: 'monthly', due: '2027-03' } },
      { target: { kind: 'transfer', accountId: 'bchq', direction: 'in' }, plan: { from: '2027-03', amount: 300000, frequency: 'monthly', due: '2027-03' } },
      { target: { kind: 'category', categoryId: 'groceries' }, plan: { from: '2027-03', amount: 62000, frequency: 'monthly', due: '2027-03' } },
      // Seen once: every year, in the month it was seen
      { target: { kind: 'category', categoryId: 'insurance' }, plan: { from: '2027-03', amount: 119000, frequency: 'yearly', due: '2026-03' } }
    ] }])
    await waitFor(() => expect(close).toHaveBeenCalledWith({ count: 4 }))
  })

  it('asks again for other months, another step or another start', async () => {
    const { user, calls } = open()
    await screen.findByRole('table', { name: 'Suggested lines' })
    const months = screen.getByRole('textbox', { name: 'Months' })
    await user.clear(months)
    await user.paste('6')
    await waitFor(() => expect(calls(BUDGET_CHANNELS.suggest).at(-1)).toMatchObject({ months: 6 }))
    expect(document.querySelector('[data-history-range]')).toHaveTextContent('September 2026 to February 2027')
    await user.click(screen.getByRole('combobox', { name: 'Round to' }))
    await user.click(await screen.findByRole('option', { name: '100.00' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.suggest).at(-1)).toMatchObject({ step: 10000 }))
    await user.clear(months)
    await user.paste('30')
    expect(document.querySelector('[data-history-range]')).toHaveTextContent('(1 to 24)')
    await screen.findByRole('table', { name: 'Suggested lines' })
  })

  it('plans what the user changed: an amount, a frequency, a due date; and a line it has, from the month chosen', async () => {
    const { user, calls } = open()
    await screen.findByRole('table', { name: 'Suggested lines' })
    await user.click(within(row('c:internet')).getByRole('checkbox'))
    expect(row('c:internet').querySelector('[data-existing]')).toHaveTextContent('this plans it from March 2027')
    const amount = within(row('c:groceries')).getByRole('textbox', { name: 'Amount for Food : Groceries' })
    await user.clear(amount)
    await user.paste('650')
    await user.click(within(row('c:salary')).getByRole('combobox', { name: 'How often for Salary' }))
    await user.click(await screen.findByRole('option', { name: 'Every two weeks' }))
    // Fortnightly pay needs its day
    await user.click(screen.getByRole('button', { name: 'Fill 5 Lines' }))
    expect(within(row('c:salary')).getByRole('alert')).toHaveTextContent('A weekly or fortnightly plan needs the date it is first due.')
    expect(calls(BUDGET_CHANNELS.fill)).toEqual([])
    await user.click(within(row('c:salary')).getByLabelText('Due date for Salary'))
    await user.paste('2027-01-08')
    await user.click(within(row('c:insurance')).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Fill 4 Lines' }))
    const lines = calls(BUDGET_CHANNELS.fill)[0].lines as FillRequest['lines']
    expect(lines.map(l => [l.target.kind === 'category' ? l.target.categoryId : l.target.accountId, l.plan.amount, l.plan.frequency, l.plan.due])).toEqual([
      ['salary', 456000, 'everyTwoWeeks', '2027-01-08'], ['bchq', 300000, 'monthly', '2027-03'], ['groceries', 65000, 'monthly', '2027-03'],
      ['internet', 8000, 'monthly', '2027-03']
    ])
  })

  it('keeps what the user changed when it asks again for other months; what they didn\'t touch follows the new suggestion', async () => {
    const { user } = open({
      // Six months suggest other amounts than twelve
      [BUDGET_CHANNELS.suggest]: (data: { months: number }) => ({ ok: true, value: SUGGESTIONS.map(x => data.months === 6 ? { ...x, amount: x.amount + 1000 } : x) })
    })
    await screen.findByRole('table', { name: 'Suggested lines' })
    const amount = (label: string) => within(document.body).getByRole('textbox', { name: `Amount for ${label}` })
    await user.clear(amount('Food : Groceries'))
    await user.paste('650')
    await user.click(within(row('c:insurance')).getByRole('checkbox'))          // unticked
    await user.clear(screen.getByRole('textbox', { name: 'Months' }))
    await user.paste('6')
    await waitFor(() => expect(amount('Salary')).toHaveValue('4570.00'))       // untouched: the new suggestion
    expect(amount('Food : Groceries')).toHaveValue('650')                      // changed: kept
    expect(within(row('c:insurance')).getByRole('checkbox')).not.toBeChecked()
  })

  it('shows the service\'s problem on the row it names, and stays open', async () => {
    const { user, close } = open({
      [BUDGET_CHANNELS.fill]: () => ({ ok: false, error: { code: 'INVALID', message: 'Choose a category, or an account transferred with.', field: 'lines[1].target' } })
    })
    await screen.findByRole('table', { name: 'Suggested lines' })
    await user.click(within(row('c:salary')).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Fill 3 Lines' }))
    // With Salary unticked, the second line sent is the groceries
    expect(await within(row('c:groceries')).findByRole('alert')).toHaveTextContent('Choose a category, or an account transferred with.')
    expect(close).not.toHaveBeenCalled()
  })

  it('says when the months suggest nothing, and fills nothing', async () => {
    open({ [BUDGET_CHANNELS.suggest]: () => ({ ok: true, value: [] }) })
    expect(await screen.findByText(/Nothing in those months to suggest a line from/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fill 0 Lines' })).toBeDisabled()
  })

  it('turns a row into a line with the plan\'s rules', () => {
    const [salary, , , insurance] = rowsOf(SUGGESTIONS, 'CAD')
    expect(lineOf({ ...insurance, frequency: 'quarterly' }, '2027-03', 'CAD').line?.plan).toEqual({ from: '2027-03', amount: 119000, frequency: 'quarterly', due: '2027-03' })
    expect(lineOf({ ...salary, amount: 'ten' }, '2027-03', 'CAD').problem).toBeDefined()
    expect(lineOf({ ...salary, frequency: 'twiceAMonth', date: '2027-03-01' }, '2027-03', 'CAD').line?.plan.due).toBe('2027-03-01')
  })
})

describe('Duplicate Budget…', () => {
  it('suggests a name not taken, shows one taken on the field, and closes with the copy', async () => {
    const user = userEvent.setup()
    let taken = true
    const { calls } = budgetBridge({
      [BUDGET_CHANNELS.duplicate]: (data: DuplicateRequest) => taken
        ? { ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a budget named “Household (2)”.', field: 'name' } }
        : { ok: true, value: { ...BUDGET, id: 'copy', name: data.name } }
    })
    const close = vi.fn()
    renderInTheme(<DuplicateDialog input={{ budget: BUDGET, name: 'Household (2)' }} close={close} setBusy={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Household (2)')
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(await screen.findByText('There is already a budget named “Household (2)”.')).toBeInTheDocument()
    taken = false
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.paste('Next year')
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'copy' }))
    expect(calls(BUDGET_CHANNELS.duplicate).at(-1)).toEqual({ id: BUDGET.id, name: 'Next year' })
  })
})

describe('New Budget: Start with', () => {
  it('fills a new budget from history when asked', async () => {
    const user = userEvent.setup()
    budgetBridge({ [BUDGET_CHANNELS.saveBudget]: () => ({ ok: true, value: { ...BUDGET, id: 'new' } }) })
    const close = vi.fn()
    renderInTheme(<BudgetDialog input={{ ledgerName: 'Home', subLedgers: [], accounts: [], subLedgerId: null, yearStartMonth: 1, defaultCurrency: 'CAD' }} close={close} setBusy={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'No lines' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Amounts from my last 12 months' }))
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.paste('Household')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'new', fill: true }))
  })

  it('offers no Start with when changing a budget', () => {
    budgetBridge()
    renderInTheme(<BudgetDialog input={{ budget: BUDGET, ledgerName: 'Home', subLedgers: [], accounts: [], subLedgerId: null, yearStartMonth: 1, defaultCurrency: 'CAD' }} close={vi.fn()} setBusy={vi.fn()} />)
    expect(screen.queryByRole('radio', { name: 'No lines' })).toBeNull()
  })
})
