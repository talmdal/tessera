// The `budget.service` service: the budgets of the open ledger, their lines, and how each month stands. Other plugins
// (the accounts home view's widget, reports) read budgets through it, never through the collections.
//
// Methods that fail because of what the user did throw a `BudgetError` (test with `isBudgetError`) whose `code` says
// why and whose `field` names the input at fault.
import type { Event } from '@tessera/types'
import type {
  Budget, BudgetChange, BudgetInput, BudgetLine, BudgetStatus, LineInput, LineSuggestion, MonthRange, PlanChange
} from './model'

export interface WriteOptions {
  /** The write fails with CONFLICT unless the budget or line is still at this revision. */
  expectedRev?: number
}

export interface StatusOptions {
  /** Each row's figures month by month as well (`StatusRow.months`), for the year grid. */
  byMonth?: boolean
  /**
   * An expense line warns once its spending reaches this share of its budget, 1 to 100. Default: the Budget page's
   * *Warn at* (90 until the user changes it), so every plugin warns as the budget view does.
   */
  warnAtPercent?: number
}

export interface SuggestOptions {
  /** How many whole months of history to average, 1 to `STATUS_MONTHS_MAX`. */
  months: number
  /** 'YYYY-MM': the month the lines would start; the history is the months just before it. */
  start: string
  /** The step amounts are rounded to, in minor units: 1000 for 10.00 at two digits. */
  step: number
}

/** The `budget.service` service. Every method fails with NO_LEDGER while no ledger is open. */
export interface BudgetService {
  /** The ledger's budgets, by name. */
  list(): Promise<Budget[]>
  get(id: string): Promise<Budget | undefined>
  create(input: BudgetInput): Promise<Budget>
  /** Changes only the fields given. A new scope or currency changes the budget's actuals, not its lines. */
  update(id: string, patch: Partial<BudgetInput>, options?: WriteOptions): Promise<Budget>
  /** A copy, with every line, plan and month's own amount, under a new name. */
  duplicate(id: string, name: string): Promise<Budget>
  /** Deletes the budget and its lines. What archives kept belongs to the ledger, and stays. */
  delete(id: string): Promise<void>

  /** The budget's lines, in the order they were added. */
  lines(budgetId: string): Promise<BudgetLine[]>
  /** A new line. DUPLICATE_LINE when its category, or its transfer account, has one already. */
  addLine(budgetId: string, input: LineInput): Promise<BudgetLine>
  /** A plan from a month on, or one month's own amount (`PlanChange`). */
  changeLine(lineId: string, change: PlanChange, options?: WriteOptions): Promise<BudgetLine>
  setLineNotes(lineId: string, notes: string | null, options?: WriteOptions): Promise<BudgetLine>
  deleteLine(lineId: string): Promise<void>
  /**
   * Several lines at once, all or none (Fill from History): a new line for each target that has none, and a plan from
   * `plan.from` for each that has.
   */
  fill(budgetId: string, lines: LineInput[]): Promise<BudgetLine[]>

  /** Budget, actual and remaining for every row, and the totals, over at most `STATUS_MONTHS_MAX` months. */
  status(budgetId: string, months: MonthRange, options?: StatusOptions): Promise<BudgetStatus>
  /** Suggestions for Fill from History, from the months before `options.start`. Reads only. */
  suggest(budgetId: string, options: SuggestOptions): Promise<LineSuggestion[]>

  readonly onDidChange: Event<BudgetChange>
}
