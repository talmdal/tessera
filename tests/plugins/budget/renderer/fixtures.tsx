// A budget to draw: the design's Household for March 2027 (docs/budget-design.md, "The budget view"), its status worked
// out by the plugin's own pure code, and a fake bridge that answers the view's requests with it.
import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import type { ReactNode } from 'react'
import type { Category } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, monthsOf,
  type Budget, type BudgetLine, type BudgetStatus, type BudgetsView, type LinePlan, type MonthRange
} from '@tessera/budget-api'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../../../shared/theme/types'
import { createShellTheme } from '../../../../shell/renderer/theme/createShellTheme'
import { budgetStatus, type CountedTotal } from '../../../../plugins/budget/src/privileged/status'
import { createFakeRemote } from '../../../helpers/fakeBridge'

export const EXECUTE = 'shell:commands.execute'

const category = (id: string, name: string, kind: Category['kind'], parentId: string | null = null): Category => ({ id, name, kind, parentId, rev: 1 })

export const CATEGORIES: Category[] = [
  category('salary', 'Salary', 'income'), category('gifts', 'Gifts', 'income'),
  category('food', 'Food', 'expense'), category('groceries', 'Groceries', 'expense', 'food'), category('dining', 'Dining out', 'expense', 'food'),
  category('housing', 'Housing', 'expense'), category('rent', 'Rent', 'expense', 'housing'), category('insurance', 'Home insurance', 'expense', 'housing'),
  category('pets', 'Pets', 'expense')
]

export const BUDGET: Budget = {
  id: 'household', name: 'Household', subLedgerId: 'personal', currency: 'CAD', yearStartMonth: 1, createdAt: '', updatedAt: '', rev: 1
}

const plan = (amount: number, over: Partial<LinePlan> = {}): LinePlan => ({ from: '2027-01', amount, frequency: 'monthly', due: '2027-01', ...over })
const line = (id: string, target: BudgetLine['target'], plans: LinePlan[], over: Partial<BudgetLine> = {}): BudgetLine =>
  ({ id, budgetId: BUDGET.id, target, plans, rev: 1, ...over })

export const LINES: BudgetLine[] = [
  line('l-salary', { kind: 'category', categoryId: 'salary' }, [plan(210000, { frequency: 'twiceAMonth', due: '2027-01-05', secondDay: 19 })]),
  line('l-groceries', { kind: 'category', categoryId: 'groceries' }, [plan(65000)]),
  line('l-food', { kind: 'category', categoryId: 'food' }, [plan(15000)]),
  line('l-rent', { kind: 'category', categoryId: 'rent' }, [plan(150000, { due: '2027-01-01' })]),
  line('l-insurance', { kind: 'category', categoryId: 'insurance' }, [plan(120000, { frequency: 'yearly', due: '2027-03-15' })]),
  line('l-business', { kind: 'transfer', accountId: 'bchq', direction: 'in' }, [plan(300000, { due: '2027-01-25' })])
]

const total = (month: string, categoryId: string | null, inflow: number, outflow: number, transferAccountId: string | null = null): CountedTotal =>
  ({ accountId: 'pchq', month, categoryId, transferAccountId, inflow, outflow, count: 1, archived: false })

/** March 2027's transactions, totalled: the design's figures. */
export const TOTALS: CountedTotal[] = [
  total('2027-03', 'salary', 420000, 0), total('2027-03', 'gifts', 18000, 0),
  total('2027-03', 'groceries', 0, 59830), total('2027-03', 'dining', 0, 26385),
  total('2027-03', 'rent', 0, 150000), total('2027-03', 'insurance', 0, 118700),
  total('2027-03', 'pets', 0, 8620), total('2027-03', null, 0, 4100),
  total('2027-03', null, 300000, 0, 'bchq')
]

/** The status the plugin would give for `range`, with the lines and totals given. */
export function statusFor(range: MonthRange, lines: BudgetLine[] = LINES, totals: CountedTotal[] = TOTALS, budget: Budget = BUDGET, byMonth = false): BudgetStatus {
  return budgetStatus({
    budget, lines, categories: CATEGORIES, accounts: new Map([['bchq', { id: 'bchq', name: 'Business Chequing' }]]), totals,
    months: monthsOf(range), notCounted: [{ accountId: 'usvisa', name: 'US Visa', currency: 'USD' }], warnAtPercent: 90, byMonth
  })
}

export function viewOf(over: Partial<BudgetsView> = {}): BudgetsView {
  return {
    budgets: [{ ...BUDGET, covers: 'Personal' }, { ...BUDGET, id: 'business', name: 'Business', subLedgerId: 'business', covers: 'Business' }],
    shown: BUDGET.id, month: '2027-03', period: 'month', readOnly: false, archive: false, ledgerName: 'Home',
    options: { showBars: true, showEmptyLines: false }, reports: false, ...over
  }
}

/** A fake bridge answering the budget's channels; `answers` adds or replaces any. Commands run are recorded. */
export function budgetBridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  const all: Record<string, (data: any) => unknown> = {
    [BUDGET_CHANNELS.budgets]: () => viewOf(),
    [BUDGET_CHANNELS.status]: (data: { months: MonthRange, byMonth?: boolean }) => ({ ok: true, value: statusFor(data.months, LINES, TOTALS, BUDGET, data.byMonth === true) }),
    [BUDGET_CHANNELS.select]: () => undefined,
    [EXECUTE]: () => undefined,
    ...answers
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = all[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  return { ...remote, calls, executed: () => calls(EXECUTE) as { id: string, args: unknown[] }[] }
}

/** Draws `node` in the shell's theme, light or dark, as the app does. */
export const renderInTheme = (node: ReactNode, mode: 'light' | 'dark' = 'light') => {
  const theme = createShellTheme(DEFAULT_THEME, mode, { fonts: resolveFonts(DEFAULT_FONT_SETTINGS) })
  return { theme, ...render(<ThemeProvider theme={theme}>{node}</ThemeProvider>) }
}

/** A colour as the browser computes it, to compare with what an element was drawn in. */
export function computedColour(colour: string): string {
  const probe = document.createElement('span')
  probe.style.color = colour
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}
