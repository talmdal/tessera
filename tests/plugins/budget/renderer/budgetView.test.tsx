// The budget view: the design's Household for March 2027 drawn from a status the plugin's own code works out, the
// colours from the theme's tokens, the keys, the period chooser, the empty states and a ledger open read-only.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_EVENTS, BUDGET_SETTINGS_PAGE, type StatusRequest } from '@tessera/budget-api'
import BudgetView from '../../../../plugins/budget/src/renderer/BudgetView'
import { gridRows, remainingIsBad } from '../../../../plugins/budget/src/renderer/gridModel'
import { percentOf, periodName } from '../../../../plugins/budget/src/renderer/display'
import { settle } from '../../../helpers/settle'
import { BUDGET, budgetBridge, computedColour, renderInTheme, statusFor, viewOf } from './fixtures'

// The first draw of a file loads MUI's table, slow under the whole suite's load
const grid = () => screen.findByRole('treegrid', { name: /^Household, / }, { timeout: 5000 })
const row = (key: string) => document.querySelector(`[data-grid-row="${key}"]`) as HTMLElement
const cell = (key: string, column: string) => row(key).querySelector(`[data-column="${column}"]`) as HTMLElement
const labels = () => [...document.querySelectorAll('[data-grid-row]')].map(r => (r.querySelector('td') as HTMLElement).textContent)

async function show(options: Parameters<typeof budgetBridge>[0] = {}, mode: 'light' | 'dark' = 'light') {
  const bridge = budgetBridge(options)
  const drawn = renderInTheme(<BudgetView />, mode)
  await grid()
  await settle()
  return { ...bridge, ...drawn }
}

describe('the budget view: a month', () => {
  it('draws every row of the design\'s March, in order, with the days each line falls due', async () => {
    await show()
    expect(screen.getByRole('heading', { name: 'Household · Personal · CAD' })).toBeInTheDocument()
    expect(document.querySelector('[data-period-label]')).toHaveTextContent('March 2027')
    expect(labels()).toEqual([
      'Income', 'Salary', 'Transfers from Business Chequing', 'Other income', 'Total income',
      'Expenses', 'Food', 'Groceries', 'Food (other)', 'Housing', 'Home insurance', 'Rent', 'Other expenses', 'Uncategorised', 'Total expenses',
      'Net'
    ])
    expect(cell('line:l-salary', 'due')).toHaveTextContent('5, 19')
    expect(cell('line:l-insurance', 'due')).toHaveTextContent('15')
    expect(cell('line:l-groceries', 'due')).toHaveTextContent(/^$/)                 // no particular day
    expect(cell('line:l-salary', 'budget')).toHaveTextContent('4,200.00')
    expect(cell('other:income', 'budget')).toHaveTextContent('—')
    expect(cell('subtotal:food', 'actual')).toHaveTextContent('862.15')
    expect(cell('subtotal:food', 'remaining')).toHaveTextContent('-62.15')
    expect(cell('net', 'remaining')).toHaveTextContent('3.65')              // ahead of the plan
    expect(screen.getByText('Not counted: US Visa, in USD')).toBeInTheDocument()
  })

  it('draws Remaining in red for expenses over budget and never for income, in the theme\'s error colour, light or dark', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const { theme, unmount } = await show({}, mode)
      const red = computedColour(theme.palette.error.main)
      for (const key of ['subtotal:food', 'line:l-food', 'other:expense', 'uncategorised:expense', 'total:expense']) {
        expect(cell(key, 'remaining'), key).toHaveAttribute('data-bad')
        expect(getComputedStyle(cell(key, 'remaining')).color, `${key}, ${mode}`).toBe(red)
      }
      // More income than planned is good news, and the month is ahead of the plan
      for (const key of ['other:income', 'total:income', 'net', 'line:l-groceries']) {
        expect(cell(key, 'remaining'), key).not.toHaveAttribute('data-bad')
        expect(getComputedStyle(cell(key, 'remaining')).color, key).not.toBe(red)
      }
      unmount()
    }
  })

  it('warns amber from 90 % and red over budget, with a bar and its share', async () => {
    await show()
    expect(row('line:l-groceries')).toHaveAttribute('data-warning', 'near')        // 92 %
    expect(row('line:l-rent')).toHaveAttribute('data-warning', 'near')             // exactly its budget
    expect(row('line:l-insurance')).toHaveAttribute('data-warning', 'near')        // 98 %
    expect(row('line:l-food')).toHaveAttribute('data-warning', 'over')
    expect(row('subtotal:food')).toHaveAttribute('data-warning', 'over')
    expect(within(row('line:l-food')).getByRole('progressbar', { name: 'Food (other): 175% of the budget' })).toHaveAttribute('aria-valuenow', '100')
    expect(within(row('line:l-groceries')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '92')
    expect(within(row('other:expense')).queryByRole('progressbar')).toBeNull()       // no budget to measure against
    expect(row('line:l-salary')).not.toHaveAttribute('data-warning')                // income never warns
  })

  it('closes a subtotal and opens what Other gathers, with the keys and a click', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(within(row('subtotal:food')).getByText('Food'))
    expect(row('subtotal:food')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(row('subtotal:food')).toHaveAttribute('aria-expanded', 'false')
    expect(row('line:l-groceries')).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(row('line:l-groceries')).not.toBeNull()
    expect(row('other:expense')).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(row('other:expense')).getByText('Other expenses'))
    await user.keyboard('{ArrowRight}')
    expect(row('other:expense>pets')).toHaveTextContent('Pets')
    expect(cell('other:expense>pets', 'actual')).toHaveTextContent('86.20')
  })
})

