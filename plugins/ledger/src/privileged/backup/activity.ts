// What the ledger is doing, for the status bar (context key `ledger.activity`). Work that may be quick shows nothing
// for its first half second, so a 200 ms backup doesn't flash; then its text, with the percentage when it is known.
// A result ("Backed up “Home” at 10:14") stays for a minute. See docs/backup-restore-design.md, "Showing progress".

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export const realTimers: Timers = {
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

/** Nothing shows before this: under it, work feels immediate. */
export const SHOW_AFTER_MS = 500
/** A percentage is redrawn at most this often. */
export const REDRAW_EVERY_MS = 250
/** How long a result stays. */
export const RESULT_FOR_MS = 60_000

export interface ActivityHandle {
  /** The fraction done, 0 to 1. */
  progress(done: number): void
  /** Something the user should see at once: "Waiting for another program to release “…”…". */
  note(text: string): void
  /** The work is over: show `result` for a while, or clear the status (a failure is reported elsewhere). */
  done(result?: string): void
}

export class Activity {
  private generation = 0
  private pending: unknown

  constructor(private readonly show: (text: string | undefined) => void, private readonly timers: Timers = realTimers) {}

  /** Starts a piece of work, replacing whatever the status showed. `text` is "Backing up “Home”", without dots. */
  start(text: string): ActivityHandle {
    const generation = ++this.generation
    const current = () => generation === this.generation
    this.cancelPending()
    let visible = false
    let fraction: number | undefined
    let drawnAt = Number.NEGATIVE_INFINITY
    const draw = () => {
      drawnAt = this.timers.now()
      this.show(fraction === undefined ? `${text}…` : `${text}… ${Math.floor(fraction * 100)}%`)
    }
    this.pending = this.timers.setTimeout(() => {
      if (!current()) return
      visible = true
      draw()
    }, SHOW_AFTER_MS)

    return {
      progress: done => {
        fraction = Math.max(0, Math.min(1, done))
        if (current() && visible && this.timers.now() - drawnAt >= REDRAW_EVERY_MS) draw()
      },
      note: note => {
        if (!current()) return
        this.cancelPending()
        visible = true
        this.show(note)
      },
      done: result => {
        if (!current()) return
        this.cancelPending()
        this.show(result)
        if (result === undefined) return
        this.pending = this.timers.setTimeout(() => { if (current()) this.show(undefined) }, RESULT_FOR_MS)
      }
    }
  }

  private cancelPending() {
    if (this.pending !== undefined) this.timers.clearTimeout(this.pending)
    this.pending = undefined
  }
}
