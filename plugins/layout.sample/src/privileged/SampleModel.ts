// plugins/layout.sample/src/privileged/SampleModel.ts
import { SIDES, SampleState, Side } from '../shared'

/** The plugin's state. Lives in the main process; views get snapshots. */
export class SampleModel {
  private counts!: Record<Side, number>
  private last?: { side: Side, at: number }

  constructor(private readonly now: () => number = Date.now) {
    this.reset()
  }

  ping(side: Side): SampleState {
    this.counts[side] += 1
    this.last = { side, at: this.now() }
    return this.snapshot()
  }

  reset(): SampleState {
    this.counts = { top: 0, bottom: 0, left: 0, right: 0 }
    this.last = undefined
    return this.snapshot()
  }

  get total(): number {
    return SIDES.reduce((sum, side) => sum + this.counts[side], 0)
  }

  /** A structured-cloneable copy, safe to send over IPC. */
  snapshot(): SampleState {
    return {
      counts: { ...this.counts },
      total: this.total,
      ...(this.last ? { last: { ...this.last } } : {})
    }
  }
}
