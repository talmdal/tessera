// Fill from History: what each category, and each account transferred with across the scope, added up to over the
// months before the lines would start, as suggested lines. Pure. See docs/budget-design.md, "Filling a budget from
// history".
import { categoryLabel, type Account, type Category } from '@tessera/accounts-api'
import { BUDGET_AMOUNT_MAX, planFor, type BudgetLine, type LineGroup, type LineSuggestion, type LineTarget } from '@tessera/budget-api'
import type { CountedTotal } from './status'

/**
 * `n ÷ d` for whole numbers, rounded up, down or to the nearest (halves up), with integers only: `n − n % d` is an exact
 * multiple of `d`, so its division is exact. The feature's one division (docs/budget-design.md, "Ground rules").
 * `n` at least 0 and `d` above 0, both safe integers.
 */
export function divideRounding(n: number, d: number, mode: 'up' | 'down' | 'nearest'): number {
  const rest = n % d
  const quotient = (n - rest) / d
  if (rest === 0 || mode === 'down') return quotient
  return mode === 'up' || rest * 2 >= d ? quotient + 1 : quotient
}

export interface SuggestInput {
  /** What counts for the budget over the months looked at (`countedTotals`). */
  totals: readonly CountedTotal[]
  categories: readonly Category[]
  accounts: ReadonlyMap<string, Pick<Account, 'id' | 'name'>>
  /** The budget's lines, to say which suggestions already have one. */
  lines: readonly BudgetLine[]
  /** The whole months looked at. */
  months: readonly string[]
  /** 'YYYY-MM': the month the lines would start from. */
  start: string
  /** The step amounts are rounded to, in minor units. */
  step: number
}

interface Seen {
  target: LineTarget
  group: LineGroup
  label: string
  /** Signed as money in (transfers) or by the category's group: by month. */
  byMonth: Map<string, { amount: number, count: number }>
}

/**
 * A suggestion for each category, and each account transferred with across the scope, whose average is above zero:
 * the average of the months, rounded up for expenses and down for income (the careful side); or, for one seen in only
 * one of the months, a yearly line in that month, since it looks like an annual bill. Each category on its own: its
 * nearest line doesn't matter here. Uncategorised transactions suggest nothing. Income first, then the largest.
 */
export function suggestLines(input: SuggestInput): LineSuggestion[] {
  const byId = new Map(input.categories.map(c => [c.id, c]))
  const seen = new Map<string, Seen>()
  const note = (key: string, make: () => Omit<Seen, 'byMonth'>, month: string, amount: number, count: number) => {
    let s = seen.get(key)
    if (!s) seen.set(key, s = { ...make(), byMonth: new Map() })
    const m = s.byMonth.get(month) ?? { amount: 0, count: 0 }
    s.byMonth.set(month, { amount: m.amount + amount, count: m.count + count })
  }
  const months = new Set(input.months)
  for (const t of input.totals) {
    if (!months.has(t.month)) continue
    if (t.transferAccountId !== null) {
      const id = t.transferAccountId
      // Which way the money went is decided over all the months, below; until then, money in is positive
      note(`t:${id}`, () => ({ target: { kind: 'transfer', accountId: id, direction: 'in' }, group: 'income', label: input.accounts.get(id)?.name ?? '(deleted account)' }), t.month, t.inflow - t.outflow, t.count)
      continue
    }
    const category = t.categoryId === null ? undefined : byId.get(t.categoryId)
    if (!category) continue
    const amount = category.kind === 'income' ? t.inflow - t.outflow : t.outflow - t.inflow
    note(`c:${category.id}`, () => ({ target: { kind: 'category', categoryId: category.id }, group: category.kind, label: categoryLabel(input.categories, category.id) ?? category.name }), t.month, amount, t.count)
  }

  const lineFor = (target: LineTarget) => input.lines.find(l => target.kind === 'category'
    ? l.target.kind === 'category' && l.target.categoryId === target.categoryId
    : l.target.kind === 'transfer' && l.target.accountId === target.accountId)
  const suggestions: LineSuggestion[] = []
  for (const s of seen.values()) {
    let { target, group } = s
    let sign = 1
    const net = [...s.byMonth.values()].reduce((n, m) => n + m.amount, 0)
    if (target.kind === 'transfer') {
      if (net === 0) continue
      // More went out than came in: a line of transfers to the account, with the expenses
      if (net < 0) { target = { ...target, direction: 'out' }; group = 'expense'; sign = -1 }
    }
    const total = net * sign
    if (total <= 0) continue
    const round = (amount: number) => divideRounding(amount, input.step, group === 'expense' ? 'up' : 'down') * input.step
    const active = [...s.byMonth].filter(([, m]) => m.count > 0)
    let amount: number, frequency: LineSuggestion['frequency'], due: string
    if (active.length === 1) {
      // Seen in one month only: an annual bill, in that month
      const [month, m] = active[0]
      amount = round(m.amount * sign)
      frequency = 'yearly'
      due = month
    } else {
      amount = divideRounding(total, input.months.length * input.step, group === 'expense' ? 'up' : 'down') * input.step
      frequency = 'monthly'
      due = input.start
    }
    if (amount <= 0 || amount > BUDGET_AMOUNT_MAX) continue
    const existing = lineFor(target)
    suggestions.push({
      target, group, label: s.label, total, average: divideRounding(total, input.months.length, 'nearest'), amount, frequency, due,
      ...(existing && { existingLineId: existing.id }),
      ...(existing && planFor(existing.plans, input.start) && { existingPlan: planFor(existing.plans, input.start) })
    })
  }
  return suggestions.sort((a, b) => (a.group === b.group ? 0 : a.group === 'income' ? -1 : 1) || b.total - a.total || a.label.localeCompare(b.label))
}