describe('the budget view: keys and commands', () => {
  it('moves with the arrows, and edits, adds, deletes and lists transactions with the keys, reporting the line first', async () => {
    const user = userEvent.setup()
    const { executed, calls } = await show()
    await user.click(within(row('line:l-groceries')).getByText('Groceries'))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.select).at(-1)).toEqual({ budgetId: 'household', month: '2027-03', period: 'month', lineId: 'l-groceries' }))
    await user.keyboard('{ArrowDown}')
    expect(row('line:l-food')).toHaveAttribute('aria-selected', 'true')
    expect(row('line:l-food')).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.editLine, args: [{ id: 'l-food' }] }))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.deleteLine, args: [{ id: 'l-food' }] }))
    await user.keyboard('{Insert}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newLine, args: [] }))
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(executed().at(-1)).toEqual({
      id: C.transactions,
      args: [{ budgetId: 'household', row: { kind: 'parentLine', group: 'expense', lineId: 'l-food', categoryId: 'food' }, months: { from: '2027-03', to: '2027-03' }, label: 'Food (other)', period: 'March 2027' }]
    }))
  })

  it('adds a line for a category under Other, or one with no line of its own', async () => {
    const user = userEvent.setup()
    const { executed } = await show()
    await user.click(within(row('other:expense')).getByText('Other expenses'))
    await user.keyboard('{ArrowRight}{ArrowDown}{Enter}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newLine, args: [{ target: { kind: 'category', categoryId: 'pets' } }] }))
    await user.dblClick(within(row('subtotal:housing')).getByText('Housing'))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newLine, args: [{ target: { kind: 'category', categoryId: 'housing' } }] }))
  })

  it('opens the transactions from a double-click on an Actual, and the row\'s menu with Shift+F10', async () => {
    const user = userEvent.setup()
    const { executed } = await show()
    await user.dblClick(cell('uncategorised:expense', 'actual'))
    await waitFor(() => expect(executed().at(-1)).toMatchObject({ id: C.transactions, args: [{ row: { kind: 'uncategorised', group: 'expense' }, label: 'Uncategorised' }] }))
    await user.click(within(row('line:l-rent')).getByText('Rent'))
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([
      'Edit Line…Enter', 'New Line…Insert', 'Delete LineDelete', 'Show TransactionsCtrl+Enter'
    ])
    await user.click(within(menu).getByRole('menuitem', { name: /Delete Line/ }))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.deleteLine, args: [{ id: 'l-rent' }] }))
  })

  it('selects the line a command added, once the status has it', async () => {
    const { emit } = await show()
    act(() => emit(BUDGET_EVENTS.line, { budgetId: 'household', lineId: 'l-insurance' }))
    await waitFor(() => expect(row('line:l-insurance')).toHaveAttribute('aria-selected', 'true'))
  })

  it('reloads the status when the plugin says so, for its budget or every budget', async () => {
    const { emit, calls } = await show()
    const before = calls(BUDGET_CHANNELS.status).length
    act(() => emit(BUDGET_EVENTS.status, { budgetId: 'business' }))
    act(() => emit(BUDGET_EVENTS.status, { budgetId: null }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.status).length).toBe(before + 1))
    act(() => emit(BUDGET_EVENTS.status, { budgetId: 'household' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.status).length).toBe(before + 2))
  })
})

