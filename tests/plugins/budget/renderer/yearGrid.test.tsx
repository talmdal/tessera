// The Year: twelve months and a total for every row, Budget, Actual or Remaining; a line's month typed in becomes that
// month's own amount, marked, and only that month changes; Use the Plan takes it away; the keys; a ledger open
// read-only. The status is worked out by the plugin's own code from lines the fake bridge changes as the service would.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_EVENTS, type BudgetLine, type ChangeLineRequest, type MonthRange, type StatusRequest
} from '@tessera/budget-api'
import BudgetView from '../../../../plugins/budget/src/renderer/BudgetView'
import { yearRenders } from '../../../../plugins/budget/src/renderer/YearGrid'
import { settle } from '../../../helpers/settle'
import { BUDGET, LINES, TOTALS, budgetBridge, computedColour, renderInTheme, statusFor, viewOf } from './fixtures'

const cell = (key: string, column: number) => document.querySelector(`[data-cell="${key}|${column}"]`) as HTMLElement
const texts = (key: string) => Array.from({ length: 14 }, (_, i) => cell(key, i - 1)?.textContent)
const MARCH = 2

/** The view on the Year, over lines the fake service changes as `changeLine` would, and tells the view. */
async function showYear(options: { readOnly?: boolean, lines?: BudgetLine[], refuse?: string } = {}) {
  let lines: BudgetLine[] = structuredClone(options.lines ?? LINES)
  const bridge = budgetBridge({
    [BUDGET_CHANNELS.budgets]: () => viewOf({ period: 'year', readOnly: options.readOnly === true }),
    [BUDGET_CHANNELS.status]: (data: StatusRequest) => ({ ok: true, value: statusFor(data.months, lines, TOTALS, BUDGET, data.byMonth === true) }),
    [BUDGET_CHANNELS.changeLine]: (data: ChangeLineRequest) => {
      if (options.refuse) return { ok: false, error: { code: 'READ_ONLY', message: options.refuse } }
      const change = data.change!
      if (change.apply !== 'only') throw new Error('only a month is changed here')
      lines = lines.map(l => {
        if (l.id !== data.lineId) return l
        const overrides = { ...l.overrides }
        if (change.amount === null) delete overrides[change.month]; else overrides[change.month] = change.amount
        return { ...l, overrides }
      })
      return { ok: true, value: lines.find(l => l.id === data.lineId) }
    }
  })
  const drawn = renderInTheme(<BudgetView />)
  await screen.findByRole('treegrid', { name: 'Household, Year, January to December 2027' }, { timeout: 5000 })
  await settle()
  /** What the plugin does after a line changed: tells the view, which reloads. */
  const told = async () => {
    act(() => bridge.emit(BUDGET_EVENTS.status, { budgetId: BUDGET.id }))
    await settle()
  }
  /** The line deleted elsewhere, as another window or plugin would. */
  const lineGone = async (id: string) => {
    lines = lines.filter(l => l.id !== id)
    await told()
  }
  return { ...bridge, ...drawn, told, lineGone, user: userEvent.setup() }
}

describe('the Year: what it shows', () => {
  it('asks for the budget year month by month, and draws twelve months and a total of each figure', async () => {
    const { calls, user, theme } = await showYear()
    expect(calls(BUDGET_CHANNELS.status).at(-1)).toEqual({ budgetId: BUDGET.id, months: { from: '2027-01', to: '2027-12' }, byMonth: true })
    const heads = within(screen.getByRole('treegrid')).getAllByRole('columnheader').map(h => h.getAttribute('title') ?? h.textContent)
    expect(heads[1]).toBe('January 2027')
    expect(heads.at(-1)).toBe('Total')
    expect(texts('line:l-groceries').slice(1)).toEqual([...Array(12).fill('650.00'), '7,800.00'])
    expect(texts('line:l-insurance').slice(1, 5)).toEqual(['0.00', '0.00', '1,200.00', '0.00'])
    expect(texts('other:expense').slice(1, 3)).toEqual(['—', '—'])
    // Each month's totals, as the plugin gives them
    expect(texts('total:expense').slice(1, 4)).toEqual(['2,300.00', '2,300.00', '3,500.00'])
    expect(cell('total:expense', 12)).toHaveTextContent('28,800.00')
    expect(texts('net').slice(1, 3)).toEqual(['4,900.00', '4,900.00'])

    await user.click(screen.getByRole('button', { name: 'Actual' }))
    expect(texts('line:l-groceries').slice(1, 5)).toEqual(['0.00', '0.00', '598.30', '0.00'])
    await user.click(screen.getByRole('button', { name: 'Remaining' }))
    expect(cell('line:l-food', MARCH)).toHaveTextContent('-113.85')
    expect(cell('line:l-food', MARCH)).toHaveAttribute('data-bad')
    expect(getComputedStyle(cell('line:l-food', MARCH)).color).toBe(computedColour(theme.palette.error.main))
    expect(cell('other:income', MARCH)).not.toHaveAttribute('data-bad')      // more income than planned
    expect(cell('line:l-groceries', MARCH)).not.toHaveAttribute('data-bad')
  })

  it('marks a month with an amount of its own, in Budget only', async () => {
    const lines = LINES.map(l => l.id === 'l-groceries' ? { ...l, overrides: { '2027-03': 90000 } } : l)
    const { user } = await showYear({ lines })
    expect(cell('line:l-groceries', MARCH)).toHaveAttribute('data-own')
    expect(cell('line:l-groceries', MARCH)).toHaveTextContent('•900.00')
    expect(cell('line:l-groceries', 1)).not.toHaveAttribute('data-own')
    await user.click(screen.getByRole('button', { name: 'Actual' }))
    expect(cell('line:l-groceries', MARCH)).not.toHaveAttribute('data-own')
  })
})

