// Keeping the views current (docs/budget-design.md, "Keeping the view current"). A budget or line changed by this
// plugin is told at once; actuals changed elsewhere (transactions, categories, accounts, sub-ledgers, an archive) are
// gathered for `STATUS_DEBOUNCE_MS`, so an import of 300 bank lines is one refresh. The plugin computes nothing here:
// a view that is shown reloads its status when told, and one that isn't does nothing.
import type { Disposable, PluginContext } from '@tessera/types'
import { BUDGET_EVENTS, STATUS_DEBOUNCE_MS, type BudgetChange } from '@tessera/budget-api'
import { local, type ViewState } from './viewState'

export class Refresher implements Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> = Promise.resolve()
  /** Who waits for the debounce timer (`idle`). */
  private waiting: (() => void)[] = []

  constructor(
    private readonly context: Pick<PluginContext, 'events' | 'logger'>,
    private readonly view: ViewState,
    private readonly delay = STATUS_DEBOUNCE_MS,
    /** After each refresh: what else follows the budget shown and its actuals (the status bar's warning). */
    private readonly after: () => Promise<void> = async () => {}
  ) {}

  /** After the budget service's change event. */
  changed(change: BudgetChange): void {
    const touched = [...new Set([...change.budgets, ...change.lines])]
    if (change.budgets.length > 0 || change.deleted.length > 0 || change.lines.length > 0) {
      // A budget's name, scope or lines: the list and the keys now, then each budget's status
      this.queue(async () => {
        await this.view.refresh()
        for (const budgetId of touched) this.context.events.emit(local(BUDGET_EVENTS.status), { budgetId })
        await this.after()
      })
    }
    if (change.actuals) this.later()
  }

  /** The ledger opened or closed: everything now. */
  ledgerChanged(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.release()
    this.queue(async () => {
      await this.view.refresh()
      this.context.events.emit(local(BUDGET_EVENTS.status), { budgetId: null })
      await this.after()
    })
  }

  /**
   * The Budget page changed: how the view draws goes to it at once; a new *Warn at* changes every status's warnings, and
   * the status bar's; the status bar switched on or off.
   */
  settingsChanged(changed: readonly string[]): void {
    this.queue(async () => {
      await this.view.refresh()
      if (changed.includes('warnAtPercent')) this.context.events.emit(local(BUDGET_EVENTS.status), { budgetId: null })
      if (changed.includes('warnAtPercent') || changed.includes('statusBar')) await this.after()
    })
  }

  /** Other work that reads what the refreshes read, queued behind them so the two never interleave. */
  run(work: () => Promise<void>): void {
    this.queue(work)
  }

  /** A budget shown by a command: the status bar follows it. */
  shown(): void {
    this.queue(() => this.after())
  }

  /**
   * Resolves once nothing is left to do: the debounce timer has fired (if one was set) and every refresh queued has run,
   * including any queued meanwhile. Tests wait on this rather than on a guess at how long a refresh takes.
   */
  async idle(): Promise<void> {
    for (;;) {
      if (this.timer !== undefined) await new Promise<void>(resolve => this.waiting.push(resolve))
      const running = this.running
      await running
      if (running === this.running && this.timer === undefined) return
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.release()
  }

  private release() {
    for (const resolve of this.waiting.splice(0)) resolve()
  }

  private later() {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      // What covers the budgets (a sub-ledger renamed or moved) may have changed too
      this.queue(async () => {
        await this.view.refresh()
        this.context.events.emit(local(BUDGET_EVENTS.status), { budgetId: null })
        await this.after()
      })
      this.release()
    }, this.delay)
  }

  /** One refresh at a time, in order: two reading the list at once could send the older one last. */
  private queue(work: () => Promise<void>) {
    this.running = this.running.then(work).catch(err => this.context.logger.error('[budget] Could not refresh the budget views', err))
  }
}