describe('the budget view: the period', () => {
  it('steps a month with the buttons and Page Up and Down, and shows the year to date of a fiscal year', async () => {
    const user = userEvent.setup()
    const { calls } = await show({ [BUDGET_CHANNELS.budgets]: () => viewOf({ budgets: [{ ...viewOf().budgets[0], yearStartMonth: 4 }] }) })
    const asked = () => (calls(BUDGET_CHANNELS.status).at(-1) as StatusRequest).months
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(asked()).toEqual({ from: '2027-02', to: '2027-02' }))
    await user.click(within(row('line:l-rent')).getByText('Rent'))
    await user.keyboard('{PageDown}{PageDown}')
    await waitFor(() => expect(asked()).toEqual({ from: '2027-04', to: '2027-04' }))
    await user.click(screen.getByRole('combobox', { name: 'Period' }))
    await user.click(await screen.findByRole('option', { name: 'Year to date' }))
    await waitFor(() => expect(asked()).toEqual({ from: '2027-04', to: '2027-04' }))
    expect(document.querySelector('[data-period-label]')).toHaveTextContent('Year to date, April 2027')
    await user.keyboard('{PageUp}')
    await waitFor(() => expect(asked()).toEqual({ from: '2026-04', to: '2027-03' }))
    expect(document.querySelector('[data-period-label]')).toHaveTextContent('Year to date, April 2026 to March 2027')
    // No Due column outside a single month
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Due' })).toBeNull())
    expect(calls(BUDGET_CHANNELS.select).at(-1)).toMatchObject({ month: '2027-03', period: 'yearToDate' })
  })

  it('names periods for calendar and fiscal years', () => {
    expect(periodName('month', '2027-03', 1)).toBe('March 2027')
    expect(periodName('yearToDate', '2027-03', 1)).toBe('Year to date, January to March 2027')
    expect(periodName('yearToDate', '2027-01', 1)).toBe('Year to date, January 2027')
    expect(periodName('yearToDate', '2027-03', 4)).toBe('Year to date, April 2026 to March 2027')
    expect(periodName('year', '2027-03', 4)).toBe('Year, April 2026 to March 2027')
  })
})

describe('the budget view: empty, new and read-only', () => {
  it('offers New Budget when the ledger has none', async () => {
    const user = userEvent.setup()
    const { executed } = budgetBridge({ [BUDGET_CHANNELS.budgets]: () => viewOf({ budgets: [], shown: null }) })
    renderInTheme(<BudgetView />)
    expect(await screen.findByText('Plan what you expect to earn and spend, and see how each month is going.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New Budget…' }))
    await waitFor(() => expect(executed()).toEqual([{ id: C.newBudget, args: [] }]))
  })

  it('says an archive has no budgets, and offers none', async () => {
    budgetBridge({ [BUDGET_CHANNELS.budgets]: () => viewOf({ budgets: [], shown: null, readOnly: true, archive: true }) })
    renderInTheme(<BudgetView />)
    expect(await screen.findByText('No budgets in this archive.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Budget…' })).toBeNull()
  })

  it('offers Add Line for a budget with no lines, beside what its transactions show', async () => {
    const user = userEvent.setup()
    const { executed } = await show({ [BUDGET_CHANNELS.status]: (data: StatusRequest) => ({ ok: true, value: statusFor(data.months, []) }) })
    expect(screen.getByText(/This budget has no lines yet/)).toBeInTheDocument()
    expect(labels()).toContain('Other expenses')
    await user.click(screen.getByRole('button', { name: 'Add Line…' }))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newLine, args: [] }))
  })

  it('on a ledger open read-only, says so and offers nothing that changes the budget', async () => {
    const user = userEvent.setup()
    const { executed } = await show({ [BUDGET_CHANNELS.budgets]: () => viewOf({ readOnly: true }) })
    expect(screen.getByText('The ledger is open read-only, so its budgets can be looked at, not changed.')).toBeInTheDocument()
    for (const name of ['New Line…', 'Edit Line…', 'Delete Line']) expect(screen.getByRole('button', { name })).toBeDisabled()
    await user.click(within(row('line:l-rent')).getByText('Rent'))
    await user.keyboard('{Enter}{Delete}{Insert}')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(executed().map(e => e.id)).toEqual([C.transactions]))
  })

  it('shows the load\'s problem rather than a grid', async () => {
    budgetBridge({ [BUDGET_CHANNELS.status]: () => ({ ok: false, error: { code: 'INVALID', message: 'These amounts are too large to total exactly.' } }) })
    renderInTheme(<BudgetView />)
    expect(await screen.findByText('These amounts are too large to total exactly.')).toBeInTheDocument()
    expect(screen.queryByRole('treegrid')).toBeNull()
  })
})

