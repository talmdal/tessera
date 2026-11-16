// The budget domain: budgets, their lines and plans, and what a budget's status shows. Money is always integer minor
// units, positive in a plan (the sign comes from the line's group); dates are 'YYYY-MM-DD', months 'YYYY-MM'.
// See docs/budget-design.md.

/** How often a plan falls due. See `plan.ts` for exactly which days and months each gives. */
export const FREQUENCIES = [
  'once', 'weekly', 'everyTwoWeeks', 'twiceAMonth', 'monthly',
  'everyTwoMonths', 'quarterly', 'twiceAYear', 'yearly'
] as const

export type Frequency = typeof FREQUENCIES[number]

/** How each frequency is named to the user. */
export const FREQUENCY_LABELS: Readonly<Record<Frequency, string>> = {
  once: 'Once',
  weekly: 'Every week',
  everyTwoWeeks: 'Every two weeks',
  twiceAMonth: 'Twice a month',
  monthly: 'Every month',
  everyTwoMonths: 'Every two months',
  quarterly: 'Every three months',
  twiceAYear: 'Twice a year',
  yearly: 'Every year'
}

/** The frequencies that fall on days rather than in months: they always need a due date with a day. */
export const DAY_BASED_FREQUENCIES: readonly Frequency[] = ['weekly', 'everyTwoWeeks']

/** Income or expenses: where a line, a row or a total belongs. */
export type LineGroup = 'income' | 'expense'

/** A named plan, over the whole ledger or a sub-ledger and everything beneath it. */
export interface Budget {
  id: string
  /** Unique in the ledger, ignoring case. */
  name: string
  /** The accounts it covers: those in this sub-ledger and every sub-ledger beneath it. null: every account in the ledger. */
  subLedgerId: string | null
  /** ISO 4217. Only accounts in this currency count; the status names the others in scope. */
  currency: string
  /** The month its year starts, 1 to 12: what "Year" and "Year to date" mean. 1 (January) for a calendar year. */
  yearStartMonth: number
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}

/** What a line plans: a category, or transfers with one account outside the budget's scope. */
export type LineTarget =
  | { kind: 'category', categoryId: string }
  /** 'in': transfers from the account into the scope (income). 'out': from the scope to the account (expenses). */
  | { kind: 'transfer', accountId: string, direction: 'in' | 'out' }

/** How much, how often and when, from a month until the line's next plan (or for good). */
export interface LinePlan {
  /** 'YYYY-MM': the first month this plan applies to. */
  from: string
  /** Minor units, zero or more: each time it falls due. 0 stops the line from `from` without deleting it. */
  amount: number
  frequency: Frequency
  /**
   * When it first falls due. 'YYYY-MM-DD': on that day, and for the month-based frequencies on the same day of each
   * month it falls in (the month's last day, when the month is shorter). 'YYYY-MM': no particular day, for the
   * month-based frequencies only. Weekly and fortnightly plans always have a day. It may be before `from`, to keep a
   * cycle going across a change.
   */
  due: string
  /**
   * Twice a month: the second day, 1 to 31 (the month's last day when shorter). Default: the other half of the month,
   * 15 days after the first when that is the 15th or before, else 15 days before (the 20th gives the 5th).
   */
  secondDay?: number
}

export interface BudgetLine {
  id: string
  budgetId: string
  target: LineTarget
  /** At least one, in order of `from`, no two with the same month. Each runs until the next. */
  plans: LinePlan[]
  /** 'YYYY-MM' → minor units: that month's amount, instead of what the plans give. */
  overrides?: Record<string, number>
  notes?: string
  rev: number
}

/** What the view shows: one month, the budget year up to a month, or the whole budget year. */
export type BudgetPeriod = 'month' | 'yearToDate' | 'year'

/** Whole months, 'YYYY-MM', inclusive. */
export interface MonthRange {
  from: string
  to: string
}

/** What a form sends to create a budget, or (as a patch) to change one. */
export interface BudgetInput {
  name: string
  subLedgerId: string | null
  currency: string
  yearStartMonth: number
  notes?: string
}

/** A new line: what it plans, and its first plan (from `plan.from`). */
export interface LineInput {
  target: LineTarget
  plan: LinePlan
  notes?: string
}

/** A change to a line's amount, frequency or due date. */
export type PlanChange =
  /** A plan from `plan.from` on, replacing one from the same month; with `replaceLater`, the plans after it go too. */
  | { apply: 'from', plan: LinePlan, replaceLater?: boolean }
  /** One month's own amount; null removes it, so the plans apply again. */
  | { apply: 'only', month: string, amount: number | null }

