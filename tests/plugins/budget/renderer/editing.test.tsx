// What the grid redraws (docs/budget-design.md, Phase B0 results, "The grid"): rows are memoised with stable callbacks,
// so moving the selection redraws the two rows it touches, not every row; and a budget of 150 lines draws, in the
// Month and the Year, with no windowing. Typing in the Year's cells redraws only the editor (yearGrid.test.tsx).
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Category } from '@tessera/accounts-api'
import { BUDGET_CHANNELS, monthsOf, type BudgetLine, type MonthRange } from '@tessera/budget-api'
import BudgetView from '../../../../plugins/budget/src/renderer/BudgetView'
import { rowRenders } from '../../../../plugins/budget/src/renderer/StatusGrid'
import { budgetStatus, type CountedTotal } from '../../../../plugins/budget/src/privileged/status'
import { settle } from '../../../helpers/settle'
import { BUDGET, budgetBridge, renderInTheme, viewOf } from './fixtures'

const row = (key: string) => document.querySelector(`[data-grid-row="${key}"]`) as HTMLElement

describe('the budget grid: what it redraws', () => {
  it('redraws only the rows whose selection changed when the arrows move it', async () => {
    const user = userEvent.setup()
    budgetBridge()
    renderInTheme(<BudgetView />)
    await screen.findByRole('treegrid', undefined, { timeout: 5000 })
    await settle()
    await user.click(within(row('line:l-salary')).getByText('Salary'))
    await settle()
    const before = rowRenders.count
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(row('line:l-business')).toHaveAttribute('aria-selected', 'true'))
    await settle()
    expect(rowRenders.count - before).toBe(2)
    const again = rowRenders.count
    await user.keyboard('{ArrowDown}{ArrowDown}')
    await settle()
    expect(rowRenders.count - again).toBe(4)
  })
})

describe('a budget of 150 lines', () => {
  it('draws every line in the Month, with no windowing', async () => {
    const { lines, categories, totals } = big()
    const status = (range: MonthRange, byMonth = false) => budgetStatus({
      budget: BUDGET, lines, categories, accounts: new Map(), totals, months: monthsOf(range), notCounted: [], warnAtPercent: 90, byMonth
    })
    budgetBridge({ [BUDGET_CHANNELS.status]: (data: { months: MonthRange }) => ({ ok: true, value: status(data.months) }) })
    renderInTheme(<BudgetView />)
    await screen.findByRole('treegrid', undefined, { timeout: 5000 })
    await settle()
    expect(document.querySelectorAll('[data-kind="line"]')).toHaveLength(150)
    expect(document.querySelectorAll('[data-kind="subtotal"]')).toHaveLength(15)
  })

  // The Year: 150 lines of twelve months and a total, 2,352 cells, some 5 s in jsdom (the time to draw it in a browser is
  // in the phase's results)
  it('draws every line in the Year', { timeout: 40_000 }, async () => {
    const { lines, categories, totals } = big()
    const status = (range: MonthRange, byMonth = false) => budgetStatus({
      budget: BUDGET, lines, categories, accounts: new Map(), totals, months: monthsOf(range), notCounted: [], warnAtPercent: 90, byMonth
    })
    budgetBridge({
      [BUDGET_CHANNELS.budgets]: () => viewOf({ period: 'year' }),
      [BUDGET_CHANNELS.status]: (data: { months: MonthRange, byMonth?: boolean }) => ({ ok: true, value: status(data.months, data.byMonth) })
    })
    renderInTheme(<BudgetView />)
    await screen.findByRole('treegrid', { name: 'Household, Year, January to December 2027' }, { timeout: 10000 })
    await settle()
    expect(document.querySelectorAll('[data-year-grid] [data-kind="line"]')).toHaveLength(150)
    expect(document.querySelectorAll('[data-year-grid] [data-cell]').length).toBe((150 + 15) * 14 + 2 * 14 + 14)
  })
})

/** 150 lines in 15 groups of 10, each with spending in March. */
function big() {
  const categories: Category[] = Array.from({ length: 15 }, (_, p) => ({ id: `p${p}`, name: `Group ${p}`, kind: 'expense' as const, parentId: null, rev: 1 }))
  const lines: BudgetLine[] = []
  const totals: CountedTotal[] = []
  for (let p = 0; p < 15; p++) for (let c = 0; c < 10; c++) {
    const id = `c${p}-${c}`
    categories.push({ id, name: `Category ${p}.${c}`, kind: 'expense', parentId: `p${p}`, rev: 1 })
    lines.push({ id: `l${id}`, budgetId: BUDGET.id, target: { kind: 'category', categoryId: id }, plans: [{ from: '2027-01', amount: 10000 + c, frequency: 'monthly', due: '2027-01' }], rev: 1 })
    totals.push({ accountId: 'a', month: '2027-03', categoryId: id, transferAccountId: null, inflow: 0, outflow: 9000 + p, count: 1, archived: false })
  }
  return { lines, categories, totals }
}