describe('the Year: a month of its own', () => {
  it('sets a month\'s own amount from what is typed, and only that month changes', async () => {
    const { user, calls, told } = await showYear()
    const before = texts('line:l-groceries')
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('9')
    const editor = screen.getByRole('textbox', { name: 'Groceries, March 2027' })
    expect(editor).toHaveFocus()
    await user.keyboard('00{Enter}')
    await waitFor(() => expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([{ lineId: 'l-groceries', change: { apply: 'only', month: '2027-03', amount: 90000 } }]))
    await told()
    await waitFor(() => expect(cell('line:l-groceries', MARCH)).toHaveTextContent('•900.00'))
    const after = texts('line:l-groceries')
    expect(after.map((t, i) => t === before[i] ? '=' : t)).toEqual(['=', '=', '=', '•900.00', ...Array(9).fill('='), '8,050.00'])
    expect(cell('line:l-groceries', MARCH)).toHaveFocus()
  })

  it('starts from the amount with F2 or Enter, moves on with Tab, and keeps the plan with Escape', async () => {
    const { user, calls } = await showYear()
    await user.click(cell('line:l-rent', 0))
    await user.keyboard('{F2}')
    expect(screen.getByRole('textbox', { name: 'Rent, January 2027' })).toHaveValue('1500.00')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Rent, January 2027' })).toBeNull()
    expect(cell('line:l-rent', 0)).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Control>}a{/Control}1600{Tab}')
    await waitFor(() => expect(calls(BUDGET_CHANNELS.changeLine).at(-1)).toMatchObject({ change: { month: '2027-01', amount: 160000 } }))
    await waitFor(() => expect(cell('line:l-rent', 1)).toHaveAttribute('aria-selected', 'true'))
  })

  it('shows what is wrong with what was typed, and saves nothing', async () => {
    const { user, calls } = await showYear()
    await user.click(cell('line:l-rent', 0))
    await user.keyboard('9')
    await user.keyboard('x{Enter}')
    const editor = screen.getByRole('textbox', { name: 'Rent, January 2027' })
    expect(editor).toHaveAttribute('aria-invalid', 'true')
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/./)
    await user.keyboard('{Escape}')
    expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([])
  })

  it('uses the plan again with Delete or an emptied cell', async () => {
    const lines = LINES.map(l => l.id === 'l-groceries' ? { ...l, overrides: { '2027-03': 90000, '2027-04': 1000 } } : l)
    const { user, calls, told } = await showYear({ lines })
    const used = () => calls(BUDGET_CHANNELS.changeLine).map(c => [c.change.month, c.change.amount])
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(used()).toEqual([['2027-03', null]]))
    await told()
    await waitFor(() => expect(cell('line:l-groceries', MARCH)).not.toHaveAttribute('data-own'))
    // Delete on a month of the plan does nothing: it doesn't delete the line
    await user.keyboard('{Delete}')
    await user.click(cell('line:l-groceries', 3))
    await user.keyboard('{Enter}{Control>}a{/Control}{Backspace}{Enter}')
    await waitFor(() => expect(used().at(-1)).toEqual(['2027-04', null]))
  })

  it('uses the plan again from the toolbar or the cell\'s menu', async () => {
    const lines = LINES.map(l => l.id === 'l-groceries' ? { ...l, overrides: { '2027-05': 5, '2027-06': 7 } } : l)
    const { user, calls } = await showYear({ lines })
    const used = () => calls(BUDGET_CHANNELS.changeLine).map(c => [c.change.month, c.change.amount])
    await user.click(cell('line:l-groceries', 3))
    expect(screen.getByRole('button', { name: 'Use the Plan' })).toBeDisabled()
    await user.click(cell('line:l-groceries', 4))
    await user.click(screen.getByRole('button', { name: 'Use the Plan' }))
    await waitFor(() => expect(used().at(-1)).toEqual(['2027-05', null]))
    await user.pointer({ keys: '[MouseRight]', target: cell('line:l-groceries', 5) })
    await user.click(await screen.findByRole('menuitem', { name: /Use the Plan for June 2027/ }))
    await waitFor(() => expect(used().at(-1)).toEqual(['2027-06', null]))
  })
})

