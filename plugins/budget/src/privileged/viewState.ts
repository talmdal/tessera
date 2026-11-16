// What the budget view shows: which budget (remembered per ledger), the month and period, and the line selected. Menu
// clicks pass no arguments, so commands act on this; it is published as context keys, so menu items grey out to
// match, and as the `budgets.changed` event, so the view and the Budgets tab follow.
import type { PluginContext } from '@tessera/types'
import { isLedgerError, type LedgerSession } from '@tessera/ledger-api'
import { todayIso } from '@tessera/accounts-api'
import {
  BUDGET_CONTEXT_KEYS as K, BUDGET_EVENTS, BUDGET_PLUGIN_ID, isBudgetError, isMonth,
  type Budget, type BudgetPeriod, type BudgetsView, type BudgetSummary, type ViewOptions, type ViewReport
} from '@tessera/budget-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'

/** `events.emit` adds the plugin's prefix itself. */
export const local = (event: string) => event.slice(`${BUDGET_PLUGIN_ID}:`.length)

/** Key in `context.state`: `{ [ledger id, or path]: budget id }`, the budget shown last in each ledger. */
export const SHOWN_KEY = 'shown'

/** How many ledgers' budget shown last are remembered: the most recently used, so the map can't grow for ever. */
export const SHOWN_KEPT = 50

/** No ledger is open, or it closed while being read: said by the budget's own errors or by the ledger's. */
const isNoLedger = (err: unknown) => (isBudgetError(err) || isLedgerError(err)) && err.code === 'NO_LEDGER'

/** What a budget covers, for people. */
export function coversLabel(budget: Pick<Budget, 'subLedgerId'>, subLedgers: readonly { id: string, parentId: string | null, name: string }[]): string {
  if (budget.subLedgerId === null) return 'The whole ledger'
  const sub = subLedgers.find(s => s.id === budget.subLedgerId)
  if (!sub) return '(a deleted sub-ledger)'
  return subLedgers.some(s => s.parentId === sub.id) ? `${sub.name} and its sub-ledgers` : sub.name
}

export class ViewState {
  private shown: string | null = null
  private month: string
  private period: BudgetPeriod = 'month'
  private lineId: string | undefined
  /** The ledger the state belongs to: a new one starts on the current month, with its own remembered budget. */
  private ledgerKey: string | undefined
  /** What was last sent, so an unchanged view isn't sent again (every transaction refreshes it). */
  private sent: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events' | 'state' | 'logger'>,
    private readonly service: BudgetServiceImpl,
    private readonly session: LedgerSession,
    private readonly today: () => string = todayIso,
    private readonly options: () => ViewOptions = () => ({ showBars: true, showEmptyLines: false })
  ) {
    this.month = today().slice(0, 7)
  }

  /** The budget shown (null when there is none), and the line selected in it. */
  get(): { shown: string | null, month: string, period: BudgetPeriod, lineId?: string } {
    return { shown: this.shown, month: this.month, period: this.period, ...(this.lineId !== undefined && { lineId: this.lineId }) }
  }

  /** The budgets and which one the view shows; null while no ledger is open. */
  async view(): Promise<BudgetsView | null> {
    const ledger = this.session.current
    if (!ledger) return null
    try {
      const [budgets, tree] = await Promise.all([this.service.list(), this.session.tree()])
      return {
        budgets: budgets.map((b): BudgetSummary => ({ ...b, covers: coversLabel(b, tree.subLedgers) })),
        shown: this.shown, month: this.month, period: this.period, readOnly: ledger.readOnly, archive: ledger.archive !== undefined,
        ledgerName: ledger.name, options: this.options()
      }
    } catch (err) {
      if (isNoLedger(err)) return null
      throw err
    }
  }

  /** Called once a command has shown another budget (the status bar follows the budget shown). */
  onShown: () => void = () => {}

  /** Shows a budget in the view, remembering it for this ledger. */
  async show(id: string): Promise<void> {
    const changed = id !== this.shown
    if (changed) this.lineId = undefined
    this.shown = id
    await this.remember()
    await this.refresh()
    if (changed) this.onShown()
  }

  /** The view says what it shows. A report for a budget no longer shown is late, and ignored. */
  async report(report: ViewReport): Promise<void> {
    if (report.budgetId !== this.shown) return
    if (isMonth(report.month)) this.month = report.month
    if (report.period === 'month' || report.period === 'yearToDate' || report.period === 'year') this.period = report.period
    this.lineId = typeof report.lineId === 'string' && report.lineId !== '' ? report.lineId : undefined
    this.publishKeys(true)
  }

  /**
   * After anything changed: a new ledger starts over (its remembered budget, this month); a budget shown that is gone
   * gives way to the first; a line selected that is gone is unselected. Sends the view if it changed.
   */
  async refresh(): Promise<void> {
    const ledger = this.session.current
    const key = ledger ? ledger.id ?? ledger.path : undefined
    if (key !== this.ledgerKey) {
      this.ledgerKey = key
      this.month = this.today().slice(0, 7)
      this.period = 'month'
      this.lineId = undefined
      this.shown = key === undefined ? null : await this.remembered(key)
    }
    let budgets: Budget[] = []
    if (ledger) {
      try {
        budgets = await this.service.list()
      } catch (err) {
        if (!isNoLedger(err)) throw err
      }
    }
    if (!budgets.some(b => b.id === this.shown)) {
      this.shown = budgets[0]?.id ?? null
      this.lineId = undefined
    }
    if (this.lineId !== undefined && this.shown !== null) {
      const lines = await this.service.lines(this.shown).catch(() => [])
      if (!lines.some(l => l.id === this.lineId)) this.lineId = undefined
    }
    this.context.contextKeys.set(K.hasBudgets, ledger !== undefined && budgets.length > 0)
    this.publishKeys(ledger !== undefined)
    const view = await this.view()
    const text = JSON.stringify(view)
    if (text !== this.sent) {
      this.sent = text
      this.context.events.emit(local(BUDGET_EVENTS.budgets), view)
    }
  }

  private publishKeys(open: boolean) {
    this.context.contextKeys.set(K.shown, open && this.shown !== null ? this.shown : undefined)
    this.context.contextKeys.set(K.lineSelected, open && this.shown !== null ? this.lineId : undefined)
  }

  private async remembered(ledgerKey: string): Promise<string | null> {
    try {
      const all = await this.context.state.get<Record<string, string>>(SHOWN_KEY)
      const id = all?.[ledgerKey]
      return typeof id === 'string' ? id : null
    } catch (err) {
      this.context.logger.warn(`[budget] Could not read the budget shown last: ${String((err as Error)?.message ?? err)}`)
      return null
    }
  }

  private async remember() {
    // An archive file shares its ledger's id, and isn't that ledger: its budget shown isn't the ledger's to remember
    const ledger = this.session.current
    if (!ledger || this.shown === null || ledger.archive !== undefined) return
    try {
      // Most recently used last: delete and add again, then let the oldest go beyond SHOWN_KEPT
      const key = ledger.id ?? ledger.path
      const all = { ...(await this.context.state.get<Record<string, string>>(SHOWN_KEY)) }
      delete all[key]
      all[key] = this.shown
      const keys = Object.keys(all)
      for (const old of keys.slice(0, Math.max(0, keys.length - SHOWN_KEPT))) delete all[old]
      await this.context.state.set(SHOWN_KEY, all)
    } catch (err) {
      this.context.logger.warn(`[budget] Could not remember the budget shown: ${String((err as Error)?.message ?? err)}`)
    }
  }
}
