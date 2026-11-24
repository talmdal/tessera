// Keeping the views current (docs/reporting-design.md, "Keeping reports current"). What is offered and saved goes to
// the views at once; figures that may have changed are gathered for `REFRESH_DEBOUNCE_MS`, with the sources they came
// from, so an import of 300 bank lines (or a burst of typing in the register) is one `stale` event. The plugin
// computes nothing here: a view showing a report on one of those sources runs it again if it is on screen, or when it
// is next shown.
import type { Disposable, PluginContext } from '@tessera/types'
import { REFRESH_DEBOUNCE_MS, REPORTS_EVENTS, type ReportsChange, type StaleEvent } from '@tessera/reports-api'
import { local, type ViewState } from './viewState'

export class Refresher implements Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The sources gathered since the last event; null once any change named none (every source). */
  private pending: Set<string> | null = new Set()
  private running: Promise<void> = Promise.resolve()
  private waiting: (() => void)[] = []

  constructor(
    private readonly context: Pick<PluginContext, 'events' | 'logger'>,
    private readonly view: ViewState,
    private readonly delay = REFRESH_DEBOUNCE_MS,
    /** After the catalog may have changed: the menu follows what is offered. */
    private readonly catalogChanged: () => void = () => {}
  ) {}

  /** After the report service's change event. */
  changed(change: ReportsChange): void {
    if (change.catalog) {
      this.catalogChanged()
      this.queue(() => this.view.refresh({ saved: true }))
    }
    if (change.figures) this.stale(change.sources)
  }

  /** Something a definition's `when` reads may have changed: the catalog's `enabled`, if so. */
  enablementChanged(): void {
    this.queue(() => this.view.refresh())
  }

  /** Figures from these sources (every source, with none) may have changed. */
  stale(sources?: readonly string[]): void {
    if (sources === undefined || this.pending === null) this.pending = null
    else for (const s of sources) this.pending.add(s)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const event: StaleEvent = { sources: this.pending === null ? null : [...this.pending].sort() }
      this.pending = new Set()
      // Behind any catalog refresh queued first, so a view learns of a new ledger before its figures go stale
      this.queue(async () => { this.context.events.emit(local(REPORTS_EVENTS.stale), event) })
      this.release()
    }, this.delay)
  }

  /** Resolves once nothing is left to do: the debounce has fired (if set) and every refresh queued has run. For tests. */
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

  /** One refresh at a time, in order: two reading the catalog at once could send the older one last. */
  private queue(work: () => Promise<void>) {
    this.running = this.running.then(work).catch(err => this.context.logger.error('[reports] Could not refresh the report views', err))
  }
}
