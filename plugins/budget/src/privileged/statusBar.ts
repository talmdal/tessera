// A gentle warning in the status bar: "Budget: 2 lines over" while the budget shown has expense lines over their budget
// in the current month, with which ones in its tooltip; clicking it shows the budget. Published as context keys, which
// the status item reads (docs/budget-design.md, "The Budget menu, commands and context keys").
import type { PluginContext } from '@tessera/types'
import { formatAmount, todayIso } from '@tessera/accounts-api'
import { BUDGET_CONTEXT_KEYS as K, type BudgetSettings, type BudgetStatus } from '@tessera/budget-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'
import type { ViewState } from './viewState'

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthName = (month: string) => monthFormat.format(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)))

/** Rows that are lines (not subtotals, Other or Uncategorised) of the expenses, over their budget. */
const OVER_KINDS = new Set(['line', 'parentLine', 'transferLine', 'deletedCategory', 'deletedAccount'])

/** What the status item says for a month's status, or nothing when no expense line is over. */
export function overBudget(status: BudgetStatus): { text: string, detail: string } | undefined {
  const over = status.rows.filter(r => r.group === 'expense' && OVER_KINDS.has(r.kind) && r.warning === 'over')
  if (over.length === 0) return undefined
  const { budget } = status
  const by = over
    .map(r => ({ label: r.label, over: r.figures.actual - r.figures.budget }))
    .sort((a, b) => b.over - a.over || a.label.localeCompare(b.label))
  return {
    text: `Budget: ${over.length === 1 ? '1 line' : `${over.length} lines`} over`,
    detail: `${budget.name}, ${monthName(status.months[0])}: ${by.map(r => `${r.label} ${formatAmount(r.over, budget.currency)} over`).join('; ')}`
  }
}

/** How often the month is checked, so the warning moves on to a new month with no change to prompt it. */
export const MONTH_CHECK_MS = 60_000

export class StatusBar {
  /** The month the warning was last worked out for. */
  private month: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'logger'>,
    private readonly service: BudgetServiceImpl,
    private readonly view: ViewState,
    private readonly settings: () => BudgetSettings,
    private readonly today: () => string = todayIso
  ) {}

  /**
   * When a new month has begun since the warning was worked out (the app left open over the end of a month), works it
   * out again; else does nothing. Cheap: run every `MONTH_CHECK_MS`.
   */
  async checkMonth(): Promise<void> {
    if (this.month !== undefined && this.today().slice(0, 7) !== this.month) await this.refresh()
  }

  /** Works out this month's lines over budget in the budget shown, or clears the keys. Never throws. */
  async refresh(): Promise<void> {
    const { shown } = this.view.get()
    let said: ReturnType<typeof overBudget>
    const month = this.today().slice(0, 7)
    this.month = month
    if (shown !== null && this.settings().statusBar) {
      try {
        said = overBudget(await this.service.status(shown, { from: month, to: month }))
      } catch (err) {
        // A ledger closing as it was worked out, a budget just deleted: nothing to say
        this.context.logger.warn(`[budget] Could not work out the lines over budget: ${String((err as Error)?.message ?? err)}`)
      }
    }
    this.context.contextKeys.set(K.statusText, said?.text)
    this.context.contextKeys.set(K.statusDetail, said?.detail)
  }
}