export interface Figures {
  budget: number
  actual: number
  /**
   * budget − actual. Expenses: negative when over budget. Income: what is still to come (negative when more came in
   * than planned). The net: actual net less budget net, negative when behind the plan.
   */
  remaining: number
}

export type StatusRowKind =
  /** A line whose category has no lined category beneath it, or (with `parentLine`) a parent's own line. */
  | 'line'
  /** A category with lines beneath it: their sum (and its own line's, if it has one). Not a line itself. */
  | 'subtotal'
  /** A parent category's own line, drawn under its subtotal as "Food (other)". */
  | 'parentLine'
  /** Transfers with an account outside the scope. */
  | 'transferLine'
  /** Categories with no line, theirs or a parent's: "Other income", "Other expenses". */
  | 'other'
  /** Transfers across the scope with no line: "Other transfers in", "Other transfers out". */
  | 'otherTransfers'
  /** Neither a category nor a transfer: money in with the income, money out with the expenses. */
  | 'uncategorised'
  /** A line whose category no longer exists. */
  | 'deletedCategory'
  /** A transfer line whose account no longer exists. */
  | 'deletedAccount'

/** One entry of an `other` or `otherTransfers` row: a category, or another account, and what it adds. */
export interface BreakdownEntry {
  /** The category's or the account's id. */
  id: string
  /** 'Food : Dining out', or the account's name. */
  label: string
  actual: number
}

export interface StatusRow {
  kind: StatusRowKind
  group: LineGroup
  /** Indentation, from the category tree. */
  depth: number
  label: string
  categoryId?: string
  /** Transfer lines. */
  accountId?: string
  lineId?: string
  figures: Figures
  /** For a status of one month: the days of it the line falls due (none for no particular day). */
  due?: number[]
  /** Each month's figures, in `BudgetStatus.months` order: for the year grid (`byMonth`). */
  months?: Figures[]
  /**
   * For expense lines and subtotals: spending has reached the warning share of the budget (`near`), or passed the
   * budget (`over`), a budget of 0 included.
   */
  warning?: 'near' | 'over'
  /** For `other` and `otherTransfers` rows: each category, or account, they gather, largest first. */
  breakdown?: BreakdownEntry[]
  /** For a line: the months of the status that have an amount of their own (an override), in order; omitted when none. */
  ownMonths?: string[]
}

/** Income, expenses and the net: what the rows that aren't subtotals add up to. */
export interface StatusTotals {
  income: Figures
  expenses: Figures
  net: Figures
}

export interface BudgetStatus {
  budget: Budget
  months: string[]
  /**
   * In display order: income, then expenses; in each, the category tree (subtotals before what they sum), lines of
   * deleted categories, transfer lines, then Other, Other transfers and Uncategorised. Subtotals repeat what their
   * children hold; every other row is counted once in `totals`.
   */
  rows: StatusRow[]
  totals: StatusTotals
  /** Each month's totals, in `months` order (`byMonth`): for the year grid's total rows. */
  monthlyTotals?: StatusTotals[]
  /** Accounts in scope left out because they are in another currency, by name. */
  notCounted: { accountId: string, name: string, currency: string }[]
  /** How much of each row's actual comes from archived totals, by row index; omitted when none does. */
  archived?: Record<number, number>
}

/** One suggestion in Fill from History. */
export interface LineSuggestion {
  target: LineTarget
  group: LineGroup
  /** 'Food : Groceries', or the account's name. */
  label: string
  /** What it added up to over the months looked at (spending for expenses, income for income). */
  total: number
  /** `total` over the months, to the nearest minor unit: shown, never saved. */
  average: number
  /** What the line would plan: rounded up for expenses, down for income, from `total` with integers only. */
  amount: number
  frequency: Frequency
  /** 'YYYY-MM': history is totalled by month, so it has no particular day. */
  due: string
  /** The line this already has in the budget, if any: unticked at first. */
  existingLineId?: string
  /** That line's plan for the month the lines would start, if it has one then: what Fill from History shows beside it. */
  existingPlan?: LinePlan
}

/** What a committed change touched. */
export interface BudgetChange {
  /** Budgets created, changed or deleted. */
  budgets: string[]
  /** Budgets deleted. */
  deleted: string[]
  /** Budgets whose lines changed. */
  lines: string[]
  /** Transactions, categories, accounts, sub-ledgers, an archive, or the open ledger changed what actuals show. */
  actuals: boolean
}
