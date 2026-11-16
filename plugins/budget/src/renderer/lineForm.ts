// The Budget Line dialog's form: text as typed, turned into a plan (or the problems that stop it being one), and the
// preview of the budget year it lands in, worked out with the same functions the service uses (`plan.ts`).
import { amountToInput, parseAmount } from '@tessera/accounts-api'
import {
  BUDGET_AMOUNT_MAX, DAY_BASED_FREQUENCIES, applyPlanChange, budgetYear, defaultSecondDay, dueDates, isDate, isMonth, monthsOf, planFor,
  planProblem, plannedAmount,
  type BudgetLine, type Frequency, type LineDialogInput, type LinePlan, type PlanChange, type TargetChoice
} from '@tessera/budget-api'

export type LineField = 'target' | 'amount' | 'frequency' | 'due' | 'secondDay' | 'from' | 'notes'

export interface LineForm {
  target: TargetChoice | null
  amount: string
  frequency: Frequency
  /** No particular day: `due` is a month ('YYYY-MM'); else a date. */
  noDay: boolean
  due: string
  /** Twice a month: the second day, as typed; empty for the other half of the month. */
  secondDay: string
  /** Editing: a plan from `from` on, or the month shown only. */
  apply: 'from' | 'only'
  from: string
  /** Editing: the plans after `from` go too. */
  replaceLater: boolean
  notes: string
}

/** The plan that applies to the month (or the first, for a month before it), for an edit to start from. */
export function basePlan(line: Pick<BudgetLine, 'plans'>, month: string): LinePlan {
  return planFor(line.plans, month) ?? line.plans[0]
}

export function initialForm(input: LineDialogInput): LineForm {
  const { line, month, budget } = input
  if (!line) {
    const target = input.target && input.choices?.find(c => c.target === input.target || JSON.stringify(c.target) === JSON.stringify(input.target))
    return {
      target: target ?? null, amount: '', frequency: 'monthly', noDay: true, due: month, secondDay: '',
      apply: 'from', from: month, replaceLater: false, notes: ''
    }
  }
  const plan = basePlan(line, month)
  const own = line.overrides?.[month]
  return {
    target: null,
    amount: amountToInput(own ?? plan.amount, budget.currency),
    frequency: plan.frequency, noDay: plan.due.length === 7, due: plan.due,
    secondDay: plan.secondDay === undefined ? '' : String(plan.secondDay),
    apply: own !== undefined ? 'only' : 'from', from: month, replaceLater: false, notes: line.notes ?? ''
  }
}

/** Switching *No particular day* keeps the month: a date becomes its month, a month its first day. */
export function withNoDay(form: LineForm, noDay: boolean): LineForm {
  if (noDay === form.noDay) return form
  const due = noDay ? form.due.slice(0, 7) : isMonth(form.due) ? `${form.due}-01` : form.due
  return { ...form, noDay, due }
}

/** Day-based frequencies always have a day. */
export const needsDay = (frequency: Frequency) => DAY_BASED_FREQUENCIES.includes(frequency)

export interface Checked {
  /** The amount in minor units, when it parses. */
  amount?: number
  /** The plan the form describes, from `from`. */
  plan?: LinePlan
  problems: Partial<Record<LineField, string>>
}

