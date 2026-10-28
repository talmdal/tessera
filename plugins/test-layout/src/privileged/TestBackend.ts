// plugins/layout.sample/src/privileged/SampleModel.ts
import { BORDERS, Border } from '@tessera/types'
import { LayoutState } from '../shared'

/** The plugin's state. Lives in the main process; views get snapshots. */
export class PluginCommandHandler {
  private counts!: Record<Border, number>
  private last?: { side: Border, at: number }

  constructor(private readonly now: () => number = Date.now) {
    this.reset()
  }

  ping(side: Border): LayoutState {
    this.counts[side] += 1
    this.last = { side, at: this.now() }
    return this.snapshot()
  }

  reset(): LayoutState {
    this.counts = { top: 0, bottom: 0, left: 0, right: 0 }
    this.last = undefined
    return this.snapshot()
  }

  get total(): number {
    return BORDERS.reduce((sum, border) => sum + this.counts[border], 0)
  }

  /** A structured-cloneable copy, safe to send over IPC. */
  snapshot(): LayoutState {
    return {
      counts: { ...this.counts },
      total: this.total,
      ...(this.last ? { last: { ...this.last } } : {})
    }
  }
}