describe('the Year: when things change under it', () => {
  it('stops typing in a month whose line was deleted elsewhere, and goes on answering clicks and keys', async () => {
    const { user, lineGone, calls } = await showYear()
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('9')
    expect(screen.getByRole('textbox', { name: 'Groceries, March 2027' })).toBeInTheDocument()
    await lineGone('l-groceries')
    expect(screen.queryByRole('textbox', { name: 'Groceries, March 2027' })).toBeNull()
    // Before the fix, the grid went on waiting for that editor: clicks selected nothing, and keys did nothing
    await user.click(cell('line:l-rent', 1))
    expect(cell('line:l-rent', 1)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowRight}')
    expect(cell('line:l-rent', 2)).toHaveAttribute('aria-selected', 'true')
    expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([])
  })

  it('says so when Use the Plan fails from Delete, as it does from the toolbar and the menu', async () => {
    const lines = LINES.map(l => l.id === 'l-groceries' ? { ...l, overrides: { '2027-03': 90000 } } : l)
    const { user } = await showYear({ lines, refuse: 'This ledger is open read-only.' })
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('{Delete}')
    expect(await screen.findByRole('alert')).toHaveTextContent('This ledger is open read-only.')
  })
})

describe('the Year: keys', () => {
  it('moves by cell, opens a row\'s dialog from its name, and lists a month\'s transactions', async () => {
    const { user, executed } = await showYear()
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(cell('line:l-food', 3)).toHaveAttribute('aria-selected', 'true')
    expect(cell('line:l-food', 3)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(cell('line:l-food', -1)).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.editLine, args: [{ id: 'l-food' }] }))
    await user.keyboard('{End}{Control>}{Enter}{/Control}')
    await waitFor(() => expect(executed().at(-1)).toMatchObject({ id: C.transactions, args: [{ months: { from: '2027-01', to: '2027-12' }, period: 'Year, January to December 2027' }] }))
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(executed().at(-1)).toMatchObject({ id: C.transactions, args: [{ months: { from: '2027-03', to: '2027-03' }, period: 'March 2027', label: 'Groceries' }] }))
    // A subtotal's month can't be typed in: Enter adds the category's own line
    await user.click(cell('subtotal:housing', MARCH))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(executed().at(-1)).toEqual({ id: C.newLine, args: [{ target: { kind: 'category', categoryId: 'housing' } }] }))
    // ← on a subtotal's name closes it, → opens it (and the view remembers which, for the budget)
    await user.keyboard('{Home}{ArrowLeft}')
    expect(cell('line:l-rent', 0)).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(cell('line:l-rent', 0)).not.toBeNull()
  })

  it('steps a year with Page Up and Page Down, and makes the month of the cell chosen the month shown', async () => {
    const { user, calls } = await showYear()
    await user.click(cell('line:l-rent', 4))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.select).at(-1)).toEqual({ budgetId: BUDGET.id, month: '2027-05', period: 'year', lineId: 'l-rent' }))
    await user.keyboard('{PageDown}')
    await waitFor(() => expect((calls(BUDGET_CHANNELS.status).at(-1) as StatusRequest).months).toEqual({ from: '2028-01', to: '2028-12' }))
    expect(screen.getByRole('button', { name: 'Next year' })).toBeInTheDocument()
  })

  it('on a ledger open read-only, shows the year and types nothing in', async () => {
    const { user, calls } = await showYear({ readOnly: true })
    await user.click(cell('line:l-rent', 0))
    await user.keyboard('9{Enter}{F2}{Delete}')
    expect(screen.queryByRole('textbox', { name: 'Rent, January 2027' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use the Plan' })).toBeDisabled()
    expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([])
  })
})

describe('the Year: drawing', () => {
  it('redraws the editor, not the rows, for each key typed', async () => {
    const { user } = await showYear()
    await user.click(cell('line:l-groceries', MARCH))
    await user.keyboard('1')
    const rows = yearRenders.rows, editor = yearRenders.editor
    await user.keyboard('23456')
    expect(yearRenders.rows).toBe(rows)
    expect(yearRenders.editor - editor).toBe(5)
  })

  it('is reached from the Month with the period chooser', async () => {
    const user = userEvent.setup()
    const { calls } = budgetBridge()
    renderInTheme(<BudgetView />)
    await screen.findByRole('treegrid', undefined, { timeout: 5000 })
    await user.click(screen.getByRole('combobox', { name: 'Period' }))
    await user.click(await screen.findByRole('option', { name: 'Year' }))
    await screen.findByRole('treegrid', { name: 'Household, Year, January to December 2027' })
    expect(calls(BUDGET_CHANNELS.status).at(-1)).toMatchObject({ months: { from: '2027-01', to: '2027-12' }, byMonth: true })
    // The month shown is the cell selected
    expect(cell('line:l-salary', MARCH)).toHaveAttribute('aria-selected', 'true')
    const months: MonthRange = { from: '2027-01', to: '2027-12' }
    expect(statusFor(months, LINES, TOTALS, BUDGET, true).monthlyTotals).toHaveLength(12)
  })
})