describe('the budget view: hidden behind another view', () => {
  /** What the browser's IntersectionObserver tells the view; jsdom has none. */
  class FakeObserver {
    static last: FakeObserver | undefined
    constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) { FakeObserver.last = this }
    observe() {}
    disconnect() {}
    seen(isIntersecting: boolean) { act(() => this.callback([{ isIntersecting }])) }
  }
  const global = globalThis as { IntersectionObserver?: unknown }
  afterEach(() => { delete global.IntersectionObserver })

  it('reads no status while hidden, and reads it once when shown again, however many changes came meanwhile', async () => {
    global.IntersectionObserver = FakeObserver
    const { emit, calls } = await show()
    const loads = () => calls(BUDGET_CHANNELS.status).length
    const before = loads()
    FakeObserver.last!.seen(false)                    // another view in front: the shell hides this one, mounted
    for (let i = 0; i < 3; i++) act(() => emit(BUDGET_EVENTS.status, { budgetId: null }))
    await settle()
    expect(loads()).toBe(before)
    FakeObserver.last!.seen(true)
    await waitFor(() => expect(loads()).toBe(before + 1))
    await settle()
    expect(loads()).toBe(before + 1)
    // Shown, a change is read at once, as before
    act(() => emit(BUDGET_EVENTS.status, { budgetId: BUDGET.id }))
    await waitFor(() => expect(loads()).toBe(before + 2))
  })
})

describe('the budget view: the Budget page\'s settings', () => {
  it('leaves the bars out, and shows lines with nothing this period, as the page says', async () => {
    await show({ [BUDGET_CHANNELS.budgets]: () => viewOf({ month: '2027-02', options: { showBars: false, showEmptyLines: true } }) })
    expect(screen.queryAllByRole('progressbar')).toEqual([])
    expect(row('line:l-rent').querySelector('[data-column="bar"]')).toBeNull()
    // February: the yearly insurance has nothing, and is shown
    expect(row('line:l-insurance')).not.toBeNull()
  })

  it('changes them from the More menu, as the page would, and opens the page', async () => {
    const user = userEvent.setup()
    const { calls, executed } = await show({ [BUDGET_CHANNELS.viewOptions]: () => undefined })
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show bars' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Show lines with nothing this period' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.viewOptions)).toEqual([{ showEmptyLines: true }]))
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Show bars' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.viewOptions).at(-1)).toEqual({ showBars: false }))
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Budget Options…' }))
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: 'shell.settings.open', args: [BUDGET_SETTINGS_PAGE] }))
  })
})

describe('the grid\'s rows', () => {
  it('hides rows with nothing this period unless asked, and a subtotal only when everything under it is empty', () => {
    const status = statusFor({ from: '2027-02', to: '2027-02' }, undefined, [])
    const keys = (showEmpty: boolean) => gridRows(status, { collapsed: new Set(), expanded: new Set(), showEmpty }).map(r => r.key)
    // February: no transactions, and the yearly insurance isn't due
    expect(keys(false)).not.toContain('line:l-insurance')
    expect(keys(false)).toContain('subtotal:housing')
    expect(keys(true)).toContain('line:l-insurance')
  })

  it('gives each share of a budget exactly, rounded down, as the plugin\'s warnings are worked out', () => {
    // Floating point gave 28 % for 29 of 100, and one point short for many exact shares
    expect(percentOf(29, 100)).toBe(29)
    expect(percentOf(57, 100)).toBe(57)
    expect(percentOf(9000, 10000)).toBe(90)
    expect(percentOf(-500, 10000)).toBe(0)             // a refund: nothing spent
    expect(percentOf(100, 0)).toBeUndefined()          // nothing to measure against
    let seed = 7
    const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n) }
    for (let i = 0; i < 20000; i++) {
      const budget = 1 + next(10 ** (1 + next(12)))
      const actual = next(budget * 3)
      expect(percentOf(actual, budget), `${actual} of ${budget}`).toBe(Number(BigInt(actual) * 100n / BigInt(budget)))
    }
    // Past the safe integers once multiplied by 100: still exact
    expect(percentOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1)).toBe(100)
  })

  it('draws red only what is bad news', () => {
    const figures = (remaining: number) => ({ budget: 0, actual: 0, remaining })
    expect(remainingIsBad({ kind: 'row', group: 'expense', figures: figures(-1) })).toBe(true)
    expect(remainingIsBad({ kind: 'row', group: 'income', figures: figures(-1) })).toBe(false)
    expect(remainingIsBad({ kind: 'net', group: 'income', figures: figures(-1) })).toBe(true)
    expect(remainingIsBad({ kind: 'total', group: 'expense', figures: figures(0) })).toBe(false)
  })
})