/** The form as a plan, checked as the service checks it (`planProblem`), with problems on the fields that show them. */
export function checkForm(form: LineForm, currency: string, options: { needsTarget: boolean }): Checked {
  const problems: Partial<Record<LineField, string>> = {}
  if (options.needsTarget && !form.target) problems.target = 'Choose what the line is for.'
  let amount: number | undefined
  const parsed = parseAmount(form.amount, currency)
  if (!parsed.ok) problems.amount = parsed.message
  else if (parsed.value < 0) problems.amount = 'Enter an amount of zero or more.'
  else if (parsed.value > BUDGET_AMOUNT_MAX) problems.amount = 'That amount is too large for a budget.'
  else amount = parsed.value

  const noDay = form.noDay && !needsDay(form.frequency)
  if (form.noDay && needsDay(form.frequency)) problems.due = 'A weekly or fortnightly plan needs the date it is first due.'
  else if (noDay ? !isMonth(form.due) : !isDate(form.due)) problems.due = noDay ? 'Enter the month it is first due.' : 'Enter the date it is first due.'

  let secondDay: number | undefined
  if (form.frequency === 'twiceAMonth' && form.secondDay.trim() !== '') {
    const day = Number(form.secondDay.trim())
    if (!Number.isInteger(day) || day < 1 || day > 31) problems.secondDay = 'Choose a day from 1 to 31.'
    else secondDay = day
  }
  if (!isMonth(form.from)) problems.from = 'Choose the month it applies from.'
  if (Object.keys(problems).length > 0 || amount === undefined) return { ...(amount !== undefined && { amount }), problems }

  const plan: LinePlan = { from: form.from, amount, frequency: form.frequency, due: form.due, ...(secondDay !== undefined && { secondDay }) }
  const problem = planProblem(plan)
  if (problem) return { amount, problems: { [problem.field]: problem.message } }
  return { amount, plan, problems }
}

/** Whether the plan differs from the one it started from, in what a plan is (not its month). */
export function planChanged(plan: LinePlan, from: LinePlan): boolean {
  return plan.amount !== from.amount || plan.frequency !== from.frequency || plan.due !== from.due || plan.secondDay !== from.secondDay
}

/** Only the amount can apply to a single month: the frequency and due date are the plan's. */
export function scheduleChanged(plan: LinePlan, from: LinePlan): boolean {
  return plan.frequency !== from.frequency || plan.due !== from.due || plan.secondDay !== from.secondDay
}

/** The change an edit sends, as the service applies it. */
export function changeOf(form: LineForm, plan: LinePlan, month: string): PlanChange {
  return form.apply === 'only'
    ? { apply: 'only', month, amount: plan.amount }
    : { apply: 'from', plan, ...(form.replaceLater && { replaceLater: true }) }
}

/** The line as it would be after the change: `applyPlanChange`, as the service applies it; a new line's first plan. */
export function lineAfter(line: Pick<BudgetLine, 'plans' | 'overrides'> | undefined, change: PlanChange): Pick<BudgetLine, 'plans' | 'overrides'> {
  if (!line) return { plans: change.apply === 'from' ? [change.plan] : [] }
  return applyPlanChange(line, change)
}

export interface PreviewMonth {
  month: string
  amount: number
  /** The dates it falls due ('YYYY-MM-DD'); none for no particular day, or a month with its own amount. */
  due: string[]
  /** The month has its own amount. */
  own: boolean
}

/** Each month of the budget year `month` is in, as the line would plan it. */
export function preview(line: Pick<BudgetLine, 'plans' | 'overrides'>, month: string, yearStartMonth: number): { months: PreviewMonth[], total: number } {
  const months = monthsOf(budgetYear(month, yearStartMonth)).map((m): PreviewMonth => {
    const own = line.overrides?.[m] !== undefined
    const plan = planFor(line.plans, m)
    return { month: m, amount: plannedAmount(line, m), due: own || !plan ? [] : dueDates(plan, m), own }
  })
  return { months, total: months.reduce((sum, m) => sum + m.amount, 0) }
}

/** Later plans than `from`, which a change from `from` leaves in place unless they go too. */
export const laterPlans = (line: Pick<BudgetLine, 'plans'> | undefined, from: string) => line?.plans.filter(p => p.from > from) ?? []

/** The second day a twice-a-month plan falls due when none is given, for the field's placeholder. */
export function secondDayHint(form: LineForm): string {
  if (form.noDay || !isDate(form.due)) return 'the other half of the month'
  return `the ${ordinal(defaultSecondDay(Number(form.due.slice(8, 10))))}`
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